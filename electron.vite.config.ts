import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('src/main/app.ts')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          startup: resolve('src/preload/startup.ts'),
          shell: resolve('src/preload/shell.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          startup: resolve('src/renderer/startup/index.html'),
          shell: resolve('src/renderer/shell/index.html')
        }
      }
    }
  }
})
