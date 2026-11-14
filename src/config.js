import fs from "node:fs";
import { t } from "./i18n.js";

const ENV_URL = new URL("../.env", import.meta.url);

// Minimal .env loader (no dependency); missing .env is fine.
// Hot-reload: the file is watched; changes apply within ~1s without restart.
// Keys that came from the file can be updated by editing the file.
// Keys set externally (real process env) always win and are never touched.

const fileOwnedKeys = new Set();

function applyEnvFile() {
  let text = "";
  try {
    text = fs.readFileSync(ENV_URL, "utf8");
  } catch {
    return [];
  }
  const changed = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (fileOwnedKeys.has(key)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed.push(key);
      }
    } else if (process.env[key] === undefined) {
      process.env[key] = value;
      fileOwnedKeys.add(key);
      changed.push(key);
    }
  }
  return changed;
}

function buildConfig() {
  return {
    steam: {
      username: process.env.STEAM_USERNAME || "",
      password: process.env.STEAM_PASSWORD || "",
      sharedSecret: process.env.STEAM_SHARED_SECRET || "",
    },
    status: {
      // Явный STATUS_TEMPLATE в .env побеждает;
      // иначе шаблон следует за языком (LANG), хот-релоад через t()
      get template() {
        return process.env.STATUS_TEMPLATE || t("status_template");
      },
    },
    lastfm: {
      apiKey: process.env.LASTFM_API_KEY || "",
      username: process.env.LASTFM_USERNAME || "",
      // Локальный HTTP-прокси (v2rayN/clash) для обхода блокировки last.fm:
      // LASTFM_PROXY=http://127.0.0.1:10809
      proxy: process.env.LASTFM_PROXY || "",
    },
    statsfm: {
      username: process.env.STATSFM_USERNAME || "",
    },
    pollMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    showcase: {
      enabled: process.env.SHOWCASE_ENABLED === "true",
      minIntervalMs: parseInt(process.env.SHOWCASE_MIN_INTERVAL_MS || "60000", 10),
      type: parseInt(process.env.SHOWCASE_TYPE || "13", 10), // 13 = иллюстрации 2x2, 22 = избранная иллюстрация
      slot: parseInt(process.env.SHOWCASE_SLOT || "0", 10), // слот/ячейка внутри витрины
      // Широкий баннер: заливаем с image_width=999999/image_height=1 — Steam
      // растягивает картинку на всю ширину витрины (artwall-трюк). Рекомендуется
      // SHOWCASE_TYPE=22 и CARD_WIDTH=2400, CARD_HEIGHT=800.
      wide: process.env.SHOWCASE_WIDE === "true",
      width: parseInt(process.env.CARD_WIDTH || "630", 10),
      height: parseInt(process.env.CARD_HEIGHT || "800", 10),
    },
  };
}

applyEnvFile();
export const config = buildConfig();

export function reloadConfig() {
  const changedKeys = applyEnvFile();
  if (changedKeys.length > 0) {
    const next = buildConfig();
    const changed = [];
    for (const group of Object.keys(next)) {
      for (const [k, v] of Object.entries(next[group])) {
        const desc = Object.getOwnPropertyDescriptor(config[group], k);
        if (desc && desc.get) continue; // getter-поля всегда вычисляются свежими
        if (JSON.stringify(config[group][k]) !== JSON.stringify(v)) {
          config[group][k] = v;
          changed.push(`${group}.${k}`);
        }
      }
    }
    if (changed.length > 0) {
      console.log(`[config] ${t("config_changed", { keys: changed.join(", ") })}`);
      if (changed.some((c) => c.startsWith("steam."))) {
        console.log(`[config] ${t("config_steam_restart")}`);
      }
    }
  }
}

let lastMtime = 0;
try {
  lastMtime = fs.statSync(ENV_URL).mtimeMs;
} catch {}
try {
  const watcher = fs.watchFile(ENV_URL, { interval: 1000 }, (curr) => {
    if (curr.mtimeMs === lastMtime) return;
    lastMtime = curr.mtimeMs;
    reloadConfig();
  });
  watcher.unref?.(); // не держим процесс alive ради вотчера (важно для --check-sources)
} catch {}
