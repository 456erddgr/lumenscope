'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  isDesktop: true,
  saveMedia: (name, arrayBuffer) => ipcRenderer.invoke('media:save', { name, data: arrayBuffer }),
  revealMedia: () => ipcRenderer.invoke('media:reveal'),
  info: () => ipcRenderer.invoke('app:info'),
  // 虚拟摄像头：由渲染进程把处理后的画面推给本机虚拟摄像头驱动
  vcamStart: () => ipcRenderer.invoke('vcam:start'),
  vcamStop: () => ipcRenderer.invoke('vcam:stop'),
  vcamState: () => ipcRenderer.invoke('vcam:state'),
  // 无边框窗口控制（页面自绘交通灯）
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMax: () => ipcRenderer.invoke('win:toggle-max'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMax: () => ipcRenderer.invoke('win:is-max'),
  onMaxChanged: (cb) => ipcRenderer.on('win:max-changed', (_e, v) => cb(v)),
});
