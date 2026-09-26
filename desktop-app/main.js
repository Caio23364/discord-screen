import { app, BrowserWindow, ipcMain, desktopCapturer, shell, globalShortcut } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Import native addon (ignore if fail during dev preview)
let audioMixer;
let videoCapture;
try {
  // Try to load built addons
  audioMixer = require('./build/Release/audio_mixer.node');
} catch (e) {
  console.warn('Native audio_mixer not loaded:', e.message);
}
try {
  videoCapture = require('./build/Release/video_capture.node');
} catch (e) {
  console.warn('Native video_capture not loaded:', e.message);
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // allow running WebRTC capturing
      backgroundThrottling: false,
    },
    title: 'Fabricio Desktop',
    autoHideMenuBar: true,
    backgroundColor: '#0b0f19'
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:1420');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-censor');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC: get_capture_sources
ipcMain.handle('get_capture_sources', async () => {
  const { screen } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
  const allDisplays = screen.getAllDisplays();
  
  return sources.map(source => {
    const isScreen = source.id.startsWith('screen');
    let height = 0;
    
    if (isScreen) {
      // Find matching display height
      const displayId = source.id.split(':')[1];
      const display = allDisplays.find(d => d.id.toString() === displayId);
      if (display) height = display.bounds.height;
      else height = allDisplays[0].bounds.height; // Fallback
    } else {
      if (audioMixer && audioMixer.getWindowHeight) {
        height = audioMixer.getWindowHeight(source.id);
      }
    }
    
    return {
      id: source.id,
      name: source.name,
      kind: isScreen ? 'screen' : 'window',
      height: height
    };
  });
});

// IPC: authenticate
ipcMain.handle('authenticate', async (_event, serverOrigin) => {
  const origin = (serverOrigin || 'http://localhost:3001').replace(/\/+$/, '');
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        const request = data.toString();
        
        if (request.includes('GET /favicon.ico')) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          return;
        }

        const match = request.match(/GET \/auth\?identity=([^\s]+)/);
        if (match) {
          const identity = match[1];
          const response = `HTTP/1.1 200 OK\r\n` +
                           `Content-Type: text/html; charset=utf-8\r\n` +
                           `Connection: close\r\n\r\n` +
                           `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Autenticado</title></head>` +
                           `<body style='background:#18181B;color:#F4F4F5;font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;'>` +
                           `<h2 style='color:#5865F2;'>Autenticação concluída!</h2>` +
                           `<p style='color:#A1A1AA;'>Pode fechar esta janela e voltar ao aplicativo.</p>` +
                           `<script>setTimeout(() => window.close(), 1500);</script></body></html>`;
          socket.write(response);
          socket.end();
          server.close();
          resolve(identity);
        }
      });
    });

    server.on('error', (e) => {
      reject(`Porta 13031 ocupada: ${e.message}`);
    });

    server.listen(13031, '127.0.0.1', () => {
      shell.openExternal(`${origin}/auth/desktop`);
      
      // Timeout de 2 min
      setTimeout(() => {
        if (server.listening) {
          server.close();
          reject('Tempo limite de autenticação esgotado.');
        }
      }, 120000);
    });
  });
});

// IPC: Audio Mixer Native
ipcMain.handle('start_audio_capture', async (event, options) => {
  if (!audioMixer) return { success: false, error: 'Módulo nativo não carregado.' };
  
  // We can pass process.pid to exclude the Electron app itself
  const pidsToExclude = [process.pid];
  
  return new Promise((resolve) => {
    try {
      // Sempre incluir o PID do próprio app (pidsToExclude) para evitar eco no modo legacy
      const finalOptions = options && options.mode ? {
        ...options,
        excludePids: pidsToExclude
      } : { mode: 'legacy', pids: pidsToExclude };

      audioMixer.startCapture((data) => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('audio-data', data);
          }
        } catch (err) {
          console.error('[audioMixer] Erro ao enviar audio-data:', err);
        }
      }, finalOptions);
      
      resolve({ success: true });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
});

ipcMain.handle('stop_audio_capture', async () => {
  if (!audioMixer) return { success: false };
  try {
    audioMixer.stopCapture();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get_pid_from_hwnd', async (event, hwndId) => {
  try {
    if (audioMixer && audioMixer.getPidFromHwnd) {
      return audioMixer.getPidFromHwnd(hwndId);
    }
    return 0;
  } catch (e) {
    console.error("Erro em get_pid_from_hwnd:", e);
    return 0;
  }
});

ipcMain.handle('get_window_height', async (event, hwndId) => {
  try {
    if (audioMixer && audioMixer.getWindowHeight) {
      return audioMixer.getWindowHeight(hwndId);
    }
    return 0;
  } catch (e) {
    console.error("Erro em get_window_height:", e);
    return 0;
  }
});

// IPC: Video Capture Native
ipcMain.handle('start_video_capture', async (event, options) => {
  if (!videoCapture) return { success: false, error: 'Native module video_capture not loaded.' };
  
  return new Promise((resolve) => {
    try {
      videoCapture.startVideoCapture(options || {}, (data) => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('video-data', data);
          }
        } catch (err) {
          console.error('[videoCapture] Error sending video-data:', err);
        }
      });
      resolve({ success: true });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
});

ipcMain.handle('stop_video_capture', async () => {
  if (!videoCapture) return { success: false };
  try {
    videoCapture.stopVideoCapture();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
