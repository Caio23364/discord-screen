/**
 * Stress test do servidor: Simula carga massiva em uma única sala.
 * Avalia o backpressure e vazão do relay WebSocket.
 *
 * Utilização:
 *  - NODE_ENV=development node scripts/stress.mjs
 * 
 * Variáveis configuráveis:
 *  - VIEWERS: número de conexões espectadoras simultâneas (padrão: 50)
 *  - FPS: frequência de pacotes simulados (padrão: 60)
 *  - DURATION: duração da transmissão de teste em segundos (padrão: 5)
 *  - PAYLOAD_KB: tamanho de cada frame em KB (padrão: 50)
 */

import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const WSB = process.env.SMOKE_WS || 'ws://localhost:3001';
const N_VIEWERS = parseInt(process.env.VIEWERS || '50', 10);
const DURATION_SEC = parseInt(process.env.DURATION || '5', 10);
const FPS = parseInt(process.env.FPS || '60', 10);
const PAYLOAD_SIZE = parseInt(process.env.PAYLOAD_KB || '50', 10) * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const TEST_INSTANCE = `stress-${Date.now().toString(36)}`;

const identity = async (instance, name) =>
  (await api('/api/session-dev', { instance_id: instance ?? TEST_INSTANCE, name })).body;

function pacote(slot, tipo, payloadSize) {
  const buf = Buffer.alloc(18 + payloadSize);
  buf.writeUInt8(slot, 0);
  buf.writeUInt8(tipo, 1);
  buf.writeDoubleBE(Date.now(), 2);
  buf.writeDoubleBE(Date.now(), 10);
  return buf;
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.recv = { json: [], frames: 0, bytes: 0 };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.recv.frames++;
        ws.recv.bytes += data.byteLength;
      } else {
        ws.recv.json.push(JSON.parse(data.toString()));
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const run = async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    console.error(`Servidor inacessível em ${BASE}. Execute 'npm run start' ou 'npm run dev'.`);
    process.exit(1);
  }

  console.log(`\n🚀 Iniciando Teste de Carga`);
  console.log(`----------------------------------------`);
  console.log(`Espectadores : ${N_VIEWERS}`);
  console.log(`Taxa de envio: ${FPS} FPS`);
  console.log(`Duração      : ${DURATION_SEC} segundos`);
  console.log(`Frame payload: ${PAYLOAD_SIZE / 1024} KB`);
  console.log(`Banda alvo   : ~${((PAYLOAD_SIZE * FPS * N_VIEWERS * 8) / (1024 * 1024)).toFixed(1)} Mbps totais de saída (relay)`);
  console.log(`----------------------------------------\n`);

  const casterIdentity = await identity(TEST_INSTANCE, 'Caster');
  const sala = (await api('/api/rooms/create', { identity: casterIdentity.identity, name: 'Stress Room' })).body;

  process.stdout.write(`Conectando Caster... `);
  const caster = await open(`${WSB}/ws?t=${encodeURIComponent(new URL(sala.shareUrl).searchParams.get('t'))}`);
  await sleep(200);
  const slot = caster.recv.json.find((m) => m.type === 'slot')?.slot ?? 0;

  caster.send(JSON.stringify({ type: 'start' }));
  caster.send(JSON.stringify({ type: 'config', config: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } }));
  await sleep(100);
  caster.send(pacote(slot, 1, PAYLOAD_SIZE)); // Send initial keyframe
  console.log(`(Slot ${slot})`);

  process.stdout.write(`Conectando ${N_VIEWERS} espectadores... `);
  const viewers = [];
  const startConns = Date.now();
  for (let i = 0; i < N_VIEWERS; i++) {
    const vIdentity = await identity(TEST_INSTANCE, `Viewer ${i}`);
    const vJoinApi = await api('/api/rooms/join', { identity: vIdentity.identity, roomId: sala.roomId });
    if (vJoinApi.status !== 200 || !vJoinApi.body.viewerToken) {
      console.error(`\nErro ao juntar Viewer ${i}: HTTP ${vJoinApi.status}`, vJoinApi.body);
      process.exit(1);
    }
    const viewer = await open(`${WSB}/ws?t=${encodeURIComponent(vJoinApi.body.viewerToken)}`);
    viewer.send(JSON.stringify({ type: 'watch', slot }));
    viewers.push(viewer);
  }
  console.log(`(Levou ${Date.now() - startConns}ms)`);
  
  await sleep(1000); // Allow buffers and queues to settle
  for (const v of viewers) {
    v.recv.frames = 0;
    v.recv.bytes = 0;
  }

  console.log(`Transmitindo tráfego pesado...`);
  
  // Envia um keyframe agora que todos estao conectados
  caster.send(pacote(slot, 1, PAYLOAD_SIZE));
  
  let framesSent = 1;
  const start = Date.now();
  const interval = 1000 / FPS;
  let nextFrame = start;

  while (Date.now() - start < DURATION_SEC * 1000) {
    const now = Date.now();
    if (now >= nextFrame) {
      caster.send(pacote(slot, 2, PAYLOAD_SIZE)); // Delta frame
      framesSent++;
      nextFrame += interval;
    }
    await sleep(2); // Impede lock do event loop
  }

  console.log(`Aguardando entrega residual (1s)...`);
  await sleep(1000);
  caster.close();
  
  let totalFramesReceived = 0;
  let minFrames = Infinity;
  let maxFrames = 0;
  let droppedConnections = 0;

  for (const v of viewers) {
    if (v.readyState !== WebSocket.OPEN) droppedConnections++;
    totalFramesReceived += v.recv.frames;
    if (v.recv.frames < minFrames) minFrames = v.recv.frames;
    if (v.recv.frames > maxFrames) maxFrames = v.recv.frames;
    v.close();
  }

  if (minFrames === Infinity) minFrames = 0;

  const rate = totalFramesReceived / (framesSent * N_VIEWERS);
  const ratePct = (rate * 100).toFixed(2);
  const droppedFrames = (framesSent * N_VIEWERS) - totalFramesReceived;

  console.log(`\n==== RESULTADOS DA CARGA ====`);
  console.log(`Quadros enviados pela origem : ${framesSent}`);
  console.log(`Volume que deveria ser lido  : ${framesSent * N_VIEWERS}`);
  console.log(`Volume recebido c/ sucesso   : ${totalFramesReceived} (${ratePct}%)`);
  console.log(`Pacotes cortados (backpress) : ${droppedFrames}`);
  console.log(`Conexões derrubadas/mortas   : ${droppedConnections}`);
  console.log(`Variância entre viewers      : Mínimo ${minFrames} | Máximo ${maxFrames}`);
  
  console.log(`\nO servidor lidou bem se o número de conexões mortas for 0.`);
  console.log(`Pacotes cortados demonstram o limite de banda da máquina/rede rodando o teste.`);
  
  process.exit(0);
};

run().catch((e) => {
  console.error('\nErro no teste:', e);
  process.exit(1);
});
