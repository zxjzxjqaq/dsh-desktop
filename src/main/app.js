import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { PRODUCT_NAME } from '../shared/config.js';
let mainWindow = null;
function createWindow() {
    const window = new BrowserWindow({
        title: PRODUCT_NAME,
        width: 1180,
        height: 780,
        minWidth: 760,
        minHeight: 560,
        show: false,
        backgroundColor: '#0b0d10',
        webPreferences: {
            preload: join(__dirname, '../preload/startup.mjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    window.once('ready-to-show', () => window.show());
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    }
    else {
        void window.loadFile(join(__dirname, '../renderer/index.html'));
    }
    window.on('closed', () => {
        mainWindow = null;
    });
    return window;
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
}
else {
    app.on('second-instance', () => {
        if (!mainWindow)
            return;
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.focus();
    });
    void app.whenReady().then(() => {
        mainWindow = createWindow();
    });
    app.on('window-all-closed', () => app.quit());
}
