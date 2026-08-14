import semver from 'semver';
import { NODE_VERSION_RANGE } from '../shared/config.js';
import { runProcess } from './platform/process-runner.js';
function candidates(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}
async function locate(name, runner) {
    const result = await runner('where.exe', [name], { timeoutMs: 5_000 });
    return result.exitCode === 0 ? candidates(result.stdout) : [];
}
export async function detectNodeEnvironment(runner = runProcess) {
    const nodePaths = await locate('node', runner);
    if (nodePaths.length === 0) {
        return { ok: false, reason: 'node-missing', detail: '未找到系统 Node.js。' };
    }
    let nodeFailure = '';
    let detectedVersion;
    for (const nodePath of nodePaths) {
        const result = await runner(nodePath, ['--version'], { timeoutMs: 5_000 });
        const version = semver.clean(result.stdout.trim()) ?? undefined;
        if (result.exitCode !== 0 || !version) {
            nodeFailure = result.error?.message ?? (result.stderr.trim() || 'Node.js 版本输出无效。');
            continue;
        }
        detectedVersion = version;
        if (!semver.satisfies(version, NODE_VERSION_RANGE)) {
            continue;
        }
        const npmPaths = await locate('npm.cmd', runner);
        for (const npmPath of npmPaths) {
            const npmResult = await runner(npmPath, ['--version'], { timeoutMs: 5_000 });
            const npmVersion = semver.clean(npmResult.stdout.trim());
            if (npmResult.exitCode === 0 && npmVersion) {
                return { ok: true, nodePath, npmPath, nodeVersion: version, npmVersion };
            }
        }
        return { ok: false, reason: 'npm-missing', detail: 'Node.js 可用，但未找到可执行的 npm.cmd。' };
    }
    if (detectedVersion) {
        return {
            ok: false,
            reason: 'node-incompatible',
            detail: `Node.js ${detectedVersion} 不符合 ${NODE_VERSION_RANGE}。`,
            detectedVersion
        };
    }
    return { ok: false, reason: 'execution-failed', detail: nodeFailure || 'Node.js 启动失败。' };
}
