import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '.admin-config.json');

// Estado em memória (cache) para leituras rápidas síncronas sem bater no disco toda hora.
let _configCache = {
  requireSharedGuild: true,
};

// Ao carregar o módulo, tenta ler o disco uma única vez
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    _configCache = { ..._configCache, ...parsed };
  } else {
    // Se não existe, cria com o default
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_configCache, null, 2), 'utf-8');
  }
} catch (err) {
  console.error('[config] Erro ao carregar .admin-config.json. Usando defaults.', err);
}

export function getConfig() {
  return _configCache;
}

export function updateConfig(changes) {
  _configCache = { ..._configCache, ...changes };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_configCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[config] Erro ao salvar .admin-config.json', err);
    throw err;
  }
  return _configCache;
}
