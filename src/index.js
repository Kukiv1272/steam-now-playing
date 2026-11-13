import { config } from "./config.js";
import { getNowPlaying } from "./sources.js";
import { login, client, community as steamCommunity, setNowPlayingText, clearNowPlaying, myProfileUrl } from "./steam.js";
import { getCard } from "./card.js";
import { uploadShowcaseArtwork, updateShowcase as saveShowcase, cleanupOldArtworks, deleteArtwork, reqRetry } from "./showcase.js";
import { t } from "./i18n.js";
import fs from "node:fs";

const startedAt = Date.now();
let lastStateKey = null;
let lastShowcaseAt = 0;

function formatStatus(track) {
  return config.status.template
    .replaceAll("{title}", track.title || "")
    .replaceAll("{artist}", track.artist || "")
    .replaceAll("{album}", track.album || "")
    .replaceAll("{source}", track.source || "");
}

async function updateShowcase(track) {
  const now = Date.now();
  // Обложки ещё нет (источник не успел отдать) — не съедаем интервал, ретраим позже
  if (!track.coverUrl) {
    console.log(`[showcase] ${t("showcase_no_cover")}`);
    return "retry";
  }
  if (now - lastShowcaseAt < config.showcase.minIntervalMs) return "retry";
  lastShowcaseAt = now;
  try {
    const png = await getCard(track); // кэш: повторный трек не рендерится и не качается
    console.log(`[showcase] ${t("showcase_uploading")}`);
    const fileId = await uploadShowcaseArtwork(steamCommunity, png);
    console.log(`[showcase] ${t("showcase_uploaded", { id: fileId })}`);
    // Арты заливаются сразу публичными (visibility=0 в форме загрузки) — публикация не нужна
    await saveShowcase(steamCommunity, fileId, config.showcase.type, config.showcase.slot);
    console.log(`[showcase] ${t("showcase_updated")}`);
    // Чистим прошлые карточки — в галерее остаётся только актуальная
    const deleted = await cleanupOldArtworks(steamCommunity, fileId);
    if (deleted > 0) console.log(`[showcase] ${t("showcase_cleanup_done", { count: deleted })}`);
    return "ok";
  } catch (e) {
    console.error(`[showcase] ${t("showcase_failed", { message: e.message })}`);
    return "retry"; // попробуем в следующих кругах (обычно 429 — лимит)
  }
}

// Трек остановился: убираем карточку — удаляем арт из галереи и пустим витрину.
// Пустая витрина Steam на профиле не отрисовывает.
async function clearShowcase() {
  try {
    // id текущего арта — со страницы галереи (единственный оставшийся)
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

  await login();

  // Самоперепланирующийся цикл: config.pollMs читается каждый круг,
  // так что правка POLL_INTERVAL_MS в .env подхватывается без перезапуска
  const pollLoop = async () => {
    let pendingShowcase = false; // витрина ждёт обновления (первый трек, смена, возобновление)
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
            console.log(`[main] ${t("nothing_playing")}`);
            clearNowPlaying(); // не ставим никакой статус вообще
            pendingShowcase = false;
            if (config.showcase.enabled) await clearShowcase();
          } else {
            console.log(`[main] ${t("now_playing", { title: track.title, artist: track.artist, source: track.source })}`);
            setNowPlayingText(formatStatus(track));
            if (config.showcase.enabled) pendingShowcase = true;
          }
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
