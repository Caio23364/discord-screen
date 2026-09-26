# AGENTS.MD — Guia de Engenharia e Arquitetura do Sistema

> **Documento Oficial de Referência para Agentes de IA e Engenheiros de Software**  
> Este documento descreve minuciosamente todos os componentes, decisões arquiteturais, restrições de ambiente, protocolos de rede e diretrizes de desenvolvimento do projeto **discord-screen**.

---

## Sumário
1. [Visão Geral e Propósito](#1-visão-geral-e-propósito)
2. [O Desafio de Engenharia e a Abordagem Híbrida](#2-o-desafio-de-engenharia-e-a-abordagem-híbrida)
3. [Mapa Estrutural do Repositório](#3-mapa-estrutural-do-repositório)
4. [Estudo Detalhado dos Módulos](#4-estudo-detalhado-dos-módulos)
   - [4.1 Shared: Pipeline de Mídia e WebRTC](#41-shared-pipeline-de-mídia-e-webrtc)
   - [4.2 Client: Discord Activity e Web Frontend](#42-client-discord-activity-e-web-frontend)
   - [4.3 Server: Relay de Mídia, Sessões e Sinalização](#43-server-relay-de-mídia-sessões-e-sinalização)
   - [4.4 Desktop App: Aplicativo Electron e Áudio Nativo](#44-desktop-app-aplicativo-electron-e-áudio-nativo)
   - [4.5 Scripts: DevOps, Túneis e Smoke Tests](#45-scripts-devops-túneis-e-smoke-tests)
5. [Protocolo de Comunicação e Formato dos Pacotes](#5-protocolo-de-comunicação-e-formato-dos-pacotes)
6. [Regras de Ouro e Armadilhas (Gotchas Cruciais)](#6-regras-de-ouro-e-armadilhas-gotchas-cruciais)
7. [Diretrizes de Clean Code e Otimização de Performance](#7-diretrizes-de-clean-code-e-otimização-de-performance)
8. [Comandos de Operação e Testes](#8-comandos-de-operação-e-testes)

---

## 1. Visão Geral e Propósito

O **discord-screen** é uma plataforma de compartilhamento de tela de ultra-baixa latência (<100ms) projetada primariamente para rodar como uma **Discord Activity** (Embedded App dentro dos canais de voz do Discord), possuindo também suporte a acesso via navegador comum e aplicativo desktop dedicado.

### Diferenciais Principais
* **Transmissão Fluida a 60 FPS com Áudio de Sistema.**
* **Decodificação Quadro a Quadro:** Sem o atraso de 2 a 4 segundos típico de `MediaRecorder` ou containers HLS/DASH.
* **Tamanho Leve e Sem Instalação Obrigatória para Espectadores:** Quem assiste só precisa estar no canal de voz do Discord e abrir a Activity.
* **Resiliência de Rede Dupla:** Transmissão P2P WebRTC direta quando possível, com fallback instantâneo e invisível para WebSocket Relay caso haja bloqueio de NAT/firewall.
* **Resiliência de Quadros (Adaptive FPS):** Redução automática e imperceptível do FPS e do Bitrate sob congestionamento de rede, e retomada dinâmica para 60 FPS quando o sinal é limpo.
* **Qualidade Visual Configurável:** Renderizador WebGL customizado (estilo FSR) no cliente para aprimoramento adaptativo de nitidez e saturação das telas assistidas.
* **Ferramentas Co-op & QoL:** Apontador Laser sincronizado (Pings), Modo Picture-in-Picture nativo, Zoom e Pan livre pelo lado do cliente, e botão de Privacidade/Censura imediata para o transmissor.

---

## 2. O Desafio de Engenharia e a Abordagem Híbrida

A arquitetura do projeto foi forjada diretamente pelas restrições de segurança impostas pelo sandbox do Discord:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ RESTRIÇÕES CRÍTICAS DO DISCORD                                              │
│                                                                             │
│ 1. Sandboxing de Iframe:                                                    │
│    A Activity roda em iframe em https://<app-id>.discordsays.com.          │
│    O navegador nega getDisplayMedia() a menos que o iframe possua o         │
│    atributo allow="display-capture", o que o cliente do Discord NÃO provê.  │
│                                                                             │
│ 2. Ausência de WebRTC nativo garantido no Iframe:                           │
│    O Discord não fornece infraestrutura SFU para WebRTC dentro de           │
│    Activities de terceiros, limitando a comunicação oficial a WebSockets.   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### A Solução Híbrida Implementada

```
                                  [Servidor Node.js]
                             ┌───────────────────────────┐
                             │ WebSocket Relay / Router  │
                             │ (Piso de Entrega Seguro)  │
                             └───────▲───────────┬───────┘
                     Chunks Binários │           │ Chunks Binários
                     (TCP WebSocket) │           │ (TCP WebSocket)
                                     │           ▼
   [Transmissor]                                           [Espectador]
 ┌──────────────────────┐                                ┌──────────────────────┐
 │ Aba Externa (share)  │                                │ Discord Activity     │
 │ ou Desktop App       │                                │ (Iframe Sandboxed)   │
 │                      │        WebRTC P2P Direto       │                      │
 │ VideoEncoder HW      ├───────────────────────────────►│ VideoDecoder         │
 │ (getDisplayMedia OK) │       (SRTP / UDP Mesh)        │ WebGL2 / FSR Canvas  │
 └──────────────────────┘                                └──────────────────────┘
```

1. **Captura Fora da Sandbox:**
   A captura é iniciada em uma aba de navegador normal (`/share.html`) ou pelo aplicativo Desktop Electron. Nesse contexto aberto, o navegador autoriza `getDisplayMedia()` com áudio do sistema.
2. **WebCodecs (Sem Containers):**
   Os quadros de vídeo são codificados individualmente via `VideoEncoder` e os blocos de áudio via `AudioEncoder` (Opus). Cada quadro é despachado imediatamente sem esperar a criação de blocos de contêiner MP4/WebM.
3. **Transporte Híbrido (Relay + WebRTC Mesh Upgrade):**
   * **Piso (Relay):** O servidor Node.js recebe os buffers binários e os repassa para os espectadores via WebSocket sem abrir ou recodificar o payload.
   * **Teto (WebRTC):** Em paralelo, espectador e transmissor negociam uma conexão P2P WebRTC direta. Se a conexão fechar e o primeiro quadro for recebido pelo `<video>`, o espectador desliga o relay para economizar banda do servidor. Se houver falha de NAT, o relay continua tocando sem interrupção.

---

## 3. Mapa Estrutural do Repositório

```
discord-screen/
├── client/                     # Frontend da Discord Activity
│   ├── src/
│   │   ├── main.js             # Controlador principal da Activity (DOM, SDK, Rede)
│   │   ├── player.js           # Decodificador de vídeo WebCodecs + Shaders WebGL/2D
│   │   ├── audio.js            # Decodificador de áudio WebCodecs + Web Audio API
│   │   ├── style.css           # Design system e folhas de estilo da Activity
│   │   └── player.test.js      # Testes unitários do relógio e ritmo do player
│   ├── index.html              # HTML base da Activity
│   ├── vite.config.js          # Configuração de build do Vite para o cliente
│   └── package.json            # Dependências do frontend
├── server/                     # Servidor Node.js (API REST, WebSocket, Relay)
│   ├── index.js                # Ponto de entrada: Express, WebSocket Server, OAuth
│   ├── rooms.js                # Gestão de salas em memória, relay e backpressure
│   ├── tokens.js               # Assinatura e verificação de tokens HMAC-SHA256
│   ├── system.js               # Telemetria de CPU, RAM e Event Loop
│   ├── admin.js                # Agregação de métricas para o painel administrativo
│   ├── public/                 # Páginas estáticas servidas fora do Discord
│   │   ├── share.html / .js    # Aba de captura do transmissor
│   │   ├── admin.html / .js    # Painel de métricas em tempo real
│   │   └── termos.html / priv. # Políticas obrigatórias para o portal do Discord
│   ├── *.test.js               # Testes do servidor (rotas, limpeza de salas, ws)
│   └── package.json            # Dependências do backend
├── shared/                     # Código compartilhado entre transmissor e cliente
│   ├── broadcaster.js          # Pipeline de captura, codificação e controle WebRTC
│   ├── broadcaster.test.js     # Testes da máquina de estados do broadcaster
│   ├── rtc.js                  # Abstrações e negociações de WebRTC PeerConnection
│   └── rtc.test.js             # Testes de conectividade WebRTC
├── desktop-app/                # Aplicativo Windows Electron alternativo
│   ├── native/                 # Módulo C++ nativo (WASAPI Loopback para áudio)
│   ├── main.js / preload.js    # Processo principal e ponte segura IPC
│   ├── src/                    # Frontend em TypeScript + Vite
│   └── package.json            # Configuração e build com electron-builder
├── scripts/                    # Utilitários de linha de comando e automação
│   ├── configurar.mjs          # Assistente interativo de setup do .env
│   ├── tunel.mjs / cloudflared # Gerenciamento de túneis HTTPS locais
│   ├── smoke*.mjs              # Testes de fumaça ponta a ponta sem browser
│   └── dev.mjs                 # Orquestrador de desenvolvimento local
├── docs/                       # Documentação legada e guias de infraestrutura
├── tests/                      # Suítes de testes complexos (E2E)
│   └── e2e/                    # Testes ponta a ponta com Playwright
│       └── sandbox.spec.js     # Validação de interface mockando o iframe do Discord
├── eslint.config.js            # Configuração do ESLint Flat Config
├── vitest.config.js            # Configuração de testes automatizados com Vitest
└── package.json                # Workspace raiz e scripts globais
```

---

## 4. Estudo Detalhado dos Módulos

### 4.1 Shared: Pipeline de Mídia e WebRTC

#### [shared/broadcaster.js](file:///d:/discord-screen/shared/broadcaster.js)
Este é o módulo central de transmissão, executado tanto na aba de captura (`/share.html`) quanto dentro do desktop app ou na própria Activity (quando o navegador permite).

* **Seleção Dinâmica de Codecs (Prioridade VP8):**
  A função `candidatos(width, height, fps)` **prioriza sempre o codec `vp8`** como padrão, já que o Chromium embutido no Discord Activity frequentemente falha na decodificação de H.264 High Profile a 1080p (gerando "tela infinita" ao falhar em processar keyframes). O cálculo exato do perfil e nível H.264 baseado na contagem de macroblocos (`High`, `Main`, `Baseline`) e o VP09 são mantidos apenas como fallbacks secundários.
* **Alinhamento de Ritmo e Grade de FPS (`proximaMarca`):**
  Evita micro-tremores na captura a 60 FPS. Se a origem entrega quadros com pequenas variações temporais (ex: 14ms e 18ms em vez de 16.6ms cravados), o broadcaster calcula o encaixe na grade temporal e descarta quadros redundantes sem descompassar o relógio.
* **Controle de Congestionamento e Backpressure do Encoder:**
  Se a fila interna do `VideoEncoder` ultrapassar 2 quadros, o broadcaster aciona o modo `afogado` e descarta quadros na entrada para impedir o acúmulo irreversível de latência. O laço `statsTimer` observa esses engasgos e os buffers do WebSocket para realizar **Dynamic Bitrate Allocation (DBA)** e **Adaptive FPS**, reduzindo instantaneamente a qualidade para 30 FPS até a rede estabilizar, quando retoma para os originais 60 FPS.
* **P2P Mesh Signaling:**
  Mantém um `Map<peerId, RTCPeerConnection>` indexado por espectadores. Quando um espectador solicita conexão direta, o broadcaster gera o SDP Offer, anexa as faixas locais (`stream.getTracks()`) e despacha a oferta via envelope de controle JSON pelo WebSocket.

#### [shared/rtc.js](file:///d:/discord-screen/shared/rtc.js)
Isola as configurações do WebRTC.
* Configura servidores STUN públicos (`stun:stun.l.google.com:19302`) e servidores TURN configurados via variáveis de ambiente.
* Estabelece as preferências de degradação:
  * Tela: `degradationPreference: 'maintain-resolution'` (texto legível prevalece sobre framerate).
  * Câmera: `degradationPreference: 'maintain-framerate'` (fluidez visual prevalece sobre resolução).

---

### 4.2 Client: Discord Activity e Web Frontend

#### [client/src/player.js](file:///d:/discord-screen/client/src/player.js)
Responsável por decodificar os quadros de vídeo brutos e renderizá-los com suavidade temporal.

* **Jitter Buffer Adaptativo (`BUFFER_MS = 80`):**
  TCP e internet pública entregam pacotes em rajadas. Desenhar um quadro assim que ele chega causa solavancos. O player enfileira os quadros e os reproduz rigorosamente 80ms após o instante em que foram capturados, restaurando a cadência nativa.
* **Pipeline de Renderização Híbrido (WebGL2 + Fallback 2D):**
  * **WebGL2:** Utiliza shaders customizados GLSL ES 3.0 com um algoritmo leve de contraste adaptativo / nitidez (estilo FSR / CAS), ajustável via uniform `u_sharpness`, além de saturação personalizada `u_saturation`.
  * **Fallback Canvas 2D:** Se o contexto WebGL2 falhar ou o navegador for incompatível, o player utiliza o contexto `2d` com `desynchronized: true`.
* **Gerenciamento Estrito de Memória de GPU:**
  Cada quadro decodificado entrega uma instância de `VideoFrame`. É **obrigatório** chamar `frame.close()` imediatamente após `drawImage` ou `texImage2D`. Deixar de fechar um único `VideoFrame` vaza memória de vídeo e derruba a aba do navegador em poucos segundos.
* **Reesincronização Invisível de Keyframes:**
  Quando o decodificador falha ou trava, o jitter buffer despacha requisições periódicas (`need-keyframe`) limitadas a cada 2 segundos. O renderizador mantém o último quadro intacto (`preserveFrame: true`) em tela enquanto recupera o contexto silenciosamente, sem causar "tela preta".

#### [client/src/audio.js](file:///d:/discord-screen/client/src/audio.js)
Responsável pelo pipeline de áudio via Web Audio API.
* Decodifica pacotes Opus diretamente via `AudioDecoder`.
* Mantém um colchão de segurança de áudio de 80ms através de agendamento preciso no `AudioContext.currentTime`.
* Se a latência acumulada ultrapassar 320ms, o buffer é cortado sumariamente para restabelecer o sincronismo com a transmissão ao vivo.

#### [client/src/main.js](file:///d:/discord-screen/client/src/main.js)
Controlador geral da aplicação cliente.
* **Integração com Discord SDK:** Inicializa o SDK, executa `sdk.commands.authorize()` com escopos `['identify', 'guilds']`, e envia o código para troca no servidor.
* **Prefixagem de Rotas `/.proxy`:** Identifica se está rodando dentro do iframe do Discord (`inDiscord = params.has('frame_id')`) e prefixa todas as chamadas HTTP e conexões WS com `/.proxy`.
* **Assistir é Opt-In:** Para poupar a banda de saída do servidor e o processamento do cliente, transmissões não solicitadas não recebem fluxo de bytes. O cliente envia mensagens `{ type: 'watch', slot }` e `{ type: 'unwatch', slot }`.
* **Reconciliação de DOM sem Destruição (`patchChildren` + `tileCache`):**
  A grade de participantes e a barra lateral nunca destroem nós existentes desnecessariamente. A função `patchChildren(container, newNodes)` compara os `childNodes` atuais com os desejados, removendo apenas nós ausentes e inserindo/reordenando os demais via `insertBefore`. Os tiles são cacheados em `tileCache` (Map indexado por `${userId}-${slot}-${palco}-${semVideo}`), que compara um snapshot JSON do estado visível (`stateStr`) e retorna o mesmo `HTMLElement` se nada mudou — evitando reconstrução de canvas, vídeos e decoders WebGL a cada atualização de estado. Nós de mídia (`<canvas>` / `<video>`) são reanexados automaticamente caso tenham sido deslocados entre containers.
* **Gestão de Áudio Individual:** Permite regular o volume geral do dock e o volume individual de cada participante, persistindo as preferências no `localStorage`.
* **Ferramentas de Interação Co-op:** Suporta envio e renderização de Pings (apontador laser) via clique na tela de vídeo (`msg.type === 'ping'`), com cálculo de bounding box compensando black bars.
* **QoL (Quality of Life):** Implementa o botão nativo de Picture-in-Picture (`documentPictureInPicture` ou `captureStream` — exclusivo para abas abertas fora do Discord) e transformações CSS (`transform: scale(...)`) para Zoom & Pan Livre interceptando eventos de `wheel` e `pointermove`.

---

### 4.3 Server: Relay de Mídia, Sessões e Sinalização

#### [server/index.js](file:///d:/discord-screen/server/index.js)
Servidor HTTP e WebSocket construído sobre Express e `ws`.
* **Desarme de Headers de Frame para Discord:**
  Injeta cabeçalhos para viabilizar a exibição no iframe do Discord:
  ```javascript
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com");
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Cloudflare-Frame-Options', 'allow');
  ```
* **Strip de Prefixo `/.proxy`:** Middleware que remove o prefixo injetado pelo proxy do Discord para que as rotas internas funcionem de forma transparente.
* **Validação de Presença e Autenticação de Voz:**
  Confirma se o usuário logado está presente no canal de voz especificado utilizando o token de bot (`DISCORD_BOT_TOKEN`), associando a instância da sala ao canal (`call-<channelId>`).

#### [server/rooms.js](file:///d:/discord-screen/server/rooms.js)
Coração do roteamento de mídia e isolamento de sessões em memória.
* **Roteamento de Chunks Sem Abertura de Buffer:**
  Ao receber pacotes binários do transmissor, o servidor inspeciona apenas os 2 primeiros bytes (`[slot][tipo]`) e despacha o buffer intacto para os WebSockets dos espectadores inscritos naquele slot.
* **Proteção contra Decoder Frio (Keyframe Enforcement):**
  O servidor sabe quais espectadores já receberam um keyframe. Se um espectador acabou de entrar, pacotes delta (tipo 2) são descartados até que um novo keyframe (tipo 1) seja entregue. Caso demore, o servidor emite uma mensagem `{ type: 'need-keyframe' }` para o transmissor.
* **Gerenciamento de Backpressure de Socket:**
  Verifica `ws.bufferedAmount`. Se um espectador com conexão degradada ultrapassar `MAX_BUFFERED_BYTES` (512 KB), os quadros são descartados para essa conexão para proteger o consumo de memória RAM do processo Node.js.
* **Contadores de Tráfego com Bucketing por Segundo:**
  A função `recordTraffic(counter, direction, bytes)` acumula bytes em variáveis locais (`_currentReceived`, `_currentTransmitted`, `_currentDropped`) e só descarrega no `Map<second, bucket>` quando o relógio de segundos vira. A poda de buckets antigos (>60s) roda no máximo uma vez por segundo, nunca por chunk. `trafficSnapshot(counter, windowSeconds)` lê tanto os buckets já gravados quanto o segundo corrente, garantindo dados em tempo real para o painel administrativo sem sobrecarregar o Event Loop.
* **Limite de Salas por Instância (`MAX_ROOMS_PER_INSTANCE = 5`):**
  Cada instância de Activity (canal de voz) pode ter no máximo 5 salas abertas simultaneamente. Tentativas de criar além do teto retornam erro 400. Testes que criam múltiplas salas devem usar instâncias separadas para evitar atingir esse limite.
* **Sweeper Automático de Limpeza:**
  Varre as salas a cada 2 segundos. Salas vazias são encerradas após o período de carência (`EMPTY_GRACE_MS = 30s`). Transmissões de usuários que saíram da atividade são derrubadas após `SEM_PRESENCA_MS = 10s`.

#### [server/tokens.js](file:///d:/discord-screen/server/tokens.js)
Módulo zero-dependency para criação de tokens seguros usando `crypto.createHmac('sha256', secret)`.
* Emite tokens no formato `base64url(payload).base64url(signature)`.
* Escopos estritos: `identity` (acesso básico), `viewer` (leitura de sala específica), `broadcaster` (transmissão de sala específica), e `oauth-state` (proteção CSRF no login).

---

### 4.4 Desktop App: Aplicativo Electron e Áudio Nativo

Localizado em `desktop-app/`, é uma aplicação Electron para Windows voltada a compartilhamento de tela com captura exclusiva de áudio de janelas.
* **Addon C++ Nativo (`desktop-app/native/audio_mixer.cpp`):**
  Interage diretamente com as APIs do Windows (WASAPI Loopback Capture) via `node-addon-api`. Permite capturar o som emitido especificamente por um executável de jogo ou aplicativo, evitando capturar o próprio áudio da chamada do Discord. O ciclo de vida da ThreadSafeFunction e instâncias COM é estritamente controlado via `Release()` para prevenir memory leaks de RAM (que poderiam engasgar o app).
* **Isolamento de Processos Electron:**
  Utiliza `contextIsolation: true`, scripts de `preload.js` e comunicação assíncrona estrita via IPC. Inclui atalhos globais (como `Ctrl+Shift+C` para privacidade/censura imediata).

---

### 4.5 Scripts: DevOps, Túneis e Testes E2E/Smoke

* **[scripts/configurar.mjs](file:///d:/discord-screen/scripts/configurar.mjs):** Assistente interativo que orienta a criação do aplicativo no portal do Discord, gera segredos criptográficos aleatórios e grava o `.env`.
* **[scripts/tunel.mjs](file:///d:/discord-screen/scripts/tunel.mjs):** Baixa o binário do `cloudflared` caso necessário e estabelece um túnel HTTPS público para testes imediatos da Activity sem necessidade de configurar VPS ou portas de roteador.
* **[scripts/smoke.mjs](file:///d:/discord-screen/scripts/smoke.mjs):** Suíte de testes ponta a ponta sem browser que simula múltiplos transmissores e espectadores WebSockets, testando autenticação, senhas, keyframes e isolamento de salas. Utiliza instâncias separadas (`CANAL_A` para testes de API de salas, `CANAL_B` para testes de relay) para não exceder o teto de `MAX_ROOMS_PER_INSTANCE`. Requer `VITEST=1` ou `NODE_ENV !== 'production'` para contornar o rate limiter do Express. Variáveis `SMOKE_BASE` e `SMOKE_WS` apontam para o servidor local (padrão `localhost:3001`).
* **[scripts/stress.mjs](file:///d:/discord-screen/scripts/stress.mjs):** Ferramenta de load testing. Instancia bots simulados via WebSocket para testar o backpressure do processo Node.js e consumo de CPU, validando suporte massivo de espectadores consumindo mídia simultaneamente.
* **[tests/e2e/sandbox.spec.js](file:///d:/discord-screen/tests/e2e/sandbox.spec.js):** Suíte E2E automatizada baseada em Playwright. Utiliza a página `server/public/sandbox.html` para mockar o ambiente isolado do Discord (SDK, mock de popups e injeção de parâmetros). Garante a funcionalidade do frontend (interface, participantes) sem exigir interação manual no portal da Discord.

---

## 5. Protocolo de Comunicação e Formato dos Pacotes

### 5.1 Pacotes de Mídia Binários (WebSocket)

Todos os dados de streaming são transmitidos como arrays de bytes sem containers adicionais:

```
┌──────────┬──────────┬──────────────────────────┬──────────────────────────┬──────────────────────────┐
│ Offset 0 │ Offset 1 │ Offset 2..9 (8 Bytes)    │ Offset 10..17 (8 Bytes)  │ Offset 18..N             │
├──────────┼──────────┼──────────────────────────┼──────────────────────────┼──────────────────────────┤
│ Slot ID  │ Tipo     │ Timestamp de Captura     │ Timestamp de Envio       │ Payload Codificado       │
│ (Uint8)  │ (Uint8)  │ (Float64 BigEndian, µs)  │ (Float64 BigEndian, ms)  │ (H.264 / VP8 / Opus raw) │
└──────────┴──────────┴──────────────────────────┴──────────────────────────┴──────────────────────────┘
```

#### Tabela de Tipos (Offset 1)
| Código | Identificador | Descrição | Tratamento pelo Servidor |
| :---: | :--- | :--- | :--- |
| `1` | `KEYFRAME` | Quadro de vídeo completo I-Frame | Envia a espectadores ativos ou que aguardavam início |
| `2` | `DELTA` | Quadro de vídeo incremental P-Frame | Só envia a quem já recebeu o keyframe inicial |
| `3` | `AUDIO` | Bloco de áudio comprimido em Opus | Repassa imediatamente a todos os inscritos no slot |

### 5.2 Mensagens de Controle (JSON via WebSocket)

#### Servidor → Todos
* `{ type: 'ping', slot: number, userId: string, x: number, y: number }`: Repassa o ping solicitado para todos os clientes ativos (incluindo o transmissor e os espectadores), a fim de renderizar a animação do apontador laser.

#### Transmissor → Servidor
* `{ type: 'start' }`: Anuncia o início do fluxo de mídia.
* `{ type: 'config', config }`: Entrega o `decoderConfig` de vídeo (codec, largura, altura, colorSpace, description).
* `{ type: 'audio-config', config }`: Entrega o `decoderConfig` de áudio (codec, sampleRate, numberOfChannels).
* `{ type: 'rtc', peer: string, payload }`: Repassa oferta, resposta ou candidatos ICE para um espectador específico.
* `{ type: 'stop', reason }`: Encerra a transmissão.

#### Espectador → Servidor
* `{ type: 'ping-req', slot: number, x: number, y: number }`: Solicita o envio de um ping/laser nas coordenadas X/Y proporcionais (0.0 a 1.0).
* `{ type: 'watch', slot: number }`: Solicita recebimento dos bytes daquele slot.
* `{ type: 'unwatch', slot: number }`: Cancela recebimento de bytes do slot.
* `{ type: 'need-keyframe', slot: number }`: Solicita ao transmissor a geração forçada de um novo keyframe.
* `{ type: 'rtc', slot: number, payload }`: Envia sinalização WebRTC para o transmissor do slot.
* `{ type: 'rtc-ativo', slot: number, on: boolean }`: Notifica se a conexão P2P assumiu com sucesso a exibição do vídeo.

---

## 6. Regras de Ouro e Armadilhas (Gotchas Cruciais)

Ao realizar modificações neste repositório, **os seguintes pontos devem ser rigorosamente respeitados**:

### ⚠️ 1. Fechamento de VideoFrame (`frame.close()`)
Em [client/src/player.js](file:///d:/discord-screen/client/src/player.js), toda instância de `VideoFrame` alocada pelo `VideoDecoder` reserva texturas diretas na memória de vídeo (GPU). **Nunca remova a chamada `frame.close()`**. Deixar de desalocar um único frame causa acúmulo invisível de memória e travamento forçado da aba do navegador em poucos segundos.

### ⚠️ 2. Suporte Obrigatório ao Canvas 2D
O player nunca deve depender exclusivamente de WebGL2. Ambientes de teste (jsdom), máquinas virtuais sem aceleração de hardware e dispositivos com drivers legados recorrem ao contexto 2D (`canvas.getContext('2d')`). O método `start()` e o método `draw()` devem sempre manter a rota de fallback 2D operacional.

### ⚠️ 3. Prefixo de Proxy do Discord (`/.proxy`)
Qualquer chamada feita pela Activity dentro do Discord (seja `fetch` para rotas de API ou conexões WebSocket) **deve** ser prefixada com `/.proxy`. Sem esse prefixo, o Discord retorna 404 e a aplicação entra em loop infinito de carregamento (*"Está demorando..."*).

### ⚠️ 4. Cabeçalhos de Segurança para Iframes
O servidor Express nunca deve enviar headers restritivos padrão como `X-Frame-Options: SAMEORIGIN` ou `Content-Security-Policy: frame-ancestors 'self'`. Os headers em [server/index.js](file:///d:/discord-screen/server/index.js) devem sempre permitir a cadeia de domínios do Discord (`discord.com` e `*.discordsays.com`), mantendo `X-Frame-Options: ALLOWALL` para anular filtros de proxies intermediários.

### ⚠️ 5. Sincronia entre Constantes de Limpeza e Testes
A constante `EMPTY_GRACE_MS` em [server/rooms.js](file:///d:/discord-screen/server/rooms.js) dita o tempo de sobrevivência de salas vazias. Ao alterar este valor, sincronize obrigatoriamente as constantes `CARENCIA` em [server/rooms-limpeza.test.js](file:///d:/discord-screen/server/rooms-limpeza.test.js) para evitar falhas de fake timers nos testes automatizados. Da mesma forma, os testes de tráfego em `rooms-limpeza.test.js` dependem de `vi.advanceTimersByTime(1000)` para forçar o flush dos acumuladores locais de `recordTraffic` para o Map de buckets — sem esse avanço, o bucket do segundo corrente não é materializado e a asserção falha.

### ⚠️ 6. Prevenção de Requisições N+1 na API do Discord
Ao resolver canais de voz de usuários com o bot em [server/index.js](file:///d:/discord-screen/server/index.js), **nunca** itere por todos os servidores do bot disparando requisições REST paralelas. Limite as buscas ao servidor específico (`guildId`) ou utilize cache com throttling para evitar banimento por Rate Limit (HTTP 429).

### ⚠️ 7. Limite de Salas por Instância no Smoke Test
O servidor impõe `MAX_ROOMS_PER_INSTANCE = 5`. O smoke test (`scripts/smoke.mjs`) cria múltiplas salas durante a execução (Sala de Alice, Sala Aberta, Sala Trancada, Cofre, etc.). Testes que precisam de salas adicionais (como os de relay) **devem** usar uma instância separada (`CANAL_B`) para não estourar o teto e receber erro `400`. Nunca concentre todas as salas de teste numa única instância.

### ⚠️ 8. Isolamento de Contexto E2E (Playwright)
A suíte E2E no Playwright roda os testes carregando a `sandbox.html`. Dado que o backend consolida memória de instâncias via URL, **sempre utilize o ID de instância randômico** (`Date.now()`) no query parameter para que um teste não interfira nas salas e usuários do outro. Recomenda-se modo `serial` ao emular cenários extensos de UI para garantir estabilidade, já que o proxy é compartilhado no processo backend executado paralelamente.

### ⚠️ 9. Cross-Origin em Testes Locais e PUBLIC_ORIGIN
O servidor Node utiliza a variável de ambiente `PUBLIC_ORIGIN` (geralmente apontando para o túnel, ex: `https://meu-tunel.trycloudflare.com`) para gerar a URL da aba de captura (`shareUrl`). Ao rodar testes E2E (`npm run test:e2e`) sem o túnel rodando em paralelo localmente, ou em ambientes isolados, a aba de captura externa vai tentar navegar para o túnel remoto, causando falhas de *timeout* nos testes, pois a conexão WebSocket "vaza" para fora do ambiente de teste e atinge a VPS remota ou falha se a URL estiver inacessível. **Solução:** sempre execute a suíte de testes com `PUBLIC_ORIGIN='http://localhost:3001'` (ou a porta correspondente configurada em `PLAYWRIGHT_TEST_BASE_URL`) para manter a resolução DNS apontando restritamente para o processo local instanciado.

---

## 7. Diretrizes de Clean Code e Otimização de Performance

### A. Modularização de Arquivos Monolíticos
O código atual possui arquivos extensos (`main.js`, `index.js`, `broadcaster.js`). Toda nova funcionalidade deve ser extraída em submódulos focados:
* Handlers de rotas da API devem residir em arquivos de rotas dedicados (`server/routes/`).
* Subcomponentes visuais do cliente devem residir em módulos de UI independentes (`client/src/components/`).
* Utilitários de rede e estado devem ser organizados em camadas de serviço (`services/`).

### B. Manuseio do DOM sem Recriação Destrutiva (Implementado)
O `client/src/main.js` utiliza `patchChildren()` para reconciliação de nós do DOM por diffing, e `tileCache` para cache de tiles por chave composta (`userId-slot-palco-semVideo`). **Nunca substitua** esse mecanismo por `grid.replaceChildren()` ou `innerHTML` — a recriação destrutiva destrói contextos WebGL/Canvas, reinicia decoders de vídeo, e causa layout thrashing visível como flashes de tela preta. O cache deve periodicamente **podar chaves órfãs** (participantes que já saíram) para evitar memory leaks infinites em salas com altíssima rotatividade.

### C. Alívio de Métricas no Event Loop (Implementado)
No servidor de mídia ([server/rooms.js](file:///d:/discord-screen/server/rooms.js)), `recordTraffic()` acumula bytes em variáveis numéricas locais (`_currentReceived`, `_currentTransmitted`, `_currentDropped`) e descarrega no `Map<second, bucket>` apenas quando o segundo do relógio vira. **Nunca reverta** para acessos ao Map por chunk — um stream a 60 FPS com 10 espectadores gera ~600 chunks/segundo, e o overhead de Map.get/set a cada um saturava o Event Loop.

---

## 8. Comandos de Operação e Testes

Todos os comandos devem ser executados a partir da raiz do workspace:

### Desenvolvimento e Execução
```bash
# Instalação inicial de dependências em todos os workspaces
npm install

# Assistente interativo para gerar .env e chaves
npm run configurar

# Iniciar servidor e frontend com hot-reload (Vite + Node)
npm run dev

# Subir túnel Cloudflare público para testes no Discord
npm run tunel

# Build de produção e inicialização padrão
npm run build
npm start
```

### Qualidade de Código e Testes
```bash
# Executar todos os testes automatizados (Vitest)
npm test

# Executar testes em modo watch contínuo
npm run test:watch

# Gerar relatório de cobertura de código
npm run coverage

# Verificar conformidade de linter (ESLint)
npm run lint

# Corrigir erros automáticos de formatação e linter
npm run lint:fix
npm run format

# Executar teste de fumaça ponta a ponta sem browser (requer servidor rodando)
npm run smoke

# Executar suíte de testes E2E completos (Playwright)
npm run test:e2e
```

### Aplicativo Desktop (Electron)
```bash
# Diretório do aplicativo desktop
cd desktop-app

# Recompilar addon nativo C++ WASAPI
npm run rebuild

# Executar versão desktop em desenvolvimento
npm run start

# Gerar executável portátil para Windows
npm run make
```
