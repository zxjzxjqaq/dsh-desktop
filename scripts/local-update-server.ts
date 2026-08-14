import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function createUpdateServer(rootDirectory: string): Server {
  const root = resolve(rootDirectory)
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      const name = basename(pathname)
      if (!name || name !== pathname.replace(/^\//, '')) {
        response.writeHead(404).end('Not found')
        return
      }
      const path = resolve(join(root, name))
      if (!path.startsWith(`${root}\\`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Not a file')
      response.writeHead(200, {
        'content-length': info.size,
        'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
        'cache-control': 'no-store'
      })
      createReadStream(path).pipe(response)
    } catch {
      response.writeHead(404).end('Not found')
    }
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const host = '127.0.0.1'
  const port = Number(process.env.DSH_UPDATE_PORT ?? 45873)
  const root = resolve(process.argv[2] ?? 'dist')
  createUpdateServer(root).listen(port, host, () => {
    process.stdout.write(`DSH Desktop update feed: http://${host}:${port}/\nServing: ${root}\n`)
  })
}
