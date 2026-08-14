import { createReadStream } from 'node:fs'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { app } from 'electron'
import updaterPackage from 'electron-updater'

const { autoUpdater } = updaterPackage
const root = resolve('.artifacts/update-feed')
const eventLog = resolve('.artifacts/desktop-updater-events.log')
const log = async (message) => await appendFile(eventLog, `${new Date().toISOString()} ${message}\n`, 'utf8')
const withTimeout = async (promise, label, milliseconds = 60_000) => await Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds))
])
const server = createServer(async (request, response) => {
  try {
    const name = basename(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (!name) throw new Error('Missing artifact')
    const path = resolve(join(root, name))
    if (!path.startsWith(`${root}\\`)) throw new Error('Invalid path')
    const info = await stat(path)
    response.writeHead(200, {
      'content-length': info.size,
      'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream'
    })
    createReadStream(path).pipe(response)
  } catch {
    response.writeHead(404).end('Not found')
  }
})

const run = async () => {
  await mkdir(resolve('.artifacts'), { recursive: true })
  await writeFile(eventLog, '', 'utf8')
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing update server address')
  const feedUrl = `http://127.0.0.1:${address.port}/`
  const progress = []

  try {
  await log(`ready version=${app.getVersion()} feed=${feedUrl}`)
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.forceDevUpdateConfig = true
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  autoUpdater.logger = {
    info: (value) => void log(`info ${String(value)}`),
    warn: (value) => void log(`warn ${String(value)}`),
    error: (value) => void log(`error ${String(value)}`),
    debug: (value) => void log(`debug ${String(value)}`)
  }
  autoUpdater.on('checking-for-update', () => void log('event checking-for-update'))
  autoUpdater.on('update-available', (value) => void log(`event update-available ${value.version}`))
  autoUpdater.on('update-not-available', (value) => void log(`event update-not-available ${value.version}`))
  autoUpdater.on('error', (error) => void log(`event error ${error.stack ?? error.message}`))
  autoUpdater.on('download-progress', (value) => {
    progress.push(Math.round(value.percent))
    void log(`event progress ${value.percent.toFixed(2)}`)
  })
  await log('calling checkForUpdates')
  const check = await withTimeout(autoUpdater.checkForUpdates(), 'checkForUpdates')
  await log(`check resolved ${check?.updateInfo.version ?? 'none'}`)
  const downloadedFiles = check?.updateInfo.version === '0.1.1'
    ? await withTimeout(autoUpdater.downloadUpdate(), 'downloadUpdate', 120_000)
    : []
  await log(`download resolved ${downloadedFiles.length}`)
  const result = {
    currentVersion: app.getVersion(),
    discoveredVersion: check?.updateInfo.version ?? null,
    feedUrl,
    downloadedFiles,
    progressSamples: progress,
    downloaded: downloadedFiles.length > 0
  }
  await writeFile(
    resolve('.artifacts/desktop-update-check.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  )
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.currentVersion !== '0.1.0' || result.discoveredVersion !== '0.1.1' || !result.downloaded) {
    process.exitCode = 1
  }
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    await log('server closed; quitting')
    app.quit()
  }
}

app.whenReady().then(run).catch(async (error) => {
  await mkdir(resolve('.artifacts'), { recursive: true })
  await log(`fatal ${error.stack ?? error.message}`)
  process.exitCode = 1
  app.quit()
})
