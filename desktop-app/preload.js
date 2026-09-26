const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getCaptureSources: () => ipcRenderer.invoke('get_capture_sources'),
  authenticate: (serverOrigin) => ipcRenderer.invoke('authenticate', serverOrigin),
  startAudioCapture: (options) => ipcRenderer.invoke('start_audio_capture', options),
  stopAudioCapture: () => ipcRenderer.invoke('stop_audio_capture'),
  getPidFromHwnd: (hwndId) => ipcRenderer.invoke('get_pid_from_hwnd', hwndId),
  getWindowHeight: (hwndId) => ipcRenderer.invoke('get_window_height', hwndId),
  onAudioData: (callback) => {
    ipcRenderer.removeAllListeners('audio-data');
    ipcRenderer.on('audio-data', (_event, data) => callback(data));
  },
  startVideoCapture: (options) => ipcRenderer.invoke('start_video_capture', options),
  stopVideoCapture: () => ipcRenderer.invoke('stop_video_capture'),
  onVideoData: (callback) => {
    ipcRenderer.removeAllListeners('video-data');
    ipcRenderer.on('video-data', (_event, data) => callback(data));
  },
  onToggleCensor: (callback) => {
    ipcRenderer.on('toggle-censor', () => callback());
  }
});
