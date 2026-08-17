import type {
  DshServiceStatus,
  DshUpdateState,
  WorkspaceTab,
  WorkspaceTabState
} from '../../shared/contracts.js'

const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')]
const stateElement = document.querySelector<HTMLElement>('#state')
const dshStatusElement = document.querySelector<HTMLElement>('#dsh-status')
const updateStatusElement = document.querySelector<HTMLElement>('#update-status')
const restartButton = document.querySelector<HTMLButtonElement>('#restart-dsh')

function activate(tab: WorkspaceTab): void {
  for (const button of buttons) {
    const selected = button.dataset.tab === tab
    button.classList.toggle('is-active', selected)
    button.setAttribute('aria-selected', String(selected))
  }
}

function renderState(state: WorkspaceTabState): void {
  if (!stateElement) return
  stateElement.classList.toggle('is-loading', state.loading)
  stateElement.classList.toggle('is-error', Boolean(state.detail && !state.loading))
  if (state.detail) {
    stateElement.textContent = state.detail
  } else if (state.loading) {
    stateElement.textContent = state.tab === 'deepseek' ? '正在连接 DeepSeek…' : '正在连接 DSH…'
  } else {
    stateElement.textContent = state.tab === 'deepseek' ? 'DeepSeek 已连接' : 'DSH 已连接'
  }
}

const SERVICE_LABELS: Readonly<Record<DshServiceStatus['phase'], string>> = {
  watching: 'DSH 运行中',
  degraded: 'DSH 响应异常',
  restarting: 'DSH 正在恢复…',
  failed: 'DSH 需要重启',
  stopped: 'DSH 未运行'
}

function renderServiceStatus(status: DshServiceStatus): void {
  if (!dshStatusElement || !restartButton) return
  dshStatusElement.hidden = false
  dshStatusElement.classList.toggle('is-error', status.phase === 'failed')
  dshStatusElement.classList.toggle(
    'is-busy',
    status.phase === 'restarting' || status.phase === 'degraded'
  )
  dshStatusElement.textContent = status.detail
    ? `${SERVICE_LABELS[status.phase]} · ${status.detail}`
    : SERVICE_LABELS[status.phase]
  restartButton.hidden = status.phase !== 'failed'
}

function renderUpdateState(state: DshUpdateState): void {
  if (!updateStatusElement) return
  if (state.phase === 'update-available' || state.phase === 'preparing' || state.phase === 'applying') {
    updateStatusElement.hidden = false
    updateStatusElement.textContent =
      state.phase === 'preparing'
        ? `正在准备 DSH ${state.version ?? ''}…`
        : state.phase === 'applying'
          ? '正在应用 DSH 更新…'
          : 'DSH 新版本可用'
  } else {
    updateStatusElement.hidden = true
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab
    if (tab !== 'dsh' && tab !== 'deepseek') return
    activate(tab)
    void window.dshShell.selectTab(tab)
  })
}

restartButton?.addEventListener('click', () => {
  void window.dshShell.restartDsh()
})

window.dshShell.onTabChanged(activate)
window.dshShell.onTabState(renderState)
window.dshShell.onServiceStatus(renderServiceStatus)
window.dshShell.onUpdateState(renderUpdateState)
void window.dshShell
  .getSnapshot()
  .then((snapshot) => {
    renderServiceStatus(snapshot.service)
    renderUpdateState(snapshot.update)
  })
  .catch(() => undefined)