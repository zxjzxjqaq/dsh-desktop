import type { StartupAction, StartupStatus } from '../../shared/contracts.js'

const platform = document.querySelector<HTMLParagraphElement>('#platform')
const title = document.querySelector<HTMLHeadingElement>('#title')
const detail = document.querySelector<HTMLParagraphElement>('#detail')
const diagnostic = document.querySelector<HTMLPreElement>('#diagnostic')
const actions = document.querySelector<HTMLDivElement>('#actions')
const progress = document.querySelector<HTMLDivElement>('.progress')
const progressFill = document.querySelector<HTMLSpanElement>('.progress span')
const progressLabel = document.querySelector<HTMLParagraphElement>('#progress-label')

const ACTION_LABELS: Readonly<Record<StartupAction, string>> = {
  retry: '重新检测',
  'open-node-download': '安装 Node.js',
  'open-logs': '打开日志',
  exit: '退出'
}

function render(status: StartupStatus): void {
  if (title) title.textContent = status.title
  if (detail) detail.textContent = status.detail
  if (progress) progress.hidden = status.phase.endsWith('error')

  const percent =
    status.progress && status.progress.total !== null && status.progress.total > 0
      ? Math.min(100, Math.round((status.progress.done / status.progress.total) * 100))
      : null
  if (progressFill) {
    if (percent === null) {
      progressFill.style.width = ''
      progressFill.classList.remove('determinate')
    } else {
      progressFill.style.width = `${percent}%`
      progressFill.classList.add('determinate')
    }
  }
  if (progressLabel) {
    progressLabel.hidden = percent === null
    if (percent !== null) progressLabel.textContent = `${percent}%`
  }

  if (diagnostic) {
    diagnostic.hidden = !status.diagnostic
    diagnostic.textContent = status.diagnostic ?? ''
  }
  if (!actions) return
  actions.replaceChildren(
    ...status.actions.map((action) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = ACTION_LABELS[action]
      button.dataset.action = action
      button.addEventListener('click', async () => {
        button.disabled = true
        try {
          await window.dshDesktop.perform(action)
        } finally {
          button.disabled = false
        }
      })
      return button
    })
  )
}

if (platform) platform.textContent = `运行平台：${window.dshDesktop.platform}`
if (title) title.textContent = `正在启动 ${window.dshDesktop.productName}`
window.dshDesktop.onStatus(render)
