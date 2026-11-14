// Первый запуск: если язык не выбран (нет LANG ни в .env, ни в окружении) —
// спрашиваем двуязычным промптом и сохраняем выбор в .env.
// Неинтерактивные запуски (--once в планировщике, скрипты) не спрашивают:
// берётся русский по умолчанию, ничего не сохраняется.
import readline from "node:readline/promises";
import { writeEnvKey, envKeyExists } from "./config.js";
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
    writeEnvKey("SETUP_DONE", "true");
  } finally {
    rl.close();
  }
}
