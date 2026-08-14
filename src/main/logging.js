import { mkdir, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const SECRET_ASSIGNMENT = /(api[_-]?key|apikey|authorization|token|secret)(\s*[=:]\s*)(bearer\s+[^\s,;}]+|'[^']*'|"[^"]*"|[^\s,;}]+)/gi;
const BEARER_VALUE = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
export function redactSecrets(value) {
    let redacted = value;
    redacted = redacted.replace(SECRET_ASSIGNMENT, (_match, name, separator) => {
        return `${name}${separator}[REDACTED]`;
    });
    redacted = redacted.replace(BEARER_VALUE, '$1[REDACTED]');
    return redacted;
}
export class FileLogger {
    directory;
    retentionDays;
    constructor(directory, retentionDays = 14) {
        this.directory = directory;
        this.retentionDays = retentionDays;
    }
    async write(channel, message) {
        await mkdir(this.directory, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        const line = `${new Date().toISOString()} ${redactSecrets(message)}\n`;
        await appendFile(join(this.directory, `${channel}-${date}.log`), line, 'utf8');
    }
    async prune(now = Date.now()) {
        await mkdir(this.directory, { recursive: true });
        const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
        const names = await readdir(this.directory);
        await Promise.all(names
            .filter((name) => /^(desktop|dsh|updater)-\d{4}-\d{2}-\d{2}\.log$/.test(name))
            .map(async (name) => {
            const path = join(this.directory, name);
            try {
                if ((await stat(path)).mtimeMs < cutoff)
                    await rm(path, { force: true });
            }
            catch {
                // Log retention must not block application startup.
            }
        }));
    }
}
