import type { StartupPhase, StartupStatus } from './contracts.js';
export declare function canTransition(from: StartupPhase, to: StartupPhase): boolean;
export declare function transition(current: StartupStatus, next: StartupStatus): StartupStatus;
