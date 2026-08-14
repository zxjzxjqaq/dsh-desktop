export interface AppPaths {
    readonly root: string;
    readonly versions: string;
    readonly staging: string;
    readonly currentPointer: string;
    readonly previousPointer: string;
    readonly failedReleases: string;
    readonly logs: string;
}
export declare function createAppPaths(userData: string): AppPaths;
export declare function versionDirectory(paths: AppPaths, version: string): string;
