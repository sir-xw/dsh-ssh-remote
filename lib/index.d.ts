import { Context } from '@deepseek-ai/cordis';
import { LegacySshRemoteSettingsSchema, type LegacySshConfig } from './registry.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Web-terminal controller owned by `@deepseek-ai/dsh-api-terminal-controller`. */
        terminalController: import('./runtime-router.js').TerminalControllerService;
    }
}
export type { DiscoveredSshHost, HelperHostDiagnostics, HelperHostStatus, HelperHostStatuses, RemoteDirectoryEntry, RemoteDirectoryListing, SshConfig, SshHostEntry, SshWorkspaceAnchor, } from './registry.js';
export { LegacySsh2RemoteTerminalBackend, Ssh2RemoteTerminalBackend } from './terminal.js';
export declare const name = "dsh-ssh-remote";
export declare const inject: string[];
/** Legacy SSH host fallback consumed through the standard Cordis Config. */
export declare const Config: typeof LegacySshRemoteSettingsSchema;
export declare function apply(ctx: Context, config: LegacySshConfig): () => Promise<void>;
//# sourceMappingURL=index.d.ts.map