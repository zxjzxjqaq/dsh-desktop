import { spawn } from 'node:child_process';
export const runProcess = async (executable, args, options = {}) => {
    return await new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        const child = spawn(executable, [...args], {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            windowsHide: true
        });
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => (stdout += chunk));
        child.stderr?.on('data', (chunk) => (stderr += chunk));
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(result);
        };
        const timer = options.timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill();
            }, options.timeoutMs)
            : undefined;
        child.on('error', (error) => finish({ exitCode: null, stdout, stderr, timedOut, error }));
        child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut }));
    });
};
