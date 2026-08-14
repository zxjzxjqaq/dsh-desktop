import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
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
                input: resolve('src/preload/startup.ts')
            }
        }
    },
    renderer: {
        root: resolve('src/renderer/startup'),
        build: {
            rollupOptions: {
                input: resolve('src/renderer/startup/index.html')
            }
        }
    }
});
