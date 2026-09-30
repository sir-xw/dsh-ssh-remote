import FileSystem from '@deepseek-ai/dsh-fs';
import { type SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessTerminalEnvironment, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { TerminalSessionService } from '@deepseek-ai/dsh-terminal';
import { type RemoteHelperProvider } from './helper-fs.js';
import type { SshConnectionManager } from './connection.js';
/** Resolve a registered local anchor or descendant to an SSH URI. */
export type RemotePathResolver = (path: string) => string | undefined;
/**
 * Add exact SSH URI routing to DSH's filesystem service. Local paths always
 * call the original provider; only direct SSH URIs and paths beneath a
 * persisted remote Workspace anchor use SFTP.
 */
export declare function installRemoteFileSystemRouter(fs: FileSystem, connections: SshConnectionManager, resolveRemotePath: RemotePathResolver, helpers?: RemoteHelperProvider): () => void;
/** Build the local OpenSSH argv used for a remote process or terminal. */
export declare function buildRemoteSshInvocation(cwd: string, argv: readonly string[], env: NodeJS.ProcessEnv | undefined, terminal: boolean, resolveRemotePath?: RemotePathResolver): readonly string[];
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
export declare function installRemoteSubprocessRouter(subprocess: SubprocessRuntime, resolveRemotePath: RemotePathResolver, helpers: RemoteHelperProvider, resolveTerminalPath?: RemotePathResolver): {
    restore: () => void;
    delegate: RemoteSubprocessDelegate;
};
/** The provider operations a remote binding delegates to. */
export interface RemoteSubprocessDelegate {
    spawn(spec: SubprocessSpawnSpec): unknown;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<unknown>;
}
/** The slice of the subprocess seam a terminal consumer uses, bound to one workspace. */
export interface RemoteSubprocessBinding {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>;
    spawn(spec: SubprocessSpawnSpec): unknown;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<unknown>;
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
export declare function createRemoteSubprocessBinding(delegate: RemoteSubprocessDelegate, remoteCwd: string, helpers: RemoteHelperProvider): RemoteSubprocessBinding;
/** One terminal agent's scoped identity: enough to bind its workspace. */
export interface TerminalControllerAgent {
    session: {
        header: {
            cwd?: string;
        };
    };
}
interface RemoteShellProfile {
    path: string;
    name?: string;
    args?: string[];
}
/** The slice of the Web terminal controller this router rewrites. */
export interface TerminalControllerService {
    spawn?(agent: TerminalControllerAgent, owner: unknown, request: RemoteTerminalCreateRequest, signal?: AbortSignal): Promise<unknown>;
    shells?(agent: TerminalControllerAgent, signal?: AbortSignal): Promise<RemoteShellProfile[]>;
}
export interface RemoteTerminalCreateRequest {
    shellPath?: string;
    [key: string]: unknown;
}
/** The service whose `spawnTerminal` one scoped allocation redirects. */
export interface RemoteTerminalAllocationTarget {
    spawnTerminal: SubprocessRuntime['spawnTerminal'];
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
export declare function installRemoteTerminalControllerRouter(controller: TerminalControllerService, resolveRemotePath: RemotePathResolver, helpers: RemoteHelperProvider, delegate: RemoteSubprocessDelegate, target: RemoteTerminalAllocationTarget): () => void;
export declare function installRemoteTerminalRouter(terminals: TerminalSessionService, resolveRemotePath: RemotePathResolver): () => void;
export {};
//# sourceMappingURL=runtime-router.d.ts.map