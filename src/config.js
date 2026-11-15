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

// Обновляет KEY=value в .env (или дописывает в конец). Используется для
// сохранения выбора, сделанного в консоли при первом запуске (язык).
export function writeEnvKey(key, value) {
  let text = "";
  try {
    text = fs.readFileSync(ENV_URL, "utf8");
  } catch {}
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = text ? text.replace(/\r?\n$/, "") + "\n" + line + "\n" : line + "\n";
  }
  fs.writeFileSync(ENV_URL, text);
  process.env[key] = value; // применяем сразу, без ожидания вотчера
  fileOwnedKeys.add(key);
}

// Есть ли строка KEY= в .env (даже пустая)? Для мастера первого запуска:
// если пользователь пропустил поле, повторно не спрашиваем.
export function envKeyExists(key) {
  let text = "";
  try {
    text = fs.readFileSync(ENV_URL, "utf8");
  } catch {
    return false;
  }
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(text);
}

// Дефолтный last.fm API key (только публичные данные user.getrecenttracks):
// пользователю достаточно вписать свой ник — свой ключ получать не обязательно.
const DEFAULT_LASTFM_API_KEY = "e0fecb0af5822e8ac426410cd8171851";

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
      apiKey: process.env.LASTFM_API_KEY || DEFAULT_LASTFM_API_KEY,
      username: process.env.LASTFM_USERNAME || "",
      // Локальный HTTP-прокси (v2rayN/clash) для обхода блокировки last.fm:
      // LASTFM_PROXY=http://127.0.0.1:10809
      proxy: process.env.LASTFM_PROXY || "",
    },
    // Своя картинка-заглушка обложки, когда обложки трека нет нигде:
    // путь к файлу (D:\pics\cover.jpg) или URL. Пусто = градиент без обложки.
    defaultCover: process.env.DEFAULT_COVER || "",
    statsfm: {
      username: process.env.STATSFM_USERNAME || "",
    },
    pollMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    showcase: {
      enabled: process.env.SHOWCASE_ENABLED === "true",
      minIntervalMs: parseInt(process.env.SHOWCASE_MIN_INTERVAL_MS || "60000", 10),
      type: parseInt(process.env.SHOWCASE_TYPE || "13", 10), // 13 = иллюстрации 2x2, 22 = избранная иллюстрация
      slot: parseInt(process.env.SHOWCASE_SLOT || "0", 10), // номер витрины на профиле (с нуля)
      // Убирать карточку из «Иллюстраций» при закрытии бота (Ctrl+C / закрытие
      // окна). false — оставить арт в галерее и на витрине после выхода.
      clearOnExit: process.env.SHOWCASE_CLEAR_ON_EXIT !== "false",
      // Дедупликация заливок: track — карточка перезаливается на каждый трек
      // (название на картинке всегда актуально), album — реже заливки, но
      // внутри альбома витрина показывает первый залитый трек.
      dedup: process.env.SHOWCASE_DEDUP === "album" ? "album" : "track",
      // Ориентация карточки в витрине:
      //   wide     — растянуть по всей ширине (image_width=999999/image_height=1)
      //   vertical — растянуть по всей высоте (image_width=1/image_height=999999)
      //   none     — обычная карточка, Steam вписывает её как есть
      // Геттеры — значение всегда читается из окружения, так что правка .env
      // подхватывается хот-релоадом без перезапуска.
      get stretch() {
        const s = (process.env.SHOWCASE_STRETCH || "").trim().toLowerCase();
        if (s === "wide" || s === "vertical" || s === "none") return s;
        return process.env.SHOWCASE_WIDE === "true" ? "wide" : "none"; // legacy-флаг
      },
      get wide() {
        return this.stretch === "wide";
      },
      // Размеры карточки по умолчанию зависят от ориентации: баннер 2400x800,
      // вертикальная 630x1200, обычная 630x800.
      // Явные CARD_WIDTH/CARD_HEIGHT в .env всегда побеждают.
      get width() {
        return parseInt(process.env.CARD_WIDTH || (this.stretch === "wide" ? "2400" : "630"), 10);
      },
      get height() {
        return parseInt(process.env.CARD_HEIGHT || (this.stretch === "vertical" ? "1200" : "800"), 10);
      },
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
