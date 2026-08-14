export type LogChannel = 'desktop' | 'dsh' | 'updater';
export declare function redactSecrets(value: string): string;
export declare class FileLogger {
    private readonly directory;
    private readonly retentionDays;
    constructor(directory: string, retentionDays?: number);
    write(channel: LogChannel, message: string): Promise<void>;
    prune(now?: number): Promise<void>;
}
