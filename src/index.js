import { config } from "./config.js";
import { getNowPlaying } from "./sources.js";
import { login, client, community as steamCommunity, setNowPlayingText, clearNowPlaying, myProfileUrl } from "./steam.js";
import { getCard, CARD_VERSION } from "./card.js";
import {
  uploadShowcaseArtwork,
  updateShowcase as saveShowcase,
  cleanupOldArtworks,
  deleteArtwork,
  findArtworkByAlbum,
  buildArtTitle,
  reqRetry,
  parseGalleryItems,
  ART_SIGNATURE,
  LEGACY_TITLE,
} from "./showcase.js";
import { t } from "./i18n.js";
import { checkForUpdates, performUpdateAuto } from "./updater.js";
import { ensureLanguage, ensureNicknames } from "./first-run.js";
import fs from "node:fs";
import net from "node:net";

// form-data@2.3.3 (тянется через steamcommunity -> request) всё ещё вызывает
// deprecated util.isArray — Node 22+ пишет DEP0044 прямо посреди лога заливки
// арта. Предупреждение безвредное (пакет рабочий, просто старый), поэтому
// глушим только его, остальные предупреждения оставляем видимыми.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code === "DEP0044") return;
  console.warn(`${w.name}: ${w.message}`);
});

const startedAt = Date.now();
// Флаг плавной остановки для лончера (см. pollLoop)
const STOP_FLAG = new URL("../stop.flag", import.meta.url);
let lastStateKey = null;
let lastShowcaseAt = 0;
// Дедупликация карточек: если этот же ключ уже налит — не заливаем арт
// заново, а переиспользуем существующий fileId (быстрее и меньше 429).
// Ключ считает cardKeyOf(): по треку (по умолчанию) или по альбому.
let currentFileId = null;
let currentAlbumKey = null;
// Обложки может не быть нигде (last.fm вернул заглушку, iTunes не нашёл):
// ретраим несколько кругов (источник мог не успеть отдать), потом рисуем
// карточку на градиенте — витрина не должна залипать на старом треке
let noCoverKey = null;
let noCoverCount = 0;

// Ключ карточки для дедупликации. По умолчанию — по треку: на картинке
// напечатано название, поэтому ключ обязан включать трек, иначе витрина
// залипает на первом треке альбома. SHOWCASE_DEDUP=album возвращает старое
// поведение (реже заливки, но название на карточке может отставать).
function cardKeyOf(track) {
  // Версия дизайна и ориентация тоже в ключе: после их смены карточки
  // перезаливаются, а старые арты подчищаются — витрина не залипает
  const scope =
    config.showcase.dedup === "album"
      ? `${track.artist || ""}||${track.album || ""}`
      : `${track.artist || ""}||${track.album || ""}||${track.title || ""}`;
  return `${scope}||${track.coverUrl || ""}||${CARD_VERSION}|stretch=${config.showcase.stretch}`.toLowerCase();
}

function formatStatus(track) {
  return config.status.template
    .replaceAll("{title}", track.title || "")
    .replaceAll("{artist}", track.artist || "")
    .replaceAll("{album}", track.album || "")
    .replaceAll("{source}", track.source || "");
}

async function updateShowcase(track) {
  const now = Date.now();
  // Обложка может ещё не успеть появиться в источнике — ретраим пару кругов.
  // Если её нет нигде — продолжаем: getCard нарисует градиент без обложки.
  if (!track.coverUrl) {
    const key = `${track.artist}|${track.title}`.toLowerCase();
    if (key !== noCoverKey) {
      noCoverKey = key;
      noCoverCount = 0;
    }
    noCoverCount++;
    if (noCoverCount === 1) console.log(`[showcase] ${t("showcase_no_cover")}`);
    if (noCoverCount < 5) return "retry";
    // Обложки нет нигде — если задан DEFAULT_COVER, ставим свою картинку
    if (config.defaultCover) {
      console.log(`[showcase] ${t("showcase_default_cover")}`);
      track.coverUrl = config.defaultCover;
      noCoverKey = null;
      noCoverCount = 0;
    }
  } else {
    noCoverKey = null;
    noCoverCount = 0;
  }
  if (now - lastShowcaseAt < config.showcase.minIntervalMs) return "retry";
  lastShowcaseAt = now;

  const cardKey = cardKeyOf(track);

  try {
    // Тот же трек, что уже на витрине — арт не трогаем вовсе
    if (currentFileId && cardKey === currentAlbumKey) {
      console.log(`[showcase] ${t("showcase_album_reuse")}`);
      return "ok";
    }

    // Этот трек уже заливали в прошлой сессии — ищем арт в галерее
    const existing = await findArtworkByAlbum(steamCommunity, cardKey);
    if (existing) {
      await saveShowcase(steamCommunity, existing, config.showcase.type, config.showcase.slot);
      console.log(`[showcase] ${t("showcase_album_reuse_found", { id: existing })}`);
      currentFileId = existing;
      currentAlbumKey = cardKey;
      return "ok";
    }

    const png = await getCard(track); // кэш: повторный трек не рендерится и не качается
    console.log(`[showcase] ${t("showcase_uploading")}`);
    uploadShowcaseArtwork._albumKey = cardKey; // подпись арта ключом карточки
    const fileId = await uploadShowcaseArtwork(steamCommunity, png);
    delete uploadShowcaseArtwork._albumKey;
    console.log(`[showcase] ${t("showcase_uploaded", { id: fileId })}`);
    // Арты заливаются сразу публичными (visibility=0 в форме загрузки) — публикация не нужна
    await saveShowcase(steamCommunity, fileId, config.showcase.type, config.showcase.slot);
    console.log(`[showcase] ${t("showcase_updated")}`);
    currentFileId = fileId;
    currentAlbumKey = cardKey;
    // Чистим прошлые карточки — в галерее остаётся только актуальная
    const deleted = await cleanupOldArtworks(steamCommunity, fileId);
    if (deleted > 0) console.log(`[showcase] ${t("showcase_cleanup_done", { count: deleted })}`);
    return "ok";
  } catch (e) {
    delete uploadShowcaseArtwork._albumKey;
    console.error(`[showcase] ${t("showcase_failed", { message: e.message })}`);
    return "retry"; // попробуем в следующих кругах (обычно 429 — лимит)
  }
}

// Трек остановился: убираем карточку — удаляем арт из галереи и пустим витрину.
// Пустая витрина Steam на профиле не отрисовывает.
async function clearShowcase() {
  try {
    if (currentFileId) {
      const ok = await deleteArtwork(steamCommunity, currentFileId);
      if (ok) console.log(`[showcase] ${t("showcase_cleared", { id: currentFileId })}`);
      currentFileId = null;
      currentAlbumKey = null;
      return;
    }
    // fileId не знаем (напр. бот перезапустился во время паузы) — чистим только
    // наши: с невидимой подписью бота или старым видимым именем "now-playing".
    // Личные иллюстрации пользователя без подписи не трогаем.
    const { body } = await reqRetry(steamCommunity, "GET", { uri: `${myProfileUrl()}/images` });
    for (const [id, text] of parseGalleryItems(body)) {
      const ours = text.includes(ART_SIGNATURE) || text.trim() === LEGACY_TITLE;
      if (!ours) continue; // не наш арт — не трогаем
      const ok = await deleteArtwork(steamCommunity, id);
      if (ok) console.log(`[showcase] ${t("showcase_cleared", { id })}`);
    }
  } catch (e) {
    console.error(`[showcase] ${t("showcase_failed", { message: e.message })}`);
  }
}

async function main() {
  await ensureLanguage(); // первый запуск: выбор языка (ru/en) -> сохраняется в .env
  // Только авторизация Steam: вход по QR/паролю/токену, refresh-token в
  // tokens.json и выход — без мастера ников и цикла. Используется лончером
  // (Settings -> Steam login), чтобы бот стартовал уже залогиненным.
  if (process.argv.includes("--login")) {
    await login();
    console.log(`[steam] ${t("login_ok")}`);
    process.exit(0);
  }
  // Служебные флаги (--check-updates, --check-sites, --update, ...) идут
  // до мастера первого запуска: кнопка в лончере не должна превращаться
  // в начальную настройку, если SETUP_DONE ещё не записан.
  const hasCliFlag = process.argv.length > 2;
  if (!hasCliFlag) await ensureNicknames(); // первый запуск: ники last.fm/stats.fm (Enter — пропустить)
  const runOnce = process.argv.includes("--once");

  // Проверка обновлений: сравнить локальную версию с последним релизом и выйти.
  // Коды выхода для лончера: 0 = обновлений нет, 3 = есть обновление, 1 = ошибка.
  if (process.argv.includes("--check-updates")) {
    const r = await checkForUpdates();
    const version = r.version ? `${r.version} (${r.remote.slice(0, 7)})` : r.remote.slice(0, 7);
    if (r.error) {
      console.log(`[update] ${t("update_check_failed", { message: r.error })}`);
      process.exitCode = 1;
    } else if (r.versionUnknown) {
      console.log(`[update] ${t("update_version_unknown")}`);
    } else if (r.updateAvailable) {
      console.log(`[update] ${t("update_available", { version })}`);
      process.exitCode = 3;
    } else {
      console.log(`[update] ${t("update_up_to_date", { version })}`);
    }
    return;
  }

  // Диагностика сети: доступны ли источники (с учётом прокси из .env)
  if (process.argv.includes("--check-sites")) {
    const { ProxyAgent } = await import("undici");
    const p = process.env.UPDATE_PROXY || config.lastfm.proxy || "";
    const dispatcher = p ? new ProxyAgent(p) : undefined;
    const targets = [
      ["stats.fm API", "https://api.stats.fm/api/v1/users/1", false],
      ["last.fm API", `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(config.lastfm.username || "rj")}&api_key=${config.lastfm.apiKey}&format=json&limit=1`, true],
      ["Steam community", "https://steamcommunity.com/", false],
      ["Steam store", "https://store.steampowered.com/", false],
      ["GitHub API", "https://api.github.com/rate_limit", true],
      ["iTunes Search", "https://itunes.apple.com/search?term=a&limit=1", false],
    ];
    for (const [name, url, viaProxy] of targets) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          dispatcher: viaProxy && dispatcher ? dispatcher : undefined,
          headers: { "User-Agent": "steam-now-playing" },
          signal: AbortSignal.timeout(8000),
        });
        console.log(`[net] ${name.padEnd(18)} OK   HTTP ${res.status}  ${Date.now() - t0}ms${viaProxy && p ? "  (proxy)" : ""}`);
      } catch (e) {
        console.log(`[net] ${name.padEnd(18)} FAIL ${String(e.message).slice(0, 40)}  ${Date.now() - t0}ms${viaProxy && p ? "  (proxy)" : ""}`);
      }
    }
    return;
  }

  // Обновление: git pull если репозиторий, иначе ZIP с GitHub (без git)
  if (process.argv.includes("--update")) {
    console.log(`[update] ${t("update_start")}`);
    const r = await performUpdateAuto();
    if (r.ok) {
      console.log(`[update] ${t("update_done")}`);
      if (r.npmDone) console.log(`[update] ${t("update_done_npm")}`);
      if (r.message) console.log(`[update] ${r.message}`);
    } else {
      console.error(`[update] ${t("update_failed", { message: r.message })}`);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (process.argv.includes("--check-sources")) {
    const track = await getNowPlaying();
    console.log(JSON.stringify(track, null, 2));
    return;
  }

  // Тестовый режим: ставит фиксированный статус и держит процесс живым.
  // Если "TEST ..." не виден в профиле — дело не в треках (приватность/сессия).
  if (process.argv.includes("--status-test")) {
    await login();
    const text = `TEST STATUS ${Math.floor(Date.now() / 1000) % 100000}`;
    console.log(`[test] ${t("test_set", { text })}`);
    setNowPlayingText(text);
    console.log(`[test] ${t("test_check")}`);
    setInterval(() => {}, 1 << 30);
    return;
  }

  // Разовый тест витрины: карточка из текущего трека -> заливка -> витрина -> выход
  if (process.argv.includes("--showcase-test")) {
    await login();
    console.log(`[test] ${t("test_showcase")}`);
    let track = await getNowPlaying();
    if (!track) {
      track = { title: "Test Track", artist: "Test Artist", album: "", coverUrl: null, source: "test" };
    }
    const png = await getCard(track);
    const fileId = await uploadShowcaseArtwork(steamCommunity, png);
    console.log(`[showcase] ${t("showcase_uploaded", { id: fileId })}`);
    await saveShowcase(steamCommunity, fileId, config.showcase.type, config.showcase.slot);
    console.log(`[showcase] ${t("showcase_updated")}`);
    process.exit(0);
  }

  // Переключить слот профиля на витрину нужного типа (SHOWCASE_TYPE/SHOWCASE_SLOT)
  if (process.argv.includes("--showcase-slot")) {
    await login();
    const type = config.showcase.type;
    const slot = config.showcase.slot;
    console.log(`[test] ${t("showcase_slot_applying", { slot, type })}`);
    const { setShowcaseSlot } = await import("./showcase.js");
    try {
      await setShowcaseSlot(steamCommunity, slot, type);
    } catch (e) {
      if (/429/.test(e.message)) {
        console.log(`[test] ${t("showcase_slot_retrying")}`);
        await new Promise((r) => setTimeout(r, 90000));
        await setShowcaseSlot(steamCommunity, slot, type);
      } else {
        throw e;
      }
    }
    console.log(`[test] ${t("showcase_slot_done")}`);
    process.exit(0);
  }

  // Дебаг: сохранить страницу edit/showcases в файл для анализа
  if (process.argv.includes("--dump-showcases")) {
    await login();
    const url = `${myProfileUrl()}/edit/showcases`;
    const { body } = await reqRetry(steamCommunity, "GET", { uri: url }, 6);
    fs.writeFileSync("showcases-debug.html", body);
    console.log(`[debug] Saved showcases-debug.html (${body.length} bytes)`);
    process.exit(0);
  }

  // Проверка обновлений на старте — всегда с видимой строкой версии
  // (не блокирует запуск; сетевые ошибки показываются кратко).
  // Повторная проверка каждые 6 часов — тихо, только при наличии обновления.
  const firstCheck = true;
  const announceUpdate = async (verbose) => {
    try {
      const r = await checkForUpdates();
      if (r.error) {
        if (verbose) console.log(`[update] ${t("update_check_failed", { message: r.error })}`);
        return;
      }
      if (r.versionUnknown) {
        // ZIP-установка без .version: версию не определить — подсказка один раз
        if (verbose) console.log(`[update] ${t("update_version_unknown")}`);
        return;
      }
      const version = r.version ? `${r.version} (${r.remote.slice(0, 7)})` : r.remote.slice(0, 7);
      if (r.updateAvailable) {
        console.log(`[update] ${t("update_available", { version })}`);
        console.log(`[update] ${t("update_hint")}`);
      } else if (verbose) {
        console.log(`[update] ${t("update_up_to_date", { version })}`);
      }
    } catch (e) {
      if (verbose) console.log(`[update] ${t("update_check_failed", { message: e.message })}`);
    }
  };
  announceUpdate(firstCheck);
  setInterval(() => announceUpdate(false), 6 * 60 * 60 * 1000).unref?.(); // и раз в 6 часов

  // Одна копия бота: занимаем локальный порт — второй экземпляр сразу выйдет.
  // Два бота на одном аккаунте = война сессий Steam (LogonSessionReplaced).
  // Порт освобождается автоматически при закрытии процесса (net, не lock-файл).
  await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      console.error(`[main] ${t("already_running")}`);
      process.exit(0);
    });
    srv.listen(54321, "127.0.0.1", () => {
      srv.unref(); // не держим процесс ради слушателя
      resolve();
    });
  });

  await login();

  // Один цикл проверки и выход — для планировщика задач (cron, Task Scheduler)
  if (runOnce) {
    const track = await getNowPlaying();
    const playing = !!(track && track.playing);
    if (!playing) {
      console.log(`[main] ${t("nothing_playing")}`);
      clearNowPlaying();
      if (config.showcase.enabled) await clearShowcase();
    } else {
      console.log(`[main] ${t("now_playing", { title: track.title, artist: track.artist, source: track.source })}`);
      setNowPlayingText(formatStatus(track));
      if (config.showcase.enabled) await updateShowcase(track);
    }
    process.exit(0);
  }

  // Самоперепланирующийся цикл: config.pollMs читается каждый круг,
  // так что правка POLL_INTERVAL_MS в .env подхватывается без перезапуска
  const pollLoop = async () => {
    let pendingShowcase = false; // витрина ждёт обновления (первый трек, смена, возобновление)
    let idleCount = 0; // подряд идущих кругов без трека — для сжатого лога
    for (;;) {
      try {
        const track = await getNowPlaying();
        const playing = !!(track && track.playing);
        // Ключ включает состояние play/pause: при паузе трек тот же,
        // но статус должен сброситься
        const stateKey = playing ? `on|${track.artist}|${track.title}` : "off";
        if (stateKey !== lastStateKey) {
          lastStateKey = stateKey;

          if (!playing) {
            idleCount++;
            if (idleCount === 1 || idleCount % 60 === 0) {
              // «Ничего не играет» — один раз, потом раз в ~2 минуты (не спамим)
              console.log(`[main] ${t("nothing_playing")}`);
            }
            clearNowPlaying(); // не ставим никакой статус вообще
            pendingShowcase = false;
            if (config.showcase.enabled) await clearShowcase();
          } else {
            idleCount = 0;
            console.log(`[main] ${t("now_playing", { title: track.title, artist: track.artist, source: track.source })}`);
            setNowPlayingText(formatStatus(track));
            if (config.showcase.enabled) pendingShowcase = true;
          }
        } else if (!playing) {
          idleCount++;
        }

        // Витрина обновляется отдельно от статуса: если обложка ещё не
        // подгрузилась в источнике или сработал интервал — ретраим в следующих кругах
        if (playing && config.showcase.enabled && pendingShowcase) {
          const result = await updateShowcase(track);
          if (result !== "retry") pendingShowcase = false;
        }
      } catch (e) {
        console.error(`[main] ${t("poll_failed", { message: e.message })}`);
      }
      // Плавная остановка по флагу: лончер создаёт stop.flag — бот успевает
      // почистить арты витрины и корректно выйти (taskkill /f пропустил бы это)
      try {
        if (fs.existsSync(STOP_FLAG)) {
          fs.rmSync(STOP_FLAG, { force: true });
          await shutdown("stop-flag");
        }
      } catch {}
      await new Promise((r) => setTimeout(r, Math.max(1000, config.pollMs)));
    }
  };
  // Аккуратное завершение: Ctrl+C (SIGINT) и закрытие окна консоли на Windows
  // (Node присылает SIGHUP). Убираем карточку из «Иллюстраций», чтобы в профиле
  // не висел последний трек. Windows даёт на закрытие окна ~5 секунд, поэтому
  // ждём максимум 8с и не сканируем галерею повторно.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[main] ${t("shutdown_start", { signal })}`);
    try {
      if (!config.showcase.enabled) {
        // витрина выключена — чистить нечего
      } else if (!config.showcase.clearOnExit) {
        console.log(`[main] ${t("shutdown_keep_art")}`);
      } else {
        await Promise.race([
          clearShowcase(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(t("shutdown_timeout"))), 8000)),
        ]);
      }
    } catch (e) {
      console.error(`[main] ${t("shutdown_failed", { message: e.message })}`);
    }
    console.log(`[main] ${t("shutdown_done")}`);
    // Даём stdout дописаться (при перенаправлении вывод асинхронный)
    await new Promise((r) => setTimeout(r, 150));
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => shutdown(signal));
  }

  pollLoop();

  console.log(`[main] ${t("polling", { ms: config.pollMs, date: new Date(startedAt).toISOString() })}`);
}

main().catch((e) => {
  console.error(`[main] ${t("fatal", { message: e.message })}`);
  process.exit(1);
});
