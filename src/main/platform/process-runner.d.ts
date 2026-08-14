export interface ProcessResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly error?: Error;
}
export interface RunProcessOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
}
export type ProcessRunner = (executable: string, args: readonly string[], options?: RunProcessOptions) => Promise<ProcessResult>;
export declare const runProcess: ProcessRunner;
