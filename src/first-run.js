// Первый запуск: если язык не выбран (нет LANG ни в .env, ни в окружении) —
// спрашиваем двуязычным промптом и сохраняем выбор в .env.
// Неинтерактивные запуски (--once в планировщике, скрипты) не спрашивают:
// берётся русский по умолчанию, ничего не сохраняется.
import readline from "node:readline/promises";
import { writeEnvKey, envKeyExists, config } from "./config.js";
import { t } from "./i18n.js";

export async function ensureLanguage() {
  if (process.env.LANG && process.env.LANG.trim()) return; // уже выбран
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.env.LANG = process.env.LANG || "ru"; // молча по умолчанию
    return;
  }

  console.log("Выберите язык / Select language:");
  console.log("  1) Русский");
  console.log("  2) English");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let lang;
  try {
    for (;;) {
      const answer = (await rl.question("1/2: ")).trim().toLowerCase();
      if (answer === "1" || answer === "ru" || answer.startsWith("рус") || answer === "r") {
        lang = "ru";
        break;
      }
      if (answer === "2" || answer === "en" || answer.startsWith("eng") || answer.startsWith("анг")) {
        lang = "en";
        break;
      }
      console.log("Введите 1 или 2 / Enter 1 or 2");
    }
  } finally {
    rl.close();
  }

  writeEnvKey("LANG", lang);
  console.log(
    lang === "ru"
      ? "Язык сохранён: русский (сменить можно в .env — LANG=en)"
      : "Language saved: English (change in .env — LANG=ru)",
  );
}

// Ввод ников источников: last.fm и stats.fm. Enter — пропустить, поле
// остаётся пустым в .env. Мастер срабатывает один раз (маркер SETUP_DONE).
// Уже заполненные поля при пропуске не затираются.
export async function ensureNicknames() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return; // неинтерактивный запуск — не спрашиваем
  if (envKeyExists("SETUP_DONE")) return; // мастер уже проходили

  const fields = [
    ["LASTFM_USERNAME", "nickname_lastfm_prompt"],
    ["STATSFM_USERNAME", "nickname_statsfm_prompt"],
  ];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [key, promptKey] of fields) {
      const answer = (await rl.question(t(promptKey))).trim();
      if (answer) {
        writeEnvKey(key, answer);
        console.log(t("nickname_saved", { key, value: answer }));
      } else if (!envKeyExists(key)) {
        writeEnvKey(key, ""); // поле остаётся пустым в .env
        console.log(t("nickname_left_empty", { key }));
      }
      // Если пропущено, но ключ уже есть со значением — не трогаем
    }
    await askShowcaseSetup(rl);
    writeEnvKey("SETUP_DONE", "true");
  } finally {
    rl.close();
  }
}

// Настройка витрины: тип -> ориентация карточки -> номер витрины на профиле.
// Каждый вопрос можно пропустить (Enter) — тогда значение в .env не меняется.
export async function askShowcaseSetup(rl) {
  console.log(t("showcase_setup_title"));
  const type = await askShowcaseType(rl);
  const stretch = await askShowcaseOrientation(rl);
  const slot = await askShowcaseSlot(rl);
  if (slot !== null) console.log(t("showcase_slot_apply_hint"));
  if (stretch !== null && stretch !== "none") {
    console.log(t("showcase_size_hint", { width: config.showcase.width, height: config.showcase.height }));
    if (type === 13) console.log(t("showcase_stretch_type13_hint"));
  }
  return { type, stretch, slot };
}

// Выбор типа витрины: 22 = избранная иллюстрация (одна большая),
// 13 = витрина иллюстраций (2x2). Enter — пропустить (остаётся как есть).
// rl передаётся параметром — тестируется с фейковым интерфейсом.
export async function askShowcaseType(rl) {
  console.log(t("showcase_type_prompt_title"));
  console.log(t("showcase_type_opt_featured"));
  console.log(t("showcase_type_opt_artwork"));
  for (;;) {
    const answer = (await rl.question("1/2: ")).trim().toLowerCase();
    if (!answer) {
      console.log(t("showcase_type_skipped"));
      return null;
    }
    if (answer === "1" || answer === "22") {
      writeEnvKey("SHOWCASE_TYPE", "22");
      console.log(t("showcase_type_saved", { value: 22 }));
      return 22;
    }
    if (answer === "2" || answer === "13") {
      writeEnvKey("SHOWCASE_TYPE", "13");
      console.log(t("showcase_type_saved", { value: 13 }));
      return 13;
    }
    console.log(t("showcase_type_invalid"));
  }
}

// Ориентация карточки в витрине: wide — растянуть по ширине, vertical — по
// высоте, none — без растяжения. Пишется в SHOWCASE_STRETCH (SHOWCASE_WIDE
// остаётся устаревшим синонимом wide).
export async function askShowcaseOrientation(rl) {
  console.log(t("showcase_orient_prompt_title"));
  console.log(t("showcase_orient_opt_wide"));
  console.log(t("showcase_orient_opt_vertical"));
  console.log(t("showcase_orient_opt_none"));
  for (;;) {
    const answer = (await rl.question("1/2/3: ")).trim().toLowerCase();
    if (!answer) {
      console.log(t("showcase_orient_skipped"));
      return null;
    }
    let stretch = null;
    if (answer === "1" || answer === "wide" || answer === "горизонтально") stretch = "wide";
    else if (answer === "2" || answer === "vertical" || answer === "вертикально") stretch = "vertical";
    else if (answer === "3" || answer === "none" || answer === "обычная") stretch = "none";
    if (!stretch) {
      console.log(t("showcase_orient_invalid"));
      continue;
    }
    writeEnvKey("SHOWCASE_STRETCH", stretch);
    console.log(t("showcase_orient_saved", { value: stretch }));
    return stretch;
  }
}

// Номер витрины на профиле (1 = первая сверху). В .env хранится с нуля —
// как индекс слота витрины на странице edit/showcases.
export async function askShowcaseSlot(rl) {
  for (;;) {
    const answer = (await rl.question(t("showcase_slot_prompt"))).trim();
    if (!answer) {
      console.log(t("showcase_slot_skipped"));
      return null;
    }
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 20) {
      writeEnvKey("SHOWCASE_SLOT", String(n - 1));
      console.log(t("showcase_slot_saved", { value: n, index: n - 1 }));
      return n - 1;
    }
    console.log(t("showcase_slot_invalid"));
  }
}
