![Fabricio Telas](como-nao-compartilhar-tela-no-discord-banner.png)

# Sala de Tela (Discord Screen)

Transmita sua tela em tempo real com **ultra-baixa latência (< 100ms)** e até **60 FPS** para quem está na mesma chamada de voz do Discord.  
Uma pessoa transmite, todo mundo assiste com decodificação direta quadro a quadro, sem precisar sair do Discord e sem atraso de buffering de containers.

Também funciona como site normal, fora do Discord, com salas que você cria e compartilha via link, além de contar com um **aplicativo desktop dedicado** para Windows.

---

## 🚀 Destaques Principais

- **Transmissão Ultra-Rápida:** Decodificação direta via **WebCodecs** (sem atrasos de 2 a 4 segundos típicos de `MediaRecorder` ou HLS).
- **Transporte Híbrido Resiliente:** Conexão direta P2P via **WebRTC Mesh** quando possível, com fallback automático e transparente para **WebSocket Relay** caso haja bloqueio de firewall/NAT.
- **Áudio Nativo sem Eco (Desktop App):** Captura isolada do som do jogo ou janela específica via módulo WASAPI nativo em C++, sem misturar a voz dos amigos da call do Discord.
- **Qualidade Adaptativa:** Algoritmo dinâmico que alivia o framerate (30 a 60 FPS) e bitrate automaticamente sob oscilações de rede (*Adaptive FPS* e *Dynamic Bitrate Allocation*).
- **Aprimoramento Visual FSR:** Shaders WebGL com contraste adaptativo (estilo FidelityFX CAS/FSR) e controle de saturação para melhorar legibilidade de textos e gráficos no cliente.
- **Ferramentas Co-op:** Apontador laser sincronizado (pings na tela), Picture-in-Picture (PiP), Zoom & Pan livre e botão de Privacidade/Censura imediata.

---

## 📋 Pré-requisitos

1. **Node.js (versão 20 LTS ou superior):**
   - Baixe em [nodejs.org](https://nodejs.org). Instale com as opções padrão.
2. **Navegador Moderno:**
   - Chrome, Edge, Brave ou Opera para quem vai transmitir via web (suporte a WebCodecs e `getDisplayMedia`).
   - Qualquer navegador moderno para assistir.
3. **Conta no Portal de Desenvolvedores do Discord (apenas se for rodar como Activity dentro do Discord).**

> ⚠️ **Aviso de Celular:** Dispositivos móveis (iOS/Android) não permitem captura de tela pelo navegador web. Para assistir, o uso em computadores é recomendado para melhor suporte a WebCodecs.

---

## ⚡ Como Rodar Rápido (1 Comando)

1. Clone ou baixe este repositório:
   ```bash
   git clone https://github.com/SEU_USUARIO/discord-screen.git
   cd discord-screen
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Inicie o assistente integrado:
   ```bash
   npm run start:fast
   ```

O comando `start:fast` faz tudo de forma automatizada:
- Se for a primeira vez e o arquivo `.env` não existir, ele faz as perguntas interativas necessárias.
- Configura o túnel HTTPS seguro via `cloudflared` (guardado localmente em `.cache/`).
- Compila o frontend do cliente e inicia o servidor HTTP e WebSocket na porta configurada.

Para desligar, basta pressionar `Ctrl + C` no terminal.

### 🧪 Teste Rápido Local (Sem Discord)

Se você quer apenas testar a transmissão no seu computador local sem conectar ao Discord:
- Escolha o modo de teste ou inicie com:
  ```bash
  npm run start:noauth
  ```
- Abra `http://localhost:3001` em duas abas do navegador: em uma você clica em **Compartilhar tela** e na outra você assiste a reprodução instantânea.

---

## 🔒 Segurança e Credenciais (`.env`)

> 🛑 **MUITO IMPORTANTE:** O arquivo `.env` contém chaves criptográficas e credenciais sensíveis e **NUNCA DEVE SER ENVIADO PARA O GITHUB OU COMPARTILHADO**. Ele já está incluído no `.gitignore`.

Utilize o arquivo [`.env.example`](.env.example) como modelo de referência:

```env
# Chave de assinatura HMAC-SHA256 dos tokens (mínimo 32 caracteres)
SESSION_SECRET=coloque_uma_chave_aleatoria_longa_aqui

# Credenciais da Aplicação Discord (OAuth2)
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CLIENT_SECRET=seu_client_secret_aqui

# Token do Bot (Opcional - valida presença de usuários na call)
DISCORD_BOT_TOKEN=seu_bot_token_aqui

# Endereço público da sua aplicação (Túnel HTTPS ou domínio próprio)
PUBLIC_ORIGIN=http://localhost:3001
PORT=3001
NODE_ENV=development

# IDs do Discord com permissão de Administrador para o painel /admin (separados por vírgula)
DISCORD_ADMIN_ID=123456789012345678
```

O backend garante que o `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` e `SESSION_SECRET` permaneçam estritamente isolados no servidor, nunca sendo expostos ao cliente web ou iframe.

---

## 🎮 Usando Dentro do Discord (Activity)

1. Crie uma aplicação no [Discord Developer Portal](https://discord.com/developers/applications).
2. Na aba **OAuth2**:
   - Adicione os Redirects: `https://<seu-dominio-ou-tunel>/auth/callback`.
3. Na aba **Embedded App (Activity)**:
   - Em **URL Mappings**, aponte o prefixo `/` para o endereço HTTPS fornecido pelo túnel ou servidor.
4. Entre em um canal de voz no Discord, clique no botão de **Foguete (Atividades)** 🚀 e inicie sua aplicação.

### Endereço Fixo de Túnel

Por padrão, túneis rápidos geram URLs temporárias a cada reinicialização. Para fixar um endereço definitivo com seu próprio domínio na Cloudflare:
```bash
npm run tunel:criar
```

---

## 🖥️ Aplicativo Desktop Dedicado (`desktop-app/`)

Para transmissão de jogos pesados e áudio exclusivo de programas sem capturar o som da chamada:

- **Onde fica:** Pasta `desktop-app/`.
- **Módulo C++ Nativo (WASAPI Loopback):** Captura o áudio isolado apenas do processo/jogo selecionado.
- **Aceleração Gráfica por Hardware:** Pipeline direto em GPU reduzindo cópias de memória RAM.
- **Atalho de Privacidade:** Pressione `Ctrl + Shift + C` para censurar a tela instantaneamente durante transmissões.

### Como Rodar o Desktop App:
```bash
cd desktop-app
npm install
npm run rebuild   # Compila o addon C++ nativo para sua versão do Electron
npm start         # Inicia o app em modo de desenvolvimento
```

Para gerar o executável portátil (`.exe`):
```bash
npm run dist
```

---

## 🛠️ Ferramentas Co-op & Qualidade de Vida (QoL)

- **Apontador Laser Multijogador (Pings Co-op):** Clique em qualquer ponto do vídeo transmitido para marcar um laser pulsante visível para todos na sala.
- **Picture-in-Picture (PiP) Nativo:** Assista ao vídeo em uma janela flutuante no sistema enquanto navega ou joga (em abas fora do Discord).
- **Zoom & Pan Livre:** Use a roda do mouse sobre a tela para dar zoom e arraste com o botão do mouse para inspecionar detalhes.
- **Botão de Privacidade/Censura:** O transmissor pode pausar vídeo e som instantaneamente com tela de privacidade sem derrubar a sala.
- **Filtros WebGL (FSR & Saturação):** Ajuste fino de nitidez (*sharpening*) e saturação de cores para recuperar nitidez em resoluções mais baixas.
- **Controle de Volume Individual:** Regule o volume de cada pessoa que estiver transmitindo independentemente.

---

## 📊 Painel Administrativo (`/admin`)

Acesse `https://seu-dominio.com/admin` para monitorar o servidor em tempo real:
- Salas ativas, conexões WebRTC e WebSocket Relay.
- Consumo de subida/descida (KB/s e MB/s) e taxa de pacotes descartados por buffer.
- Métricas de telemetria do sistema operacional: uso de CPU, memória RAM, Event Loop lag e disco.
- Controle dinâmico de permissão de acesso e limites da sala.

Para liberar acesso, adicione seu ID de usuário do Discord na variável `DISCORD_ADMIN_ID` no `.env`.

---

## ⌨️ Tabela de Comandos

| Comando | Descrição |
|---|---|
| `npm install` | Instala todas as dependências do projeto. |
| `npm run start:fast` | **Inicia tudo de forma automática** (configuração guiada + túnel + servidor). |
| `npm run dev` | Modo de desenvolvimento: reconstrói frontend e reinicia backend a cada alteração. |
| `npm run dev:rapido` | Modo dev com túnel temporário sem salvar alterações no `.env`. |
| `npm run start:noauth` | Inicia o servidor local sem exigir autenticação OAuth do Discord. |
| `npm run tunel:criar` | Cria um túnel Cloudflare permanente com domínio próprio. |
| `npm run configurar` | Reexecuta o assistente de configuração das variáveis do `.env`. |
| `npm test` | Executa a suíte de testes unitários com Vitest. |
| `npm run smoke` | Executa testes de ponta a ponta simulando WebSockets de áudio e vídeo sem navegador. |

---

## ❓ Solução de Problemas Comuns

- **A atividade fica como uma tela branca ou cinza no Discord:**
  O endereço do túnel mudou ou está desligado. Atualize o **URL Mapping** no Discord Developer Portal ou use `npm run tunel:criar` para ter um endereço estático.
- **"Porta 3001 já está sendo usada":**
  Já existe uma instância do servidor rodando em segundo plano. Feche o outro terminal ou mude `PORT` no arquivo `.env`.
- **Aba de captura abriu e nada acontece:**
  A aba `/share.html` é a fonte de captura do seu navegador. Mantenha essa aba aberta enquanto estiver transmitindo.
- **Não sai som na transmissão pelo navegador:**
  Na janela de seleção de tela do navegador, selecione a aba desejada e certifique-se de marcar a caixa de seleção de áudio. Se preferir capturar áudio de jogos instalados, use o **Desktop App**.

---

## 📖 Arquitetura e Engenharia Detalhada

Para entender todas as decisões de engenharia, protocolos binários, formatos de pacotes e padrões arquiteturais, consulte a documentação técnica:
- [Guia de Engenharia e Arquitetura do Sistema (`AGENTS.md`)](AGENTS.md)
- [Como o Pipeline de Mídia Funciona (`docs/como-funciona.md`)](docs/como-funciona.md)
