import { FsError } from '@deepseek-ai/dsh-fs';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { SubprocessExecutableNotFoundError, } from '@deepseek-ai/dsh-subprocess';
import { createRemoteFileSystemAdapter } from './fs.js';
import { HelperRemoteFileSystem } from './helper-fs.js';
import { parseSshUri } from './types.js';
function isSshPath(value) {
    return typeof value === 'string' && value.startsWith('ssh://');
}
function isSshTarget(value) {
    if (!value || typeof value !== 'object')
        return false;
    return isSshPath(String(value.targetKey ?? ''));
}
/**
 * Add exact SSH URI routing to DSH's filesystem service. Local paths always
 * call the original provider; only direct SSH URIs and paths beneath a
 * persisted remote Workspace anchor use SFTP.
 */
export function installRemoteFileSystemRouter(fs, connections, resolveRemotePath, helpers) {
    const remote = helpers === undefined
        ? createRemoteFileSystemAdapter(connections)
        : new HelperRemoteFileSystem(helpers, resolveRemotePath);
    const originals = new Map();
    const remember = (name) => {
        const original = fs[name];
        if (typeof original !== 'function')
            throw new Error(`ctx.fs.${name} is unavailable`);
        originals.set(name, original);
        return original;
    };
    const asRemotePath = (path) => {
        if (path === undefined)
            return undefined;
        return isSshPath(path) ? path : resolveRemotePath(path);
    };
    const checkedRemoteWriteTarget = async (target, policy) => {
        const fallbackMode = fs.sandboxMode;
        const mode = policy?.mode ?? fallbackMode;
        if (mode === 'read-only') {
            throw new FsError(`cannot write "${target.displayPath}": remote file access denied under read-only mode`, 'FS_SANDBOX_DENIED');
        }
        if (mode === 'danger-full-access' || mode === undefined)
            return target;
        if (mode !== 'workspace-write' || policy === undefined) {
            throw new FsError(`cannot write "${target.displayPath}": missing remote workspace policy`, 'FS_SANDBOX_DENIED');
        }
        const remoteRoot = asRemotePath(policy.workspaceRoot);
        if (remoteRoot === undefined) {
            throw new FsError(`cannot write "${target.displayPath}": workspace root is not mapped to this SSH host`, 'FS_SANDBOX_DENIED');
        }
        // Re-canonicalize both identities immediately before mutation. This is the
        // remote equivalent of dsh-fs-sandbox's checkedTarget critical edge.
        const [fresh, root] = await Promise.all([
            remote.resolve(String(target.targetKey)),
            remote.resolve(remoteRoot),
        ]);
        if (!remote.contains(root, fresh)) {
            throw new FsError(`cannot write "${target.displayPath}": remote file access denied outside workspace`, 'FS_SANDBOX_DENIED');
        }
        return fresh;
    };
    const originalResolve = remember('resolve');
    fs.resolve = (path, opts) => {
        const remoteCwd = asRemotePath(opts?.cwd);
        const remotePath = asRemotePath(path);
        if (remoteCwd !== undefined) {
            return remote.resolve(remotePath ?? path, { ...opts, cwd: remoteCwd });
        }
        if (remotePath !== undefined)
            return remote.resolve(remotePath, opts);
        return originalResolve.call(fs, path, opts);
    };
    const originalLstat = remember('lstat');
    fs.lstat = (path, opts, signal) => {
        const remoteCwd = asRemotePath(opts?.cwd);
        const remotePath = asRemotePath(path);
        if (remoteCwd !== undefined) {
            return remote.lstat(remotePath ?? path, { ...opts, cwd: remoteCwd }, signal);
        }
        if (remotePath !== undefined)
            return remote.lstat(remotePath, opts, signal);
        return originalLstat.call(fs, path, opts, signal);
    };
    // DSH 0.1.2 adds this optional host→execution-world visibility seam. Keep
    // rc.2 compatibility while mapping persisted anchors when the newer method
    // exists, so an upgrade does not reinterpret an anchor as a local path.
    const processPathFromHostPath = fs.processPathFromHostPath;
    if (typeof processPathFromHostPath === 'function') {
        originals.set('processPathFromHostPath', processPathFromHostPath);
        fs.processPathFromHostPath = (hostPath) => {
            const remotePath = resolveRemotePath(hostPath);
            return remotePath === undefined
                ? processPathFromHostPath.call(fs, hostPath)
                : parseSshUri(remotePath).path;
        };
    }
    for (const name of [
        'processPath',
        'fileUrl',
        'stat',
        'readText',
        'streamText',
        'readBytes',
        'listDir',
    ]) {
        const original = remember(name);
        fs[name] = (...args) => isSshTarget(args[0])
            ? remote[name](...args)
            : original.call(fs, ...args);
    }
    // DSH 0.2.0 adds readByteRange for ranged file reads (e.g. workspace file
    // previews). Intercept it the same way when the host provides it; older DSH
    // versions and test mocks without it are unaffected.
    const originalReadByteRange = fs.readByteRange;
    if (typeof originalReadByteRange === 'function') {
        originals.set('readByteRange', originalReadByteRange);
        fs.readByteRange = (...args) => isSshTarget(args[0])
            ? remote.readByteRange(...args)
            : originalReadByteRange.call(fs, ...args);
    }
    const originalWriteText = remember('writeText');
    fs.writeText = async (target, content, expected, signal, sandboxPolicy) => isSshTarget(target)
        ? remote.writeText(await checkedRemoteWriteTarget(target, sandboxPolicy), content, expected, signal, sandboxPolicy)
        : originalWriteText.call(fs, target, content, expected, signal, sandboxPolicy);
    const originalEditText = remember('editText');
    fs.editText = async (target, edit, expected, signal, sandboxPolicy) => isSshTarget(target)
        ? remote.editText(await checkedRemoteWriteTarget(target, sandboxPolicy), edit, expected, signal, sandboxPolicy)
        : originalEditText.call(fs, target, edit, expected, signal, sandboxPolicy);
    const originalContains = remember('contains');
    fs.contains = (parent, child) => {
        const parentRemote = isSshTarget(parent);
        const childRemote = isSshTarget(child);
        if (parentRemote !== childRemote)
            return false;
        return parentRemote
            ? remote.contains(parent, child)
            : originalContains.call(fs, parent, child);
    };
    return () => {
        for (const [name, original] of originals) {
            fs[name] = original;
        }
    };
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
function sameRemote(left, right) {
    return left.host === right.host && left.port === right.port && left.user === right.user;
}
function remoteArgv(cwd, argv, resolveRemotePath) {
    const executable = argv[0];
    if (executable === undefined)
        return argv;
    const normalized = executable.replaceAll('\\', '/');
    if (!/(?:^|\/)@vscode\/ripgrep(?:-[a-z0-9-]+)?\/bin\/rg(?:\.exe)?$/u.test(normalized)) {
        return argv;
    }
    const rewritten = ['rg', ...argv.slice(1)];
    const separator = rewritten.indexOf('--');
    // DSH's glob/grep templates use long flags (values in --flag=value form)
    // followed by optional roots behind `--`. Limit path rewriting to those
    // templates: arbitrary rg invocations may put a PATTERN behind `--`, and
    // explicit roots without a separator must not be widened by appending `.`.
    const options = rewritten.slice(1, separator === -1 ? undefined : separator);
    const dshSearch = options.every(value => value.startsWith('--')) && (options.includes('--files')
        || (options.includes('--json') && options.some(value => value.startsWith('--regexp='))));
    if (!dshSearch)
        return rewritten;
    // In particular, pathless grep must search cwd, not the SSH stdin pipe.
    if (separator === -1)
        return [...rewritten, '--', '.'];
    if (separator === rewritten.length - 1)
        return [...rewritten, '.'];
    return rewritten.map((value, index) => {
        if (index <= separator)
            return value;
        const mapped = isSshPath(value) ? value : resolveRemotePath?.(value);
        if (mapped === undefined)
            return value;
        const mappedUri = parseSshUri(mapped);
        if (!sameRemote(cwd, mappedUri))
            throw new Error('remote ripgrep search root belongs to a different SSH host');
        return mappedUri.path;
    });
}
/** Build the local OpenSSH argv used for a remote process or terminal. */
export function buildRemoteSshInvocation(cwd, argv, env, terminal, resolveRemotePath) {
    if (argv.length === 0)
        throw new Error('remote subprocess argv is empty');
    const uri = parseSshUri(cwd);
    const destination = `${uri.user ? `${uri.user}@` : ''}${uri.host}`;
    const environment = Object.entries(env ?? {})
        .filter((entry) => entry[1] !== undefined)
        .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .map(([key, value]) => shellQuote(`${key}=${value}`));
    const command = remoteArgv(uri, argv, resolveRemotePath).map(shellQuote);
    const exec = environment.length > 0
        ? `exec env ${environment.join(' ')} ${command.join(' ')}`
        : `exec ${command.join(' ')}`;
    const script = `cd ${shellQuote(uri.path)} && ${exec}`;
    const args = ['ssh', terminal ? '-tt' : '-T'];
    // Port 22 stays absent so an alias-specific Port from ~/.ssh/config wins.
    if (uri.port !== 22)
        args.push('-p', String(uri.port));
    // End local OpenSSH option parsing before the destination. URI validation
    // also rejects option-like users/hosts; this is defense in depth.
    args.push('--', destination, `sh -lc ${shellQuote(script)}`);
    return args;
}
/**
 * Route process execution by Workspace cwd. The stock local provider still
 * owns stream collection, PTY behavior, cancellation and teardown; for a
 * mapped cwd its managed child is the system OpenSSH client.
 *
 * Execution-world lookup is routed too: a terminal or shell consumer resolves
 * its shell against the environment that will run it, so `resolveExecutable`
 * and `terminalEnvironment` answer for the SSH host instead of the client. A
 * client-local answer (`cmd.exe`, `powershell.exe`) otherwise verifies
 * successfully and then fails on the remote host, and shell discovery would
 * offer shells that host cannot start.
 */
export function installRemoteSubprocessRouter(subprocess, resolveRemotePath, helpers, resolveTerminalPath = resolveRemotePath) {
    const originalSpawn = subprocess.spawn;
    const originalSpawnTerminal = subprocess.spawnTerminal;
    const originalResolveExecutable = subprocess.resolveExecutable;
    const originalTerminalEnvironment = subprocess.terminalEnvironment;
    // The unwrapped provider operations, captured before any wrapper replaces
    // them. A workspace-bound binding delegates here, never back into the routed
    // service: for its own allocation this router replaces `spawnTerminal` with
    // that binding, so re-reading the property would call the binding again.
    const delegate = {
        spawn: spec => originalSpawn.call(subprocess, spec),
        spawnTerminal: spec => originalSpawnTerminal.call(subprocess, spec),
    };
    const remotePath = (path) => path === undefined ? undefined : isSshPath(path) ? path : resolveRemotePath(path);
    subprocess.spawn = function (spec) {
        const remoteCwd = remotePath(spec.cwd);
        if (remoteCwd === undefined)
            return originalSpawn.call(subprocess, spec);
        return originalSpawn.call(subprocess, {
            ...spec,
            argv: buildRemoteSshInvocation(remoteCwd, spec.argv, spec.env, false, resolveRemotePath),
            cwd: process.cwd(),
            env: undefined,
        });
    };
    subprocess.spawnTerminal = function (spec) {
        const remoteCwd = remotePath(spec.cwd);
        if (remoteCwd === undefined)
            return originalSpawnTerminal.call(subprocess, spec);
        return originalSpawnTerminal.call(subprocess, {
            ...spec,
            argv: buildRemoteSshInvocation(remoteCwd, spec.argv, spec.env, true, resolveRemotePath),
            cwd: process.cwd(),
            env: undefined,
        });
    };
    // Execution-world lookup without a workspace identity stays client-local: a
    // bare name carries no remote address. Consumers that DO know the workspace
    // resolve through the agent-bound facade instead (see
    // `createRemoteSubprocessBinding`); a bare name here is a local program such
    // as `rg`, and an anchored path is remote by construction.
    subprocess.resolveExecutable = async function (command, _env, signal) {
        const remoteCwd = remotePath(command);
        if (remoteCwd === undefined)
            return originalResolveExecutable.call(subprocess, command, _env, signal);
        return resolveRemoteExecutable(helpers, remoteCwd, command, signal);
    };
    subprocess.terminalEnvironment = async function (signal) {
        const preferred = await originalTerminalEnvironment.call(subprocess, signal);
        const mapped = preferred.defaultShell === undefined ? undefined : resolveTerminalPath(preferred.defaultShell);
        const remoteCwd = mapped !== undefined && isSshPath(mapped)
            ? mapped
            : remotePath(preferred.defaultShell);
        if (remoteCwd === undefined)
            return preferred;
        return remoteTerminalEnvironment(helpers, remoteCwd, signal);
    };
    return {
        restore: () => {
            subprocess.spawn = originalSpawn;
            subprocess.spawnTerminal = originalSpawnTerminal;
            subprocess.resolveExecutable = originalResolveExecutable;
            subprocess.terminalEnvironment = originalTerminalEnvironment;
        },
        delegate,
    };
}
/**
 * Resolve one executable on the SSH host that owns `remoteCwd`.
 *
 * A PATH name resolves through the host's own `PATH`. An absolute path is
 * verified as executable, and — because a host may report a login shell and
 * candidates that are only reachable by name — a path that fails that check is
 * retried once as its trailing component. This mirrors the harness's own
 * `resolveExecutable` contract (absolute paths verified, bare names searched)
 * while tolerating a path-shaped name whose directory is not the one the host
 * would search.
 */
async function resolveRemoteExecutable(helpers, remoteCwd, command, signal) {
    const client = await helpers.client(remoteCwd, signal);
    const attempt = async (candidate) => {
        try {
            const resolved = await client.call('executable/resolve', { command: candidate }, { signal, timeoutMs: 15_000 });
            return resolved.path;
        }
        catch (error) {
            if (error?.code === 'E_NOT_FOUND')
                return undefined;
            throw error;
        }
    };
    const name = executableName(command);
    const candidates = name !== '' && name !== command ? [command, name] : [command];
    for (const candidate of candidates) {
        const resolved = await attempt(candidate);
        if (resolved !== undefined)
            return resolved;
    }
    throw new SubprocessExecutableNotFoundError(`remote executable lookup: command ${JSON.stringify(command)} is not executable on ${parseSshUri(remoteCwd).host}`);
}
/**
 * Shell-selection facts for one SSH execution world. The helper only runs on
 * POSIX hosts, so a remote world is always `posix`; its validated login shell
 * is the default the remote PTY backend would start.
 */
async function remoteTerminalEnvironment(helpers, remoteCwd, signal) {
    const client = await helpers.client(remoteCwd, signal);
    const shell = client.hello.platform.shell;
    return {
        platform: 'posix',
        ...(typeof shell === 'string' && shell.startsWith('/') ? { defaultShell: shell } : {}),
    };
}
/**
 * Subprocess facade for one agent whose workspace is an SSH anchor. Mounted on
 * the agent's own context, so every terminal entry point — shell discovery,
 * environment inspection, and terminal allocation — resolves inside the
 * workspace that agent owns rather than through process-wide state. Shell
 * discovery asks for bare names (`bash`, `zsh`, ...), which is exactly the case
 * the shared provider cannot answer: the workspace identity is only available
 * on the agent context that the harness passes to these consumers.
 *
 * `delegate` must be the provider's UNWRAPPED operations (`installRemoteSubprocessRouter`
 * returns them). The binding is installed as the provider's own `spawnTerminal`
 * for the duration of one allocation, so re-reading that property from the
 * service at call time would recurse into the binding itself.
 */
export function createRemoteSubprocessBinding(delegate, remoteCwd, helpers) {
    const route = (spec, terminal) => terminal
        ? delegate.spawnTerminal({
            ...spec,
            argv: buildRemoteSshInvocation(remoteCwd, spec.argv, spec.env, true, () => undefined),
            cwd: process.cwd(),
            env: undefined,
        })
        : delegate.spawn({
            ...spec,
            argv: buildRemoteSshInvocation(remoteCwd, spec.argv, spec.env, false, () => undefined),
            cwd: process.cwd(),
            env: undefined,
        });
    return {
        resolveExecutable: (command, _env, signal) => resolveRemoteExecutable(helpers, remoteCwd, command, signal),
        terminalEnvironment: signal => remoteTerminalEnvironment(helpers, remoteCwd, signal),
        spawn: spec => route(spec, false),
        spawnTerminal: spec => {
            const argv = buildRemoteSshInvocation(remoteCwd, spec.argv, spec.env, true, () => undefined);
            return delegate.spawnTerminal({
                ...spec,
                argv: withAbsoluteTerminalProgram(argv),
                cwd: process.cwd(),
                env: undefined,
            });
        },
    };
}
/**
 * Give a terminal invocation an absolute client program on Windows. node-pty's
 * ConPTY backend starts its `file` without PATH/PATHEXT resolution, so the bare
 * `ssh` this router emits fails there with a bare "File not found" while every
 * ordinary spawn — which does resolve PATH names — works. POSIX keeps the bare
 * name: node-pty resolves it through `execvp`, and the PATH entry named at
 * startup is the one the user's shell configuration expects.
 *
 * A program that cannot be located keeps its original argv, so a missing client
 * binary still surfaces the provider's own error rather than a rewritten one.
 */
function withAbsoluteTerminalProgram(argv) {
    if (process.platform !== 'win32')
        return argv;
    const absolute = resolveLocalBinary(argv[0]);
    return absolute === undefined ? argv : [absolute, ...argv.slice(1)];
}
/**
 * Resolve one client-local program to an absolute path through `PATH` and
 * `PATHEXT`, mirroring what a shell or Node's own spawn does. Returns
 * `undefined` for an already-absolute path that does not exist and for a name
 * that cannot be found, leaving the caller's argv untouched.
 */
function resolveLocalBinary(program) {
    if (program === undefined || program.length === 0)
        return undefined;
    if (isAbsolute(program))
        return existsSync(program) ? program : undefined;
    // A program that already carries a Windows extension is used verbatim; every
    // other name is probed with each `PATHEXT` entry (lower-case, because the
    // real files are `.exe`/`.cmd` while `PATHEXT` advertises `.EXE`/`.CMD`).
    const hasExtension = process.platform === 'win32' && /\.[^./\\]+$/u.test(program);
    const extensions = hasExtension
        ? ['']
        : process.platform === 'win32'
            ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(extension => extension.length > 0)
            : [''];
    const names = extensions.map(extension => `${program}${extension.toLowerCase()}`);
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (directory.length === 0)
            continue;
        for (const name of names) {
            const candidate = join(directory, name);
            if (existsSync(candidate))
                return candidate;
        }
    }
    return undefined;
}
/**
 * Shell discovery and terminal allocation for one remote workspace. `discoverShells`
 * verifies each candidate through the bound provider, so the offered list is
 * exactly the set of programs the remote host can start.
 */
async function discoverRemoteShells(binding, configured, candidates, signal) {
    const environment = await binding.terminalEnvironment(signal);
    // The declared default is the remote host's own login shell. A host whose
    // login shell is only reachable by name is handled inside
    // `resolveRemoteExecutable`, which retries a failed path as its bare name, so
    // one failed resolution here must not empty the whole list: the candidate
    // sweep below still offers every shell the host can actually start.
    const declared = configured ?? { path: environment.defaultShell ?? '/bin/sh' };
    const preferred = await firstStartableShell(binding, [declared], signal);
    const found = await Promise.all(candidates.map(async (candidate) => {
        try {
            return await verifyRemoteShell(binding, { path: candidate }, signal);
        }
        catch (error) {
            if (error instanceof SubprocessExecutableNotFoundError)
                return undefined;
            throw error;
        }
    }));
    const shells = new Map();
    for (const shell of [preferred, ...found]) {
        if (shell === undefined)
            continue;
        const kind = shell.path.slice(shell.path.lastIndexOf('/') + 1).toLowerCase();
        if (!shells.has(kind))
            shells.set(kind, shell);
    }
    return [...shells.values()];
}
/** Verify candidate profiles in order, returning the first the host can start. */
async function firstStartableShell(binding, profiles, signal) {
    for (const profile of profiles) {
        try {
            return await verifyRemoteShell(binding, profile, signal);
        }
        catch (error) {
            if (!(error instanceof SubprocessExecutableNotFoundError))
                throw error;
        }
    }
    return undefined;
}
/** The trailing path component, used to retry one absolute path as a PATH name. */
function executableName(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}
/** Verify one candidate on the remote host, mirroring the harness's own shell profile shape. */
async function verifyRemoteShell(binding, profile, signal) {
    const path = await binding.resolveExecutable(profile.path, undefined, signal);
    const name = profile.name ?? path.slice(path.lastIndexOf('/') + 1);
    const kind = name.toLowerCase().replace(/\.exe$/u, '');
    const args = profile.args ?? (kind === 'cmd' ? [] : kind === 'pwsh' || kind === 'powershell' ? ['-NoLogo'] : ['-i']);
    return { path, name, args };
}
/**
 * Bind Web-terminal shell resolution to each agent's own workspace. The panel
 * discovers shells, inspects the environment, and allocates the terminal
 * through `agent.ctx`, but the shared subprocess provider has no workspace
 * identity, so a bare candidate such as `bash` would be verified on the client
 * and then fail on the host. Every entry point here carries the agent, so the
 * remote provider is selected from that agent's workspace instead of from
 * process-wide state.
 *
 * Allocation itself stays with the stock controller: this router only supplies
 * the resolved remote shell and redirects the single `spawnTerminal` call that
 * immediately follows it.
 */
export function installRemoteTerminalControllerRouter(controller, resolveRemotePath, helpers, delegate, target) {
    const originalSpawn = controller.spawn;
    const originalShells = controller.shells;
    if (typeof originalSpawn !== 'function' || typeof originalShells !== 'function')
        return () => { };
    const remoteCwdOf = (agent) => {
        const cwd = agent.session.header.cwd;
        return cwd === undefined ? undefined : isSshPath(cwd) ? cwd : resolveRemotePath(cwd);
    };
    controller.shells = async function (agent, signal) {
        const remoteCwd = remoteCwdOf(agent);
        if (remoteCwd === undefined)
            return originalShells.call(controller, agent, signal);
        const binding = createRemoteSubprocessBinding(delegate, remoteCwd, helpers);
        return discoverRemoteShells(binding, undefined, DEFAULT_REMOTE_SHELL_CANDIDATES, signal);
    };
    controller.spawn = async function (agent, owner, request, signal) {
        const remoteCwd = remoteCwdOf(agent);
        if (remoteCwd === undefined)
            return originalSpawn.call(controller, agent, owner, request, signal);
        const binding = createRemoteSubprocessBinding(delegate, remoteCwd, helpers);
        const shells = await discoverRemoteShells(binding, undefined, DEFAULT_REMOTE_SHELL_CANDIDATES, signal);
        const shell = request.shellPath === undefined
            ? shells[0]
            : shells.find(candidate => candidate.path === request.shellPath);
        if (shell === undefined)
            throw new Error('Selected shell is not available in this execution environment');
        return withRemoteTerminal(target, binding, () => originalSpawn.call(controller, agent, owner, { ...request, shellPath: shell.path }, signal));
    };
    return () => {
        controller.spawn = originalSpawn;
        controller.shells = originalShells;
    };
}
/**
 * Run one stock terminal allocation against `binding` while that allocation
 * spawns. The controller resolves `subprocess` before this call and allocates
 * in the same turn afterwards, so the swap covers exactly the allocation it
 * belongs to — no workspace binding outlives the operation. The binding
 * delegates to the provider's unwrapped operations, so this swap cannot
 * recurse; the `finally` restores whatever wrapper is current rather than the
 * value read here, so an overlapping allocation is never clobbered.
 */
function withRemoteTerminal(target, binding, allocate) {
    const previous = target.spawnTerminal;
    target.spawnTerminal = spec => binding.spawnTerminal(spec);
    return allocate().finally(() => {
        if (target.spawnTerminal !== previous)
            target.spawnTerminal = previous;
    });
}
const DEFAULT_REMOTE_SHELL_CANDIDATES = ['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'];
export function installRemoteTerminalRouter(terminals, resolveRemotePath) {
    const originalSpawn = terminals.spawn;
    terminals.spawn = function (owner, request, signal) {
        const cwd = request.cwd;
        const remote = cwd !== undefined && (cwd.startsWith('ssh://') || resolveRemotePath(cwd) !== undefined);
        if (!remote)
            return originalSpawn.call(terminals, owner, request, signal);
        return originalSpawn.call(terminals, owner, { ...request, type: 'ssh' }, signal);
    };
    return () => {
        terminals.spawn = originalSpawn;
    };
}
//# sourceMappingURL=runtime-router.js.map