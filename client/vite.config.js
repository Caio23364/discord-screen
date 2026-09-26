import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  // O .env fica na raiz do projeto, não dentro de client/.
  envDir: '..',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared')
    }
  },
  server: {
    port: 5173,
    // Necessário quando o Vite é exposto por um túnel (cloudflared/ngrok).
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
