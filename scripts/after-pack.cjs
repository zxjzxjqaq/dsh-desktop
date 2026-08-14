const { cp, readFile, rm, stat } = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')

const dshVersion = '0.1.0-rc.6'

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const source = resolve('.artifacts', 'bundled-dsh', dshVersion)
  const resources = resolve(context.appOutDir, 'resources')
  const destination = resolve(resources, 'dsh-runtime', dshVersion)
  if (!destination.startsWith(`${resources}${sep}`)) throw new Error('DSH Runtime destination escaped resources')
  await stat(join(source, 'runtime-manifest.json'))
  await stat(join(source, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, force: true, dereference: true })
  const descriptor = JSON.parse(await readFile(join(destination, 'runtime-manifest.json'), 'utf8'))
  if (descriptor.version !== dshVersion || descriptor.files < 30_000) {
    throw new Error('Copied DSH Runtime manifest is incomplete')
  }
  await stat(join(destination, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  process.stdout.write(`Bundled DSH Runtime copied to ${destination} (${descriptor.files} files)\n`)
}
