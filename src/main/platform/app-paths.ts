import { join, resolve } from 'node:path'
import semver from 'semver'

export interface AppPaths {
  readonly root: string
  readonly versions: string
  readonly staging: string
  readonly currentPointer: string
  readonly previousPointer: string
  readonly failedReleases: string
  readonly logs: string
}

export function createAppPaths(userData: string): AppPaths {
  const root = resolve(userData)
  const dsh = join(root, 'dsh')
  return {
    root,
    versions: join(dsh, 'versions'),
    staging: join(dsh, 'staging'),
    currentPointer: join(dsh, 'current.json'),
    previousPointer: join(dsh, 'previous.json'),
    failedReleases: join(dsh, 'failed-releases.json'),
    logs: join(root, 'logs')
  }
}

export function versionDirectory(paths: AppPaths, version: string): string {
  const valid = semver.valid(version)
  if (!valid || valid !== version) throw new Error(`Invalid DSH version: ${version}`)
  const directory = resolve(paths.versions, valid)
  const versionsRoot = `${resolve(paths.versions)}\\`
  if (!directory.startsWith(versionsRoot)) throw new Error('DSH version path escaped its root')
  return directory
}
