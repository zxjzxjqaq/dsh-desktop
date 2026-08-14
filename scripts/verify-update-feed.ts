import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createUpdateServer } from './local-update-server.js'

const host = '127.0.0.1'
const server = createUpdateServer(resolve('dist'))
await new Promise<void>((done) => server.listen(0, host, done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Update server address is unavailable')
const baseUrl = `http://${host}:${address.port}`

try {
  const manifest = await fetch(`${baseUrl}/latest.yml`)
  const manifestBody = await manifest.text()
  const installer = await fetch(`${baseUrl}/DSH-Desktop-0.1.0-Setup.exe`, { method: 'HEAD' })
  const traversal = await fetch(`${baseUrl}/..%2Fpackage.json`)
  const installerPath = resolve('dist/DSH-Desktop-0.1.0-Setup.exe')
  const installerInfo = await stat(installerPath)
  const result = {
    baseUrl,
    manifestStatus: manifest.status,
    manifestVersion: manifestBody.match(/version:\s*(\S+)/)?.[1] ?? null,
    installerStatus: installer.status,
    installerBytes: Number(installer.headers.get('content-length')),
    filesystemBytes: installerInfo.size,
    traversalStatus: traversal.status
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (
    result.manifestStatus !== 200 ||
    result.manifestVersion !== '0.1.0' ||
    result.installerStatus !== 200 ||
    result.installerBytes !== result.filesystemBytes ||
    result.traversalStatus !== 404
  ) {
    process.exitCode = 1
  }
} finally {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  )
}
