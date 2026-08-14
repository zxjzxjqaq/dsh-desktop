export type StartupAction = 'retry' | 'open-node-download' | 'open-logs' | 'exit';
export interface DesktopVersions {
    readonly app: string;
    readonly dsh: string | null;
    readonly node: string | null;
    readonly npm: string | null;
}
export interface StartupBridge {
    readonly productName: string;
    readonly platform: string;
    getVersions(): Promise<DesktopVersions>;
    perform(action: StartupAction): Promise<void>;
    onStatus(listener: (status: StartupStatus) => void): () => void;
}
export type StartupPhase = 'checking-node' | 'preparing-dsh' | 'starting-dsh' | 'waiting-for-health' | 'ready' | 'environment-error' | 'package-error' | 'service-error';
export interface StartupStatus {
    readonly phase: StartupPhase;
    readonly title: string;
    readonly detail: string;
    readonly diagnostic?: string;
    readonly actions: readonly StartupAction[];
}
