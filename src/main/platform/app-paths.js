import { join, resolve } from 'node:path';
import semver from 'semver';
export function createAppPaths(userData) {
    const root = resolve(userData);
    const dsh = join(root, 'dsh');
    return {
        root,
        versions: join(dsh, 'versions'),
        staging: join(dsh, 'staging'),
        currentPointer: join(dsh, 'current.json'),
        previousPointer: join(dsh, 'previous.json'),
        failedReleases: join(dsh, 'failed-releases.json'),
        logs: join(root, 'logs')
    };
}
export function versionDirectory(paths, version) {
    const valid = semver.valid(version);
    if (!valid || valid !== version)
        throw new Error(`Invalid DSH version: ${version}`);
    const directory = resolve(paths.versions, valid);
    const versionsRoot = `${resolve(paths.versions)}\\`;
    if (!directory.startsWith(versionsRoot))
        throw new Error('DSH version path escaped its root');
    return directory;
}
