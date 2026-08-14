"use strict";
const platform = document.querySelector('#platform');
const title = document.querySelector('#title');
if (platform)
    platform.textContent = `运行平台：${window.dshDesktop.platform}`;
if (title)
    title.textContent = `正在启动 ${window.dshDesktop.productName}`;
