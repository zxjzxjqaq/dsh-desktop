import type { WorkspaceTab, WorkspaceTabState } from '../../shared/contracts.js'

const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')]
const stateElement = document.querySelector<HTMLElement>('#state')

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

for (const button of buttons) {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab
    if (tab !== 'dsh' && tab !== 'deepseek') return
    activate(tab)
    void window.dshShell.selectTab(tab)
  })
}

window.dshShell.onTabChanged(activate)
window.dshShell.onTabState(renderState)
