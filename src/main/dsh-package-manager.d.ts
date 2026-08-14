import type { AppPaths } from './platform/app-paths.js';
import { type ProcessRunner } from './platform/process-runner.js';
export interface DshSelection {
    readonly version: string;
    readonly directory: string;
    readonly installedAt: string;
    readonly lastHealthyAt?: string;
}
export interface DshInstall {
    readonly selection: DshSelection;
    readonly binaryPath: string;
}
export declare class DshPackageManager {
    private readonly paths;
    private readonly runner;
    constructor(paths: AppPaths, runner?: ProcessRunner);
    current(): Promise<DshSelection | null>;
    previous(): Promise<DshSelection | null>;
    validate(directory: string, expectedVersion: string): Promise<DshInstall>;
    install(npmPath: string, version: string): Promise<DshInstall>;
    select(selection: DshSelection): Promise<void>;
    restorePrevious(): Promise<DshSelection>;
}
