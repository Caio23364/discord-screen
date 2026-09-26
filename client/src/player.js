/**
 * Player WebCodecs.
 *
 * Dentro da Activity não existe WebRTC, mas WebCodecs não é bloqueado por
 * Permissions Policy — então dá para decodificar quadro a quadro e desenhar
 * num canvas, sem passar por container nem por MediaSource.
 *
 * O canvas mantém SEMPRE o tamanho nativo do vídeo no buffer interno
 * (canvas.width/height). Isso dá a ele uma proporção intrínseca, e o CSS
 * apenas o limita com max-width/max-height — o navegador então reduz
 * preservando a proporção, por construção.
 *
 * Dimensionar o buffer pelo tamanho de exibição, como cheguei a tentar, faz a
 * proporção do vídeo passar a depender do formato do container e distorce a
 * imagem durante o redimensionamento.
 *
 * Os quadros NÃO são desenhados assim que chegam. Ver a nota em BUFFER_MS: sem
 * essa espera, a irregularidade da rede vira micro-travada mesmo quando não se
 * perde um quadro sequer.
 */

/**
 * Quanto tempo cada quadro espera antes de aparecer.
 *
 * Este é o remédio para a travadinha que acontece com a transmissão inteira
 * chegando: os quadros são capturados a cada 33 ms cravados, mas chegam a cada
 * 28, 41, 30, 37… O caminho de rede não é regular — TCP entrega em rajada, o
 * relay reparte entre vários espectadores, e o agendador do sistema atrasa uns
 * milissegundos aqui e ali. Desenhando na chegada, essa irregularidade toda vai
 * direto para a tela, e é exatamente ela que se vê como solavanco.
 *
 * Localmente a irregularidade é quase zero, e por isso a mesma transmissão que
 * é lisa na própria máquina fica picada quando passa por um servidor de
 * verdade. Não é banda, não é CPU e não é quadro perdido — é ritmo.
 *
 * Segurar os quadros e reproduzi-los no ritmo em que foram capturados devolve o
 * ritmo. O preço é este atraso, pago uma vez só: 80 ms é mais que a
 * irregularidade típica de uma rede ruim e menos do que qualquer pessoa percebe
 * assistindo alguém jogar. Quem precisa de menos atraso do que isso está
 * conversando, não assistindo — e aí a conversa é por voz do Discord.
 */
const BUFFER_MS = 150;

/**
 * Teto da fila. Além disso a espera deixou de ser buffer e virou atraso.
 *
 * Acontece quando a origem manda mais rápido do que o combinado, ou quando o
 * relógio das duas máquinas anda em velocidades diferentes. Preferir descartar
 * é o mesmo princípio do encoder: atraso acumulado nunca mais sai sozinho.
 */
const FILA_MAX = 60;

/** De quanto em quanto tempo a espera é reavaliada, e sobre qual janela. */
const AJUSTE_MS = 2000;

/** Correção máxima por ajuste: acima disso a mudança de ritmo se vê. */
const PASSO_MAX_MS = 15;

export function createPlayer(canvas, { onError, onTamanho, onNeedKeyframe, onFallback2D } = {}) {
  let isWebGL = false;
  let gl = canvas.getContext('webgl2', { alpha: false, desynchronized: true });
  let ctx = null;
  
  let tex = null;
  let locResolution = null;
  let locSharpness = null;
  let locSaturation = null;
  let fsrStrength = 1.5;
  let saturation = 1.0;
  let fsrEnabled = false;

  if (gl && typeof gl.createProgram === 'function') {
    isWebGL = true;
    const vsSource = "#version 300 es\nin vec2 a_position;\nin vec2 a_texcoord;\nout vec2 v_texcoord;\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texcoord = a_texcoord;\n}";
    const fsSource = "#version 300 es\nprecision highp float;\nin vec2 v_texcoord;\nuniform sampler2D u_texture;\nuniform vec2 u_resolution;\nuniform float u_sharpness;\nuniform float u_saturation;\nout vec4 outColor;\nvoid main() {\n  vec3 sharp;\n  if (u_sharpness <= 0.0) {\n    sharp = texture(u_texture, v_texcoord).rgb;\n  } else {\n    vec2 step = 1.0 / u_resolution;\n    vec3 c = texture(u_texture, v_texcoord).rgb;\n    vec3 tc = texture(u_texture, v_texcoord + vec2(0.0, -step.y)).rgb;\n    vec3 bc = texture(u_texture, v_texcoord + vec2(0.0, step.y)).rgb;\n    vec3 lc = texture(u_texture, v_texcoord + vec2(-step.x, 0.0)).rgb;\n    vec3 rc = texture(u_texture, v_texcoord + vec2(step.x, 0.0)).rgb;\n    vec3 blurred = (tc + bc + lc + rc) * 0.25;\n    sharp = c + (c - blurred) * u_sharpness;\n  }\n  vec3 lumaWeights = vec3(0.299, 0.587, 0.114);\n  float luma = dot(sharp, lumaWeights);\n  vec3 finalColor = mix(vec3(luma), sharp, u_saturation);\n  outColor = vec4(finalColor, 1.0);\n}";
    const compile = (type, src) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    gl.useProgram(program);

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    const texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 1,1, 0,0, 0,0, 1,1, 1,0]), gl.STATIC_DRAW);

    const locPos = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(locPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

    const locTex = gl.getAttribLocation(program, 'a_texcoord');
    gl.enableVertexAttribArray(locTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.vertexAttribPointer(locTex, 2, gl.FLOAT, false, 0, 0);

    locResolution = gl.getUniformLocation(program, 'u_resolution');
    locSharpness = gl.getUniformLocation(program, 'u_sharpness');
    locSaturation = gl.getUniformLocation(program, 'u_saturation');

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } else {
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  function setVideoSettings(options) {
    if (options.fsrEnabled !== undefined) fsrEnabled = options.fsrEnabled;
    if (options.fsrStrength !== undefined) fsrStrength = options.fsrStrength;
    if (options.saturation !== undefined) saturation = options.saturation;
  }

  let decoder = null;
  let needKeyframe = true;
  let lastKeyframeReq = 0;
  let lastLagMs = 0;
  let framesDrawn = 0;

  // Quadros decodificados esperando a hora de aparecer, em ordem de exibição.
  const fila = [];
  // Instante local que corresponde ao timestamp zero da origem. É o que traduz
  // "capturado em tal momento" para "desenhar em tal momento".
  let base = null;
  let rafId = null;
  // Folga com que os quadros da janela atual chegaram: a menor delas é o que
  // sobra de margem antes de um quadro perder a própria hora, e o intervalo
  // entre a menor e a maior é a irregularidade que estamos combatendo.
  let folgaMin = Infinity;
  let folgaMax = -Infinity;
  let janelaAte = 0;
  let irregularidade = null;
  // Último timestamp de captura visto. Serve para detectar a origem recomeçando:
  // o tempo andando para trás invalida a referência.
  let ultimoTs = -Infinity;
  // Quem espera precisa saber quando a espera acabou: entre pedir para assistir
  // e o primeiro quadro cabe um keyframe inteiro de atraso, e o canvas preto
  // desse intervalo é idêntico a um travamento.
  let virgem = true;

  let lastRawConfig = null;

  function start(rawConfig) {
    stop(true);
    lastRawConfig = rawConfig;

    if (!window.VideoDecoder) {
      onError?.('Este navegador não tem WebCodecs — não é possível assistir.');
      return false;
    }

    const config = deserialize(rawConfig);

    decoder = new VideoDecoder({
      output: draw,
      error: (err) => {
        // Erro de decodificação normalmente é fluxo fora de sincronia:
        // pedir um keyframe recupera sem derrubar a sessão.
        console.warn('[decoder]', err.message);
        needKeyframe = true;
        const now = Date.now();
        if (now - lastKeyframeReq > 2000) {
          lastKeyframeReq = now;
          onNeedKeyframe?.();
        }
        if (lastRawConfig) setTimeout(() => start(lastRawConfig), 10);
      },
    });

    try {
      decoder.configure(config);
    } catch {
      onError?.(`Codec não suportado por este navegador: ${config.codec}`);
      decoder = null;
      return false;
    }

    needKeyframe = true;
    return true;
  }

  /** Quadro empacotado: [1B slot][1B tipo][8B timestamp][8B envio][payload] */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    const view = new DataView(buffer);
    const isKeyframe = view.getUint8(1) === 1;

    // Decoder frio só aceita keyframe; deltas antes disso viram erro.
    if (needKeyframe && !isKeyframe) {
      const now = Date.now();
      if (now - lastKeyframeReq > 2000) {
        lastKeyframeReq = now;
        onNeedKeyframe?.();
      }
      return;
    }

    const timestamp = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Date.now() - sentAt;

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp,
          data: new Uint8Array(buffer, 18),
        }),
      );
      needKeyframe = false;
    } catch (err) {
      console.warn('[decode]', err.message);
      needKeyframe = true;
      onNeedKeyframe?.();
    }
  }

  function draw(frame) {
    const agora = performance.now();
    const tsMs = (frame.timestamp ?? 0) / 1000;

    // Origem nova, ou timestamp que andou para trás (transmissão reiniciada):
    // não há o que traduzir a partir da referência antiga.
    if (base === null || tsMs < ultimoTs) reancorar(agora, tsMs);
    ultimoTs = tsMs;

    const exibirEm = base + tsMs;
    const folga = exibirEm - agora;

    // Chegou depois da própria hora — a rede engasgou severamente e a referência ficou
    // otimista demais. Reancorar aqui custa um solavanco só, contra um quadro
    // atrasado a cada quadro se a referência ficasse como está.
    if (folga < -Math.max(160, BUFFER_MS * 2)) {
      esvaziar();
      reancorar(agora, tsMs);
      pintar(frame);
      return;
    }

    medir(agora, folga);

    fila.push({ frame, tsMs, exibirEm });

    // Fila estourada: o mais velho é o que menos importa, e segurá-lo é atraso.
    while (fila.length > FILA_MAX) fila.shift().frame.close();

    agendar();
  }

  /** Marca a referência de tempo a partir deste quadro. */
  function reancorar(agora, tsMs) {
    base = agora + BUFFER_MS - tsMs;
    folgaMin = Infinity;
    folgaMax = -Infinity;
    janelaAte = agora + AJUSTE_MS;
  }

  /**
   * Acompanha a folga e reajusta a espera de tempos em tempos.
   *
   * A referência de tempo envelhece: o relógio de quem transmite e o de quem
   * assiste nunca andam exatamente na mesma velocidade, e o desvio empurra a
   * fila para o vazio ou para o excesso. Corrigir pela MENOR folga da janela é
   * o que mantém a margem justa — a menor folga é a que quase perdeu a hora, e
   * é ela que decide se vai haver travada ou não.
   */
  function medir(agora, folga) {
    if (folga < folgaMin) folgaMin = folga;
    if (folga > folgaMax) folgaMax = folga;

    if (agora < janelaAte) return;

    // A distância entre o quadro mais folgado e o mais apertado da janela é,
    // literalmente, a irregularidade da entrega. É o número do diagnóstico.
    if (folgaMin !== Infinity) irregularidade = Math.round(folgaMax - folgaMin);

    const erro = folgaMin - BUFFER_MS;
    if (folgaMin !== Infinity && Math.abs(erro) > 5) {
      base -= Math.max(-PASSO_MAX_MS, Math.min(PASSO_MAX_MS, erro));
      for (const item of fila) item.exibirEm = base + item.tsMs;
    }

    folgaMin = Infinity;
    folgaMax = -Infinity;
    janelaAte = agora + AJUSTE_MS;
  }

  /**
   * Desenha o quadro cuja hora chegou, alinhado ao refresh da tela.
   *
   * Se mais de um venceu no mesmo intervalo, só o último vai para a tela: os
   * anteriores já são passado, e desenhá-los seria gastar GPU para exibir uma
   * imagem que some no mesmo quadro do monitor.
   */
  function passo() {
    rafId = null;
    const agora = performance.now();

    let escolhido = null;
    while (fila.length && fila[0].exibirEm <= agora) {
      escolhido?.frame.close();
      escolhido = fila.shift();
    }

    if (escolhido) pintar(escolhido.frame);
    if (fila.length) agendar();
  }

  function agendar() {
    rafId ??= requestAnimationFrame(passo);
  }

  function esvaziar() {
    while (fila.length) fila.shift().frame.close();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function pintar(frame) {
    // Buffer no tamanho nativo do vídeo: é isso que define a proporção
    // intrínseca do elemento, e é o que impede o CSS de distorcer.
    let mudou = false;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      if (isWebGL) {
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      mudou = true;
    }

    let webglError = false;

    if (isWebGL) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.uniform2f(locResolution, canvas.width, canvas.height);
        gl.uniform1f(locSharpness, fsrEnabled ? fsrStrength : 0.0);
        gl.uniform1f(locSaturation, fsrEnabled ? saturation : 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } catch (err) {
        console.warn('[webgl] Falha ao renderizar quadro, voltando para 2D:', err.message);
        isWebGL = false;
        webglError = true;
        
        const novo = document.createElement('canvas');
        novo.className = canvas.className;
        novo.width = canvas.width;
        novo.height = canvas.height;
        
        if (canvas.parentNode) canvas.parentNode.replaceChild(novo, canvas);
        canvas = novo;
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        
        // Avisa o chamador para atualizar sua própria referência
        onFallback2D?.(novo);
      }
    }
    
    if (!isWebGL && (ctx || webglError)) {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    }

    // VideoFrame segura memória de GPU; sem close() a aba trava em segundos.
    frame.close();
    framesDrawn++;

    // Avisa no primeiro quadro e sempre que a resolução muda: quem desenha o
    // palco precisa das duas coisas — tirar o "conectando" e refazer a forma.
    if (virgem || mudou) {
      virgem = false;
      onTamanho?.();
    }
  }

  function stop(preserveFrame = false) {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    decoder = null;
    needKeyframe = true;
    lastLagMs = 0;
    esvaziar();
    base = null;
    ultimoTs = -Infinity;
    irregularidade = null;
    if (!preserveFrame && canvas.width && canvas.height) {
      if (isWebGL) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  /** Atraso aproximado em ms. Exato na mesma máquina; entre máquinas, sujeito a desvio de relógio. */
  const getLag = () => lastLagMs;

  /**
   * O quanto a entrega chegou irregular na última janela, em ms.
   *
   * Este é o número que separa "a rede não dá conta" de "a rede dá conta, mas
   * entrega em rajada". Perto de zero e travando, o problema é outro; alto, e a
   * espera de BUFFER_MS é o que está segurando a imagem no lugar.
   */
  const getJitter = () => irregularidade;

  /** Resolução nativa do vídeo e tamanho de exibição — para diagnóstico. */
  function getSizes() {
    const rect = canvas.getBoundingClientRect();
    return {
      video: `${canvas.width}×${canvas.height}`,
      box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    };
  }

  function takeFrameCount() {
    const n = framesDrawn;
    framesDrawn = 0;
    return n;
  }

  return { start, push, stop, getLag, getJitter, takeFrameCount, getSizes, setVideoSettings, get isWebGL() { return isWebGL; }, needsKeyframe: () => needKeyframe };
}

function deserialize(c) {
  const out = {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    // Reduz o buffering interno do decoder — sem isso ele acumula alguns
    // quadros antes de emitir o primeiro.
    optimizeForLatency: true,
  };

  // Sem isto o decoder presume avcC. Quando quem transmite negociou annexb
  // (o candidato preferido, ver shared/broadcaster.js), o bitstream chega com
  // start codes e o decoder recusa todo quadro — inclusive o keyframe, então
  // o pedido de keyframe do erro nunca se recupera e a tela fica carregando
  // para sempre.
  if (c.avc) out.avc = c.avc;

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  }

  return out;
}
