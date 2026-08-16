const { cp, readFile, stat, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const archivesRoot = resolve('.artifacts', 'archives')
  const archivesManifest = JSON.parse(await readFile(join(archivesRoot, 'runtime-manifest.json'), 'utf8'))
  if (archivesManifest.schema !== 1 || !archivesManifest.version) {
    throw new Error('Bundled runtime archives manifest is missing or invalid')
  }
  const resources = resolve(context.appOutDir, 'resources')
  const copied = []
  for (const key of ['node', 'dsh']) {
    const entry = archivesManifest.archives?.[key]
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`Bundled runtime archive ${key} is missing from the manifest`)
    }
    const source = resolve(archivesRoot, entry.name)
    await stat(source)
    await cp(source, join(resources, entry.name), { force: true })
    copied.push(entry.name)
  }
  await writeFile(
    join(resources, 'runtime-manifest.json'),
    `${JSON.stringify(archivesManifest, null, 2)}\n`,
    'utf8'
  )
  await cp(resolve('build', 'icon.ico'), join(resources, 'icon.ico'), { force: true })
  process.stdout.write(`Bundled runtime archives copied: ${copied.join(', ')}\n`)
}
