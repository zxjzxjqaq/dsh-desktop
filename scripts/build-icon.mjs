import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const source = resolve('build/icon.svg')
const target = resolve('build/icon.ico')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(
  sizes.map(async (size) =>
    await sharp(source).resize(size, size, { fit: 'contain' }).png().toBuffer()
  )
)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, await pngToIco(images))
process.stdout.write(`${target}\n`)
