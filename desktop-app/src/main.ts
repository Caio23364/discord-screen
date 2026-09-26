// @ts-ignore
import { createBroadcaster } from '../../shared/broadcaster.js';

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const headerSettingsBtn = document.getElementById('header-settings-btn');
  const footerSettingsBtn = document.getElementById('footer-settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const startShareBtn = document.getElementById('start-share-btn') as HTMLButtonElement | null;
  const emptyState = document.getElementById('empty-state');
  const previewVideo = document.getElementById('stream-preview') as HTMLVideoElement | null;
  
  const micToggleBtn = document.getElementById('mic-toggle-btn');
  const screenShareBtn = document.getElementById('screen-share-btn');
  const censorBtn = document.getElementById('censor-btn');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  
  const qualitySelectorBtn = document.getElementById('quality-selector-btn');
  const qualityModal = document.getElementById('quality-modal');
  const qualityDesc = document.getElementById('quality-desc');
  const currentQualityEl = document.getElementById('current-quality');
  const viewerCountEl = document.getElementById('viewer-count');
  const appTitle = document.getElementById('app-title');
  const appSubtitle = document.getElementById('app-subtitle');
  const debugRestartBtn = document.getElementById('debug-restart-btn');

  let selectedBitrate = 5_000_000;
  let selectedFps: number | string = 60;
  let selectedWidth = 1920;
  let selectedHeight = 1080;
  let autoBitrateEnabled = false;
  let dsrEnabled = false;
  let currentSelectedSource: any = null;
  
  // Instâncias ativas
  let currentIdentityToken: string | null = null;
  let activeStream: MediaStream | null = null;
  let activeBroadcaster: any = null;
  let isManualStop = false;
  const SERVER_ORIGIN = localStorage.getItem('server_origin') || 'http://localhost:3001';

  // Native Audio Ingestion
  let nativeAudioContext: AudioContext | null = null;
  let nativeAudioDestination: MediaStreamAudioDestinationNode | null = null;
  let nativeAudioScriptNode: ScriptProcessorNode | null = null;
  // --- Ring Buffer Otimizado para Áudio ---
  // Pré-aloca buffer de áudio para ~1 segundo a 48kHz estéreo (96000 floats)
  // Isso elimina o Garbage Collection pesado de criar milhares de arrays por segundo
  const RING_BUFFER_SIZE = 96000;
  const audioRingBuffer = new Float32Array(RING_BUFFER_SIZE);
  let ringWritePos = 0;
  let ringReadPos = 0;
  
  function pushToRingBuffer(chunk: Float32Array) {
    // Garante um número par de amostras para não inverter L e R
    const safeLength = chunk.length - (chunk.length % 2);
    for (let i = 0; i < safeLength; i += 2) {
      audioRingBuffer[ringWritePos] = chunk[i];
      audioRingBuffer[ringWritePos + 1] = chunk[i + 1];
      ringWritePos = (ringWritePos + 2) % RING_BUFFER_SIZE;
      
      if (ringWritePos === ringReadPos) {
        // Overflow: drop oldest stereo sample
        ringReadPos = (ringReadPos + 2) % RING_BUFFER_SIZE;
      }
    }
  }

  function readFromRingBuffer(outL: Float32Array, outR: Float32Array) {
    // Compensação de drift: se o buffer acumular mais de 100ms (9600 amostras a 48kHz),
    // adianta o ponteiro de leitura para manter o atraso em no máximo ~50ms
    const buffered = (ringWritePos - ringReadPos + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
    if (buffered > 9600) {
      ringReadPos = (ringWritePos - 4800 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
    }

    const framesToRead = outL.length;
    for (let i = 0; i < framesToRead; i++) {
      if (ringReadPos === ringWritePos) {
        // Underrun (silence)
        outL[i] = 0;
        outR[i] = 0;
      } else {
        outL[i] = audioRingBuffer[ringReadPos];
        outR[i] = audioRingBuffer[ringReadPos + 1];
        ringReadPos = (ringReadPos + 2) % RING_BUFFER_SIZE;
      }
    }
  }
  // ----------------------------------------


  // Toggle Settings Modal
  const toggleSettings = () => {
    if (settingsModal) {
      settingsModal.classList.toggle('hidden');
      if (settingsModal.classList.contains('hidden') && qualityModal) {
        qualityModal.classList.add('hidden');
      }
    }
  };

  headerSettingsBtn?.addEventListener('click', toggleSettings);
  footerSettingsBtn?.addEventListener('click', toggleSettings);
  
  // Toggle Quality Modal
  qualitySelectorBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    qualityModal?.classList.toggle('hidden');
  });

  const autoBitrateToggle = document.getElementById('auto-bitrate-toggle') as HTMLInputElement | null;
  const dsrToggle = document.getElementById('dsr-toggle') as HTMLInputElement | null;
  const discordMuteToggle = document.getElementById('discord-mute-toggle') as HTMLInputElement | null;

  // Load from localStorage
  const savedAutoBitrateStr = localStorage.getItem('auto_bitrate');
  const savedAutoBitrate = savedAutoBitrateStr === null ? true : savedAutoBitrateStr === 'true';
  const savedDsrStr = localStorage.getItem('dsr_enabled');
  const savedDsr = savedDsrStr === null ? false : savedDsrStr === 'true';
  const savedDiscordMute = localStorage.getItem('discord_mute') !== 'false'; // default true
  
  if (autoBitrateToggle) {
    autoBitrateToggle.checked = savedAutoBitrate;
    autoBitrateEnabled = savedAutoBitrate;
  }
  if (dsrToggle) {
    dsrToggle.checked = savedDsr;
    dsrEnabled = savedDsr;
  }
  if (discordMuteToggle) discordMuteToggle.checked = savedDiscordMute;

  autoBitrateToggle?.addEventListener('change', (e) => {
    autoBitrateEnabled = (e.target as HTMLInputElement).checked;
    localStorage.setItem('auto_bitrate', autoBitrateEnabled.toString());
    if (activeBroadcaster) {
      activeBroadcaster.setQuality({ autoBitrate: autoBitrateEnabled });
    }
  });

  dsrToggle?.addEventListener('change', (e) => {
    dsrEnabled = (e.target as HTMLInputElement).checked;
    localStorage.setItem('dsr_enabled', dsrEnabled.toString());
    if (activeBroadcaster) {
      activeBroadcaster.setQuality({ dsrEnabled: dsrEnabled });
    }
  });

  discordMuteToggle?.addEventListener('change', (e) => {
    localStorage.setItem('discord_mute', (e.target as HTMLInputElement).checked.toString());
  });

  // Debug Restart Button
  debugRestartBtn?.addEventListener('click', () => {
    if (activeBroadcaster && currentSelectedSource) {
      console.log('[DEBUG] Reiniciando transmissão manualmente (Debug)...');
      pararTransmissao();
      
      // Simulate clicking the source in the picker again to restart the flow
      const sourceElement = document.querySelector(`[data-id="${currentSelectedSource.id}"]`);
      if (sourceElement) {
        (sourceElement as HTMLElement).click();
      } else {
        // Fallback if not found in DOM
        startShareBtn?.click();
      }
    }
  });

  // Handle Quality Selection
  const qualityItems = document.querySelectorAll('.quality-modal .menu-item');
  
  const customW = document.getElementById('custom-w') as HTMLInputElement;
  const customH = document.getElementById('custom-h') as HTMLInputElement;
  const customFps = document.getElementById('custom-fps') as HTMLInputElement;
  const customBps = document.getElementById('custom-bps') as HTMLInputElement;
  const gamingModeCheck = document.getElementById('gaming-mode-check') as HTMLInputElement;
  const applyCustomBtn = document.querySelector('.apply-custom-btn') as HTMLButtonElement;

  function setQuality(index: number, save = true) {
    qualityItems.forEach((i, idx) => {
      if (idx === index) i.classList.add('selected');
      else i.classList.remove('selected');
    });
    
    if (save) localStorage.setItem('preset_index', index.toString());
    
    const item = qualityItems[index];
    if (!item) return;

    const title = item.querySelector('.menu-title')?.textContent;
    const desc = item.querySelector('.menu-desc')?.textContent;
    if (qualityDesc && title && desc) {
      qualityDesc.textContent = `${title} (${desc.split(' · ')[0]})`;
    }
    
    if (index === 0) {
      selectedBitrate = 15_000_000; selectedFps = 180; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 1) {
      selectedBitrate = 2_500_000; selectedFps = 30; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 2) {
      selectedBitrate = 5_000_000; selectedFps = 60; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 3) {
      selectedBitrate = 4_000_000; selectedFps = 60; selectedWidth = 1280; selectedHeight = 720;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 4) {
      selectedBitrate = 8_000_000; selectedFps = 60; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 5) {
      selectedBitrate = 10_000_000; selectedFps = 60; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = false; dsrEnabled = false;
    } else if (index === 6) {
      selectedBitrate = 5_000_000; selectedFps = 'auto'; selectedWidth = 1920; selectedHeight = 1080;
      autoBitrateEnabled = true; dsrEnabled = true;
    } else if (index === -1) {
      // Custom mode
      if (qualityDesc) qualityDesc.textContent = `Custom (${selectedWidth}x${selectedHeight})`;
      qualityItems.forEach(i => i.classList.remove('selected'));
      autoBitrateEnabled = false; dsrEnabled = false;
    }
    
    if (activeBroadcaster) {
      activeBroadcaster.setQuality({ 
        bitrate: selectedBitrate, 
        fps: selectedFps, 
        maxWidth: selectedWidth, 
        maxHeight: selectedHeight,
        autoBitrate: autoBitrateEnabled,
        dsrEnabled: dsrEnabled
      });
    }
  }

  qualityItems.forEach((item, index) => {
    item.addEventListener('click', () => {
      setQuality(index);
      qualityModal?.classList.add('hidden');
    });
  });

  applyCustomBtn?.addEventListener('click', () => {
    selectedWidth = parseInt(customW.value) || 1280;
    selectedHeight = parseInt(customH.value) || 720;
    selectedFps = parseInt(customFps.value) || 30;
    selectedBitrate = (parseInt(customBps.value) || 4) * 1_000_000;
    
    localStorage.setItem('preset_index', '-1');
    localStorage.setItem('custom_w', selectedWidth.toString());
    localStorage.setItem('custom_h', selectedHeight.toString());
    localStorage.setItem('custom_fps', selectedFps.toString());
    localStorage.setItem('custom_bps', (selectedBitrate / 1_000_000).toString());
    localStorage.setItem('gaming_mode', gamingModeCheck.checked.toString());
    
    setQuality(-1, false);
    qualityModal?.classList.add('hidden');
  });

  // Load custom values and preset
  const savedPreset = localStorage.getItem('preset_index');
  if (savedPreset) {
    const idx = parseInt(savedPreset);
    if (idx === -1) {
      selectedWidth = parseInt(localStorage.getItem('custom_w') || '1280');
      selectedHeight = parseInt(localStorage.getItem('custom_h') || '720');
      
      const savedFps = localStorage.getItem('custom_fps') || '30';
      selectedFps = savedFps === 'auto' ? 'auto' : parseInt(savedFps);
      
      selectedBitrate = parseFloat(localStorage.getItem('custom_bps') || '4') * 1_000_000;
      
      customW.value = selectedWidth.toString();
      customH.value = selectedHeight.toString();
      customFps.value = selectedFps.toString();
      customBps.value = (selectedBitrate / 1_000_000).toString();
      gamingModeCheck.checked = localStorage.getItem('gaming_mode') === 'true';
      setQuality(-1, false);
    } else {
      setQuality(idx, false);
    }
  } else {
    setQuality(3, false); // Default to Gaming 720p
  }

  // Close modal when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    
    // Close Quality Modal
    if (
      qualityModal && 
      !qualityModal.classList.contains('hidden') &&
      !qualityModal.contains(target) &&
      !qualitySelectorBtn?.contains(target)
    ) {
      qualityModal.classList.add('hidden');
    }

    // Close Settings Modal
    if (
      settingsModal && 
      !settingsModal.classList.contains('hidden') &&
      !settingsModal.contains(target) &&
      !headerSettingsBtn?.contains(target) &&
      !footerSettingsBtn?.contains(target) &&
      !qualityModal?.contains(target)
    ) {
      settingsModal.classList.add('hidden');
    }

    // Close Picker Modal if clicked outside
    if (
      pickerModal &&
      !pickerModal.classList.contains('hidden') &&
      !pickerModal.contains(target) &&
      !startShareBtn?.contains(target)
    ) {
      pickerModal.classList.add('hidden');
    }
  });

  const electronAPI = (window as any).electronAPI || {
    getCaptureSources: () => Promise.resolve([]),
    authenticate: (_serverOrigin?: string) => Promise.reject('Electron não disponível'),
    startAudioCapture: (_options?: any) => Promise.resolve({ success: false }),
    stopAudioCapture: () => Promise.resolve({ success: true }),
    getPidFromHwnd: (_hwndId: any) => Promise.resolve(0),
    getWindowHeight: () => Promise.resolve(0),
    onAudioData: () => {},
    onToggleCensor: () => {}
  };

  electronAPI.onAudioData((data: any) => {
    try {
      if (!data) return;
      
      let chunk: Float32Array;
      if (data.buffer && data.byteOffset !== undefined) {
        chunk = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      } else if (data instanceof Uint8Array) {
        const validLength = data.byteLength - (data.byteLength % 4);
        chunk = new Float32Array(data.buffer, data.byteOffset, validLength / 4);
      } else if (data instanceof ArrayBuffer) {
        const validLength = data.byteLength - (data.byteLength % 4);
        chunk = new Float32Array(data, 0, validLength / 4);
      } else {
        // Fallback for regular arrays
        const arr = new Uint8Array(data);
        const validLength = arr.byteLength - (arr.byteLength % 4);
        chunk = new Float32Array(arr.buffer, arr.byteOffset, validLength / 4);
      }
      
      pushToRingBuffer(chunk);
    } catch (err) {
      console.warn("Erro ao processar pacote de áudio IPC:", err);
    }
  });

  // Picker Modal Elements
  const pickerModal = document.getElementById('picker-modal');
  const closePickerBtn = document.getElementById('close-picker-btn');
  const screensGrid = document.getElementById('screens-grid');
  const windowsGrid = document.getElementById('windows-grid');
  const pickerTabs = document.querySelectorAll('.picker-tab');

  // Tab switching logic
  pickerTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      pickerTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      const targetId = (tab as HTMLElement).dataset.target;
      if (targetId === 'screens-grid') {
        screensGrid?.classList.remove('hidden');
        windowsGrid?.classList.add('hidden');
      } else {
        screensGrid?.classList.add('hidden');
        windowsGrid?.classList.remove('hidden');
      }
    });
  });

  closePickerBtn?.addEventListener('click', () => {
    pickerModal?.classList.add('hidden');
  });

  // Encerrar transmissão anterior
  function pararTransmissao() {
    isManualStop = true;
    if (activeBroadcaster) {
      activeBroadcaster.stop('Parado pelo usuário');
      activeBroadcaster = null;
    }
    
    // Parar capturas nativas
    electronAPI.stopAudioCapture().catch(() => {});
    electronAPI.stopVideoCapture().catch(() => {});
    
    if ((window as any)._onVideoDataRemover) {
      (window as any)._onVideoDataRemover();
      delete (window as any)._onVideoDataRemover;
    }

    if (activeStream) {
      activeStream.getTracks().forEach(t => t.stop());
      activeStream = null;
    }
    electronAPI.stopAudioCapture();
    
    // Limpeza completa do Web Audio (BUG-01, BUG-03)
    if (nativeAudioScriptNode) {
      nativeAudioScriptNode.disconnect();
      nativeAudioScriptNode = null;
    }
    if (nativeAudioDestination) {
      nativeAudioDestination.disconnect();
      nativeAudioDestination = null;
    }
    if (nativeAudioContext) {
      nativeAudioContext.close().catch(() => {});
      nativeAudioContext = null;
    }
    
    if (previewVideo) {
      previewVideo.srcObject = null;
    }
    emptyState?.classList.remove('hidden');
    if (appSubtitle) appSubtitle.textContent = 'Nenhuma tela selecionada';
    if (screenShareBtn) screenShareBtn.classList.remove('highlight');
    if (censorBtn) {
      censorBtn.style.display = 'none';
      censorBtn.classList.remove('active');
      isCensored = false;
    }
    
    // Reset timer (BUG-16)
    secondsElapsed = 0;
    if (timerEl) timerEl.textContent = '00:00';
  }

  // Start Share / Login button
  startShareBtn?.addEventListener('click', async () => {
    try {
      if (!currentIdentityToken) {
        const savedToken = localStorage.getItem('discord_identity_token');
        if (savedToken) {
          currentIdentityToken = savedToken;
          console.log('[DEBUG] Token de Identidade restaurado do localStorage');
        } else {
          startShareBtn.textContent = 'Autenticando...';
          startShareBtn.disabled = true;
          
          const rawToken: string = await electronAPI.authenticate(SERVER_ORIGIN);
          currentIdentityToken = decodeURIComponent(rawToken);
          localStorage.setItem('discord_identity_token', currentIdentityToken);
          console.log('[DEBUG] Token de Identidade recebido e salvo:', currentIdentityToken);
        }
      }
      
      startShareBtn.textContent = 'Carregando Janelas...';
      
      // Fetch capture sources
      const sources: any[] = await electronAPI.getCaptureSources();
      
      if (screensGrid) screensGrid.innerHTML = '';
      if (windowsGrid) windowsGrid.innerHTML = '';
      
      sources.forEach(source => {
        const item = document.createElement('div');
        item.className = 'picker-item';
        item.dataset.id = source.id;
        item.innerHTML = `
          <div class="picker-preview">
            <i class="fa-solid ${source.kind === 'screen' ? 'fa-desktop' : 'fa-window-maximize'}"></i>
          </div>
          <div class="picker-name" title="${source.name}">${source.name}</div>
        `;
        
        item.addEventListener('click', async () => {
          console.log('[DEBUG] Janela/Tela selecionada:', source.id, source.name);
          pickerModal?.classList.add('hidden');
          
          if (appTitle) appTitle.textContent = source.name;
          if (appSubtitle) appSubtitle.textContent = 'Iniciando captura...';

          // Update the stored source so we know what is transmitting
          currentSelectedSource = source;

          try {
            // Parar anterior se houver
            pararTransmissao();
            isManualStop = false; // Reset the flag after stopping the previous one

            // 1. Inicia a captura de tela
            console.log('[DEBUG] Solicitando getUserMedia com source:', source.id);
            
            // 1. Obtém as permissões do sistema operacional para aquela janela/tela
            let stream: MediaStream;
            
            if (source.kind === 'window') {
              // Para janela usando nosso módulo nativo de captura N-API, precisamos de uma stream falsa
              // apenas para alimentar a UI local e preencher o preview sem acionar o WebCodecs.
              stream = new MediaStream();
            } else {
              stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  mandatory: {
                    chromeMediaSource: 'desktop'
                  }
                } as any,
                video: {
                  mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    maxFrameRate: typeof selectedFps === 'number' ? selectedFps : 60,
                    maxWidth: selectedWidth,
                    maxHeight: selectedHeight
                  }
                } as any
              });
            }

            // Se for janela, usamos áudio nativo WASAPI isolado por processo
            if (source.kind === 'window') {
              let audioOptions: any = {};
              const pid = await electronAPI.getPidFromHwnd(source.id);
              if (pid && pid > 0) {
                console.log(`[DEBUG] Capturando áudio especificamente do PID: ${pid}`);
                if (appSubtitle) appSubtitle.textContent = `Compartilhando: ${source.name} (PID: ${pid})`;
                audioOptions = { mode: 'include', pids: [pid] };
              } else {
                if (appSubtitle) appSubtitle.textContent = `Compartilhando: ${source.name} (PID FALHOU)`;
              }
              await electronAPI.startAudioCapture(audioOptions);

              console.log('[DEBUG] Substituindo áudio do sistema pelo áudio isolado nativo...');
              // Remove o áudio padrão do Chromium
              stream.getAudioTracks().forEach(t => {
                t.stop();
                stream.removeTrack(t);
              });
              
              console.log('[DEBUG] Iniciando captura de vídeo acelerada por hardware N-API (DirectX 11 + MediaFoundation)...');
              await electronAPI.startVideoCapture({
                targetPid: pid,
                maxWidth: selectedWidth,
                maxHeight: selectedHeight,
                fps: selectedFps,
                bitrate: selectedBitrate,
                cursor: true
              });
              
              ringWritePos = 0; // Limpa fila
              ringReadPos = 0;
              
              if (!nativeAudioContext) {
                nativeAudioContext = new AudioContext({ sampleRate: 48000 });
              }
              if (nativeAudioContext.state === 'suspended') {
                await nativeAudioContext.resume();
              }
              
              if (!nativeAudioDestination) {
                nativeAudioDestination = nativeAudioContext.createMediaStreamDestination();
                nativeAudioScriptNode = nativeAudioContext.createScriptProcessor(2048, 0, 2);
                nativeAudioScriptNode.onaudioprocess = (e) => {
                  const outL = e.outputBuffer.getChannelData(0);
                  const outR = e.outputBuffer.getChannelData(1);
                  readFromRingBuffer(outL, outR);
                };
                nativeAudioScriptNode.connect(nativeAudioDestination);
              }
              
              // Adiciona a trilha de áudio nativo sintetizada ao stream
              const nativeTrack = nativeAudioDestination.stream.getAudioTracks()[0];
              if (nativeTrack) {
                stream.addTrack(nativeTrack);
              }
            } else {
              // Se for captura de tela inteira, o Chromium já captura o áudio do sistema diretamente;
              // Desliga qualquer captura WASAPI residual para não sobrecarregar IPC nem CPU
              await electronAPI.stopAudioCapture();
            }

            activeStream = stream;

            // 2. Exibe o Mini-Preview imediatamente
            if (previewVideo) {
              previewVideo.srcObject = stream;
              previewVideo.play().catch(e => console.warn('Play preview erro:', e));
            }
            emptyState?.classList.add('hidden');
            if (screenShareBtn) screenShareBtn.classList.add('highlight');
            if (censorBtn) censorBtn.style.display = 'block';

            // 3. Conecta à sala no servidor Discord
            console.log('[DEBUG] Buscando sala no servidor:', `${SERVER_ORIGIN}/api/rooms/call`);
            let roomData: any = null;
            try {
              const res = await fetch(`${SERVER_ORIGIN}/api/rooms/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: currentIdentityToken })
              });

              if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                  // Token inválido/expirado, limpa cache e força reautenticação na próxima tentativa
                  localStorage.removeItem('discord_identity_token');
                  currentIdentityToken = null;
                  throw new Error('Sessão expirada. Por favor, clique novamente para reautenticar.');
                }
                throw new Error(`Falha ao obter sala da call: ${res.status}`);
              }
              roomData = await res.json();
            } catch (err) {
              console.warn('[DEBUG] Falha ao consultar sala da call:', err);
              throw err;
            }

            // Se não encontrou uma sala fixa de call, cria/obtém sala normal
            if (!roomData?.shareUrl) {
              console.log('[DEBUG] Tentando obter ou criar sala aberta...');
              try {
                const res = await fetch(`${SERVER_ORIGIN}/api/rooms/create`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ identity: currentIdentityToken, name: source.name }),
                });
                if (res.ok) {
                  roomData = await res.json();
                }
              } catch (err) {
                console.error('[DEBUG] Falha ao criar sala:', err);
              }
            }

            if (roomData && roomData.shareUrl) {
              console.log('===========================================================');
              console.log('>>> [DEBUG] SALA CONECTADA COM SUCESSO!');
              console.log('>>> [DEBUG] ID da Sala:', roomData.roomId);
              console.log('>>> [DEBUG] URL DA SALA (SHARE URL):', roomData.shareUrl);
              console.log('===========================================================');

              if (appSubtitle) {
                appSubtitle.innerHTML = `Conectado à sala: <strong>${roomData.roomId}</strong><br/><a href="${roomData.shareUrl}" target="_blank" style="color:#5865F2;text-decoration:underline;font-size:11px;">${roomData.shareUrl}</a>`;
              }

              // Conectar o broadcaster WebCodecs/WebRTC
              const parsedUrl = new URL(roomData.shareUrl);
              const bToken = parsedUrl.searchParams.get('t');
              const wsProto = parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:';
              const wsUrl = `${wsProto}//${parsedUrl.host}/ws?t=${encodeURIComponent(bToken || '')}&fonte=tela`;

              console.log('[DEBUG] Conectando WebSocket WebRTC de transmissão:', wsUrl);

              activeBroadcaster = createBroadcaster({
                wsUrl,
                apiBase: SERVER_ORIGIN,
                bitrate: selectedBitrate,
                fps: selectedFps,
                maxWidth: selectedWidth,
                maxHeight: selectedHeight,
                autoBitrate: autoBitrateEnabled,
                dsrEnabled: dsrEnabled,
                nativeVideoSource: source.kind === 'window',
                audio: true,
                fonte: 'tela',
                streamPronto: stream,
                onStatus: (st: any) => {
                  console.log('[DEBUG Broadcaster status]:', st);
                  if (currentQualityEl) {
                    currentQualityEl.textContent = `${st.width}x${st.height} (${st.codec})`;
                  }
                },
                onStats: (stats: any) => {
                  if (viewerCountEl && stats.viewers !== undefined) {
                    let text = `${stats.viewers} Viewers`;
                    if (stats.effectiveBitrate && stats.baseBitrate && stats.effectiveBitrate < stats.baseBitrate) {
                      const effMbps = (stats.effectiveBitrate / 1_000_000).toFixed(1);
                      text += ` (Auto: ${effMbps}Mbps)`;
                    }
                    viewerCountEl.textContent = text;
                  }
                },
                onEnd: (reason: string) => {
                  console.log('[DEBUG] Broadcaster encerrou:', reason);
                  if (!isManualStop && currentSelectedSource) {
                    // Evitar loop de reconexão infinita se cair rápido demais (BUG-10)
                    const timeAlive = Date.now() - activeBroadcaster.startedAt;
                    if (timeAlive < 5000) {
                      console.warn('[DEBUG] Conexão caiu rápido demais. Abortando auto-reconnect.');
                      pararTransmissao();
                      if (appSubtitle) appSubtitle.textContent = 'Conexão falhou repetidamente';
                      return;
                    }
                    
                    console.log('[DEBUG] Conexão perdida. Tentando auto-reconnect silencioso em 3s...');
                    setTimeout(() => {
                      if (!isManualStop) {
                        const sourceElement = document.querySelector(`[data-id="${currentSelectedSource.id}"]`) as HTMLElement;
                        if (sourceElement) {
                          sourceElement.click();
                        } else {
                          // Se não achar o elemento, apenas chama pararTransmissao
                          pararTransmissao();
                        }
                      }
                    }, 3000);
                  } else {
                    pararTransmissao();
                  }
                },
                onAviso: (msg: string) => {
                  console.warn('[DEBUG Broadcaster aviso]:', msg);
                }
              } as any);

              await activeBroadcaster.start();
              console.log('[DEBUG] Transmissão no ar com sucesso para o Discord!');

              // Listener para quando o usuário parar a captura no SO
              stream.getVideoTracks()[0]?.addEventListener('ended', () => {
                console.log('[DEBUG] Compartilhamento encerrado pelo usuário no SO.');
                pararTransmissao();
              });

              if (source.kind === 'window') {
                // Inscreve a recepção nativa de NALUs para injetar direto no WebSockets via Broadcaster
                (window as any)._onVideoDataRemover = electronAPI.onVideoData((buffer: Uint8Array) => {
                  if (activeBroadcaster && typeof activeBroadcaster.injectNativeNalu === 'function') {
                    activeBroadcaster.injectNativeNalu(buffer);
                  }
                });
              }

            } else {
              console.error('[DEBUG] Não foi possível obter uma URL de sala válida.');
              if (appSubtitle) appSubtitle.textContent = 'Erro ao conectar à sala do servidor';
            }

          } catch (err: any) {
            console.error('[DEBUG] Erro na captura de tela:', err);
            emptyState?.classList.remove('hidden');
            if (appSubtitle) appSubtitle.textContent = 'Captura cancelada ou falhou';
          }
        });
        
        if (source.kind === 'screen') {
          screensGrid?.appendChild(item);
        } else {
          windowsGrid?.appendChild(item);
        }
      });
      
      pickerModal?.classList.remove('hidden');
      startShareBtn.textContent = 'Selecionar Outra Janela';
      startShareBtn.disabled = false;
      
    } catch (error) {
      console.error('Action failed:', error);
      startShareBtn.textContent = 'Erro. Tentar Novamente';
      startShareBtn.disabled = false;
    }
  });

  // Action Buttons state toggle
  micToggleBtn?.addEventListener('click', () => {
    micToggleBtn.classList.toggle('active');
    const isMuted = !micToggleBtn.classList.contains('active');
    
    // Altera o ícone baseado no estado
    const icon = micToggleBtn.querySelector('i');
    if (icon) {
      if (isMuted) {
        icon.classList.remove('fa-microphone');
        icon.classList.add('fa-microphone-slash');
      } else {
        icon.classList.remove('fa-microphone-slash');
        icon.classList.add('fa-microphone');
      }
    }
    
    // Muta as tracks de áudio da transmissão atual
    if (activeStream) {
      activeStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  });

  // Screen Share button (Main bottom bar)
  screenShareBtn?.addEventListener('click', () => {
    screenShareBtn.classList.toggle('highlight');
    if (screenShareBtn.classList.contains('highlight')) {
      emptyState?.classList.add('hidden');
    } else {
      emptyState?.classList.remove('hidden');
    }
  });

  let isCensored = false;
  censorBtn?.addEventListener('click', () => {
    isCensored = !isCensored;
    censorBtn.classList.toggle('active', isCensored);
    const icon = censorBtn.querySelector('i');
    if (icon) {
      if (isCensored) {
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
        censorBtn.classList.replace('danger-action', 'primary-action');
      } else {
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
        censorBtn.classList.replace('primary-action', 'danger-action');
      }
    }
    if (activeBroadcaster) {
      activeBroadcaster.toggleCensor(isCensored);
    }
  });

  if ((window as any).electronAPI?.onToggleCensor) {
    (window as any).electronAPI.onToggleCensor(() => {
      censorBtn?.click();
    });
  }

  // Fullscreen button
  fullscreenBtn?.addEventListener('click', async () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.warn('Erro ao entrar em tela cheia:', err);
      });
    } else {
      document.exitFullscreen().catch((err) => {
        console.warn('Erro ao sair de tela cheia:', err);
      });
    }
  });

  // Background control websocket para atualizar viewers dinamicamente
  async function initBackgroundControl() {
    const savedToken = localStorage.getItem('discord_identity_token');
    if (!savedToken) return;
    
    try {
      const res = await fetch(`${SERVER_ORIGIN}/api/rooms/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: savedToken })
      });
      if (res.ok) {
        const roomData = await res.json();
        if (roomData.shareUrl) {
           const url = new URL(roomData.shareUrl);
           const bToken = url.searchParams.get('t');
           const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
           const wsUrl = `${wsProto}//${url.host}/ws?t=${encodeURIComponent(bToken || '')}&modo=controle`;
           const ws = new WebSocket(wsUrl);
           ws.addEventListener('message', (e) => {
             if (typeof e.data !== 'string') return;
             try {
               const msg = JSON.parse(e.data);
               if (msg.type === 'state' && viewerCountEl && !activeBroadcaster) {
                  viewerCountEl.textContent = `${msg.viewers} Viewers`;
               }
             } catch {}
           });
        }
      }
    } catch(e) {
      console.warn('Falha no initBackgroundControl', e);
    }
  }

  initBackgroundControl();

  // Setup basic clock/timer
  let secondsElapsed = 0;
  const timerEl = document.getElementById('session-timer');
  setInterval(() => {
    if (!activeStream) return; // (BUG-16) Timer só roda se a transmissão estiver ativa
    secondsElapsed++;
    const m = Math.floor(secondsElapsed / 60).toString().padStart(2, '0');
    const s = (secondsElapsed % 60).toString().padStart(2, '0');
    if (timerEl) {
      timerEl.textContent = `${m}:${s}`;
    }
  }, 1000);
});
