import { contextBridge } from 'electron';
import { PRODUCT_NAME } from '../shared/config.js';
contextBridge.exposeInMainWorld('dshDesktop', {
    productName: PRODUCT_NAME,
    platform: process.platform
});
