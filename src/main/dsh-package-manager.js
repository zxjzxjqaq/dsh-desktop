import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import semver from 'semver';
import { versionDirectory } from './platform/app-paths.js';
import { readJson, writeJsonAtomic } from './platform/atomic-json.js';
import { runProcess } from './platform/process-runner.js';
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
export class DshPackageManager {
    paths;
    runner;
    constructor(paths, runner = runProcess) {
        this.paths = paths;
        this.runner = runner;
    }
    async current() {
        return await readJson(this.paths.currentPointer);
    }
    async previous() {
        return await readJson(this.paths.previousPointer);
    }
    async validate(directory, expectedVersion) {
        if (semver.valid(expectedVersion) !== expectedVersion) {
            throw new Error(`Invalid DSH version: ${expectedVersion}`);
        }
        const packageRoot = resolve(directory, 'node_modules', '@deepseek-ai', 'dsh');
        const manifestPath = join(packageRoot, 'package.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        if (manifest.name !== '@deepseek-ai/dsh')
            throw new Error('Installed package name is not @deepseek-ai/dsh');
        if (manifest.version !== expectedVersion)
            throw new Error('Installed DSH version does not match request');
        const relativeBinary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
        if (!relativeBinary)
            throw new Error('Installed DSH package has no dsh binary');
        const binaryPath = resolve(packageRoot, relativeBinary);
        if (!binaryPath.startsWith(`${packageRoot}\\`))
            throw new Error('DSH binary escaped package root');
        if (!(await exists(binaryPath)))
            throw new Error('Installed DSH binary does not exist');
        return {
            selection: {
                version: expectedVersion,
                directory: resolve(directory),
                installedAt: new Date().toISOString()
            },
            binaryPath
        };
    }
    async install(npmPath, version) {
        const finalDirectory = versionDirectory(this.paths, version);
        if (await exists(finalDirectory))
            return await this.validate(finalDirectory, version);
        await mkdir(this.paths.staging, { recursive: true });
        const stagingDirectory = join(this.paths.staging, `${version}-${randomUUID()}`);
        await mkdir(stagingDirectory, { recursive: true });
        const result = await this.runner(npmPath, [
            'install',
            '--prefix',
            stagingDirectory,
            '--omit=dev',
            '--no-audit',
            '--no-fund',
            '--save-exact',
            `@deepseek-ai/dsh@${version}`
        ], { timeoutMs: 10 * 60_000 });
        if (result.exitCode !== 0) {
            await rm(stagingDirectory, { recursive: true, force: true });
            throw new Error(result.stderr.trim() || `npm.cmd exited with ${String(result.exitCode)}`);
        }
        await this.validate(stagingDirectory, version);
        await mkdir(dirname(finalDirectory), { recursive: true });
        await rename(stagingDirectory, finalDirectory);
        return await this.validate(finalDirectory, version);
    }
    async select(selection) {
        const validated = await this.validate(selection.directory, selection.version);
        const current = await this.current();
        if (current)
            await writeJsonAtomic(this.paths.previousPointer, current);
        await writeJsonAtomic(this.paths.currentPointer, validated.selection);
    }
    async restorePrevious() {
        const previous = await this.previous();
        if (!previous)
            throw new Error('No previous DSH release is available');
        const validated = await this.validate(previous.directory, previous.version);
        await writeJsonAtomic(this.paths.currentPointer, validated.selection);
        return validated.selection;
    }
}
