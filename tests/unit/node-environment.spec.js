import { describe, expect, it } from 'vitest';
import { detectNodeEnvironment } from '../../src/main/node-environment.js';
function fakeRunner(outputs) {
    return async (executable, args) => {
        const key = `${executable} ${args.join(' ')}`;
        const output = outputs[key];
        return {
            exitCode: output?.code ?? 1,
            stdout: output?.stdout ?? '',
            stderr: '',
            timedOut: false
        };
    };
}
describe('Node environment detection', () => {
    it('detects compatible node and npm executables', async () => {
        const runner = fakeRunner({
            'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
            'C:\\Node\\node.exe --version': { code: 0, stdout: 'v24.15.0\n' },
            'where.exe npm.cmd': { code: 0, stdout: 'C:\\Node\\npm.cmd\r\n' },
            'C:\\Node\\npm.cmd --version': { code: 0, stdout: '11.14.1\n' }
        });
        await expect(detectNodeEnvironment(runner)).resolves.toMatchObject({
            ok: true,
            nodeVersion: '24.15.0',
            npmVersion: '11.14.1'
        });
    });
    it('reports incompatible node', async () => {
        const runner = fakeRunner({
            'where.exe node': { code: 0, stdout: 'C:\\Node\\node.exe\r\n' },
            'C:\\Node\\node.exe --version': { code: 0, stdout: 'v20.0.0\n' }
        });
        await expect(detectNodeEnvironment(runner)).resolves.toMatchObject({
            ok: false,
            reason: 'node-incompatible'
        });
    });
});
