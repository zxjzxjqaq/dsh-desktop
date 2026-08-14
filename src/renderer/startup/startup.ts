const platform = document.querySelector<HTMLParagraphElement>('#platform')
const title = document.querySelector<HTMLHeadingElement>('#title')

if (platform) platform.textContent = `运行平台：${window.dshDesktop.platform}`
if (title) title.textContent = `正在启动 ${window.dshDesktop.productName}`
