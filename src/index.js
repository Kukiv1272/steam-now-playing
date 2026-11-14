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
} from "./showcase.js";
import { t } from "./i18n.js";
import { checkForUpdates, performUpdateAuto } from "./updater.js";
import { ensureLanguage, ensureNicknames } from "./first-run.js";
import fs from "node:fs";
import net from "node:net";

const startedAt = Date.now();
let lastStateKey = null;
let lastShowcaseAt = 0;
// Дедупликация по альбому: если трек из уже залитого альбома — не заливаем
// арт заново, а переиспользуем существующий fileId (быстрее и меньше 429)
let currentFileId = null;
let currentAlbumKey = null;
// Обложки может не быть нигде (last.fm вернул заглушку, iTunes не нашёл):
// ретраим несколько кругов (источник мог не успеть отдать), потом рисуем
// карточку на градиенте — витрина не должна залипать на старом треке
let noCoverKey = null;
let noCoverCount = 0;

function albumKeyOf(track) {
  // Включаем версию дизайна: после её смены карточки перезаливаются,
  // а старые арты подчищаются — витрина не залипает на устаревшем рендере
  return `${track.artist || ""}||${track.album || ""}||${track.coverUrl || ""}||${CARD_VERSION}`.toLowerCase();
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
  } else {
    noCoverKey = null;
    noCoverCount = 0;
  }
  if (now - lastShowcaseAt < config.showcase.minIntervalMs) return "retry";
  lastShowcaseAt = now;

  const albumKey = albumKeyOf(track);

  try {
    // Тот же альбом, что уже на витрине — арт не трогаем вовсе
    if (currentFileId && albumKey === currentAlbumKey) {
      console.log(`[showcase] ${t("showcase_album_reuse")}`);
      return "ok";
    }

    // Тот же альбом, но заливали в прошлой сессии — ищем арт в галерее
    const existing = await findArtworkByAlbum(steamCommunity, albumKey);
    if (existing) {
      await saveShowcase(steamCommunity, existing, config.showcase.type, config.showcase.slot);
      console.log(`[showcase] ${t("showcase_album_reuse_found", { id: existing })}`);
      currentFileId = existing;
      currentAlbumKey = albumKey;
      return "ok";
    }

    const png = await getCard(track); // кэш: повторный трек не рендерится и не качается
    console.log(`[showcase] ${t("showcase_uploading")}`);
    uploadShowcaseArtwork._albumKey = albumKey; // подпись арта ключом альбома
    const fileId = await uploadShowcaseArtwork(steamCommunity, png);
    delete uploadShowcaseArtwork._albumKey;
    console.log(`[showcase] ${t("showcase_uploaded", { id: fileId })}`);
    // Арты заливаются сразу публичными (visibility=0 в форме загрузки) — публикация не нужна
    await saveShowcase(steamCommunity, fileId, config.showcase.type, config.showcase.slot);
    console.log(`[showcase] ${t("showcase_updated")}`);
    currentFileId = fileId;
    currentAlbumKey = albumKey;
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
    // fileId не знаем (напр. бот перезапустился во время паузы) — чистим всю нашу
    const { body } = await reqRetry(steamCommunity, "GET", { uri: `${myProfileUrl()}/images` });
    const ids = [...new Set([...body.matchAll(/data-publishedfileid="(\d+)"/g)].map((m) => m[1]))];
    for (const id of ids) {
      const ok = await deleteArtwork(steamCommunity, id);
      if (ok) console.log(`[showcase] ${t("showcase_cleared", { id })}`);
    }
  } catch (e) {
    console.error(`[showcase] ${t("showcase_failed", { message: e.message })}`);
  }
}

async function main() {
  await ensureLanguage(); // первый запуск: выбор языка (ru/en) -> сохраняется в .env
  await ensureNicknames(); // первый запуск: ники last.fm/stats.fm (Enter — пропустить)
  const runOnce = process.argv.includes("--once");

  // Проверка обновлений: сравнить HEAD с GitHub и выйти
  if (process.argv.includes("--check-updates")) {
    const r = await checkForUpdates();
    if (r.error) console.log(`[update] ${t("update_check_failed", { message: r.error })}`);
    else if (r.updateAvailable) console.log(`[update] ${t("update_available", { sha: r.remote.slice(0, 7) })}`);
    else console.log(`[update] ${t("update_up_to_date")}`);
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
    console.log(`[test] Назначаю слот ${slot} -> витрина типа ${type}...`);
    const { setShowcaseSlot } = await import("./showcase.js");
    try {
      await setShowcaseSlot(steamCommunity, slot, type);
    } catch (e) {
      if (/429/.test(e.message)) {
        console.log("[test] Лимит держится — финальная попытка через 90с...");
        await new Promise((r) => setTimeout(r, 90000));
        await setShowcaseSlot(steamCommunity, slot, type);
      } else {
        throw e;
      }
    }
    console.log("[test] Слот назначен — проверь профиль");
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

  // Проверка обновлений на старте (не блокирует запуск; ошибки молча)
  const announceUpdate = async () => {
    try {
      const r = await checkForUpdates();
      if (!r.error && r.updateAvailable) {
        console.log(`[update] ${t("update_available", { sha: r.remote.slice(0, 7) })}`);
        console.log(`[update] ${t("update_hint")}`);
      }
    } catch {}
  };
  announceUpdate();
  setInterval(announceUpdate, 6 * 60 * 60 * 1000).unref?.(); // и раз в 6 часов

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
      await new Promise((r) => setTimeout(r, Math.max(1000, config.pollMs)));
    }
  };
  pollLoop();

  console.log(`[main] ${t("polling", { ms: config.pollMs, date: new Date(startedAt).toISOString() })}`);
}

main().catch((e) => {
  console.error(`[main] ${t("fatal", { message: e.message })}`);
  process.exit(1);
});
