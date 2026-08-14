import { type ProcessRunner } from './platform/process-runner.js';
export interface ValidNodeEnvironment {
    readonly ok: true;
    readonly nodePath: string;
    readonly npmPath: string;
    readonly nodeVersion: string;
    readonly npmVersion: string;
}
export interface InvalidNodeEnvironment {
    readonly ok: false;
    readonly reason: 'node-missing' | 'npm-missing' | 'node-incompatible' | 'execution-failed';
    readonly detail: string;
    readonly detectedVersion?: string;
}
export type NodeEnvironment = ValidNodeEnvironment | InvalidNodeEnvironment;
export declare function detectNodeEnvironment(runner?: ProcessRunner): Promise<NodeEnvironment>;
