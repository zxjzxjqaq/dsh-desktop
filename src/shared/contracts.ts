export type StartupAction = 'retry' | 'open-node-download' | 'open-logs' | 'exit'

export interface DesktopVersions {
  readonly app: string
  readonly dsh: string | null
  readonly node: string | null
  readonly nodeSource: 'bundled' | 'system' | null
  readonly npm: string | null
}

export interface StartupBridge {
  readonly productName: string
  readonly platform: string
  getVersions(): Promise<DesktopVersions>
  perform(action: StartupAction): Promise<void>
  onStatus(listener: (status: StartupStatus) => void): () => void
}

export type StartupPhase =
  | 'preparing-runtime'
  | 'checking-node'
  | 'preparing-dsh'
  | 'starting-dsh'
  | 'waiting-for-health'
  | 'ready'
  | 'environment-error'
  | 'package-error'
  | 'service-error'

export interface StartupProgress {
  /** 已完成解压的文件数（跨 Node 与 DSH 两个内置运行环境合并统计） */
  readonly done: number
  /** 目标文件总数；旧版清单未记录时为 null，界面退化为不定进度条 */
  readonly total: number | null
}

export interface StartupStatus {
  readonly phase: StartupPhase
  readonly title: string
  readonly detail: string
  readonly diagnostic?: string
  readonly actions: readonly StartupAction[]
  readonly progress?: StartupProgress
}

export type WorkspaceTab = 'dsh' | 'deepseek'

export interface WorkspaceTabState {
  readonly tab: WorkspaceTab
  readonly loading: boolean
  readonly detail?: string
}

export interface ShellBridge {
  selectTab(tab: WorkspaceTab): Promise<void>
  onTabChanged(listener: (tab: WorkspaceTab) => void): () => void
  onTabState(listener: (state: WorkspaceTabState) => void): () => void
}
