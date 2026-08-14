export const PRODUCT_NAME = 'DSH Desktop'
export const APP_ID = 'com.dsh.desktop'
export const DSH_HOST = '127.0.0.1'
export const DSH_PORT = 3080
export const DSH_URL = `http://${DSH_HOST}:${DSH_PORT}`
export const INITIAL_DSH_VERSION = '0.1.0-rc.6'
export const NODE_VERSION_RANGE = '^22.19.0 || >=24.0.0'
export const DSH_STARTUP_TIMEOUT_MS = 30_000
export const DSH_SHUTDOWN_TIMEOUT_MS = 5_000
export const DSH_HEALTH_MARKERS = ['<title>DeepSeek Harness</title>', '<div id="root"></div>'] as const
