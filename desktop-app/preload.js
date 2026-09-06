const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getCaptureSources: () => ipcRenderer.invoke('get_capture_sources'),
  authenticate: () => ipcRenderer.invoke('authenticate'),
  startAudioCapture: (options) => ipcRenderer.invoke('start_audio_capture', options),
  stopAudioCapture: () => ipcRenderer.invoke('stop_audio_capture'),
  getPidFromHwnd: (hwndId) => ipcRenderer.invoke('get_pid_from_hwnd', hwndId),
  getWindowHeight: (hwndId) => ipcRenderer.invoke('get_window_height', hwndId),
  onAudioData: (callback) => {
    ipcRenderer.on('audio-data', (_event, data) => callback(data));
  }
});
