import type { StartupPhase, StartupStatus } from './contracts.js'

const TRANSITIONS: Readonly<Record<StartupPhase, readonly StartupPhase[]>> = {
  'checking-node': ['preparing-dsh', 'environment-error'],
  'preparing-dsh': ['starting-dsh', 'package-error'],
  'starting-dsh': ['waiting-for-health', 'service-error'],
  'waiting-for-health': ['ready', 'service-error'],
  ready: ['starting-dsh', 'service-error'],
  'environment-error': ['checking-node'],
  'package-error': ['preparing-dsh'],
  'service-error': ['starting-dsh']
}

export function canTransition(from: StartupPhase, to: StartupPhase): boolean {
  return TRANSITIONS[from].includes(to)
}

export function transition(current: StartupStatus, next: StartupStatus): StartupStatus {
  if (!canTransition(current.phase, next.phase)) {
    throw new Error(`Invalid startup transition: ${current.phase} -> ${next.phase}`)
  }
  return next
}
