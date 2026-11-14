import fs from "node:fs";
import crypto from "node:crypto";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { config } from "./config.js";
import { t } from "./i18n.js";

// Track card for the artwork showcase. Two layouts:
// - portrait (default): 630x800, square cover on blurred backdrop
// - banner (SHOWCASE_WIDE=true): wide artwall, uploaded with fake dims
//   (image_width=999999, image_height=1) so Steam stretches it full-width.
// Covers are cached on disk (cache/covers/<hash>.img), generated cards too
// (cache/cards/<hash>.png) — repeated tracks reuse cached files.

// Версия дизайна карточки: участвует в ключе кэша и в ключе альбома —
// после изменения дизайна карточки перерисовываются и перезаливаются.
export const CARD_VERSION = "v6";

const CACHE_DIR = new URL("../cache/covers/", import.meta.url);
const CARD_CACHE_DIR = new URL("../cache/cards/", import.meta.url);

function coverCachePath(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);
  return new URL(`${hash}.img`, CACHE_DIR);
}

// Returns Buffer of the cover image, downloading once and caching by URL.
// Some CDNs (i.scdn.co) may be unreachable directly — falls back to the
// images.weserv.nl image proxy.
// last.fm placeholder (grey square with a music note) is rejected: for such
// covers we return null and the card renders on a plain gradient instead.
const LASTFM_PLACEHOLDER_HASHES = new Set([
  "2a96cbd8b46e442fc41c2b86b821562f", // classic grey + note
]);

function isPlaceholderUrl(url) {
  const m = url.match(/([0-9a-f]{32})(?:\.\w+)?(?:$|[/?])/i);
  return !!(m && LASTFM_PLACEHOLDER_HASHES.has(m[1].toLowerCase()));
}

async function fetchCover(url) {
  if (isPlaceholderUrl(url)) return null; // заглушка — карточка рисует градиент без ноты
  const path = coverCachePath(url);
  try {
    return fs.readFileSync(path);
  } catch {}

  let buf = null;
  const attempts = [url, `https://images.weserv.nl/?url=${url.replace(/^https?:\/\//, "")}`];
  for (const candidate of attempts) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (e) {
      console.error(`[card] ${t("card_cover_attempt_failed", { message: e.message })}`);
    }
  }
  if (!buf) throw new Error(t("card_cover_failed", { message: "all sources failed" }));

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path, buf);
  } catch {}
  return buf;
}

// Шрифтовая система: регистрируем все языковые шрифты Windows и выбираем
// подходящий под текст трека. Arial не содержит CJK-глифов — без этого
// японские/китайские/корейские названия превращаются в квадраты.
const FONT_FILES = [
  ["C:\\Windows\\Fonts\\arialbd.ttf", "ArialB"], // латиница/кириллица, жирный
  ["C:\\Windows\\Fonts\\arial.ttf", "Arial"],
  ["C:\\Windows\\Fonts\\YuGothB.ttc", "YuGothB"], // японский, жирный
  ["C:\\Windows\\Fonts\\YuGothM.ttc", "YuGothM"], // японский, обычный
  ["C:\\Windows\\Fonts\\msyhbd.ttc", "CJK-B"], // китайский (упр.), жирный
  ["C:\\Windows\\Fonts\\msyh.ttc", "CJK"],
  ["C:\\Windows\\Fonts\\msjhbd.ttc", "CJK-TC-B"], // китайский (трад.)
  ["C:\\Windows\\Fonts\\malgunbd.ttf", "Korean-B"], // корейский, жирный
  ["C:\\Windows\\Fonts\\malgun.ttf", "Korean"],
  ["C:\\Windows\\Fonts\\seguiemj.ttf", "Emoji"], // эмодзи
  ["C:\\Windows\\Fonts\\segoeuib.ttf", "SegoeB"],
  ["C:\\Windows\\Fonts\\segoeui.ttf", "Segoe"],
];

const registeredFonts = new Set();

function registerFonts() {
  for (const [path, alias] of FONT_FILES) {
    try {
      if (fs.existsSync(path) && GlobalFonts.registerFromPath(path, alias)) {
        registeredFonts.add(alias);
      }
    } catch {}
  }
}

// Порядок предпочтения шрифтов для строки; возвращает первый зарегистрированный
function pickFont(candidates) {
  for (const alias of candidates) if (registeredFonts.has(alias)) return alias;
  return registeredFonts.has("ArialB") ? "ArialB" : [...registeredFonts][0] || "sans-serif";
}

// Определяем "самый сложный" сценарий в строке: кана -> японский, хангыль ->
// корейский, идеографы -> китайский, кириллица -> Arial. Latin-дополнение у
// CJK-шрифтов есть, так что смешанные строки покрываются.
function fontFor(text, bold = true) {
  const s = /[\u3040-\u30ff\u31f0-\u31ff]/.test(text)
    ? "ja"
    : /[\uac00-\ud7af\u1100-\u11ff]/.test(text)
      ? "ko"
      : /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text)
        ? "zh"
        : "latin";
  switch (s) {
    case "ja":
      return bold ? pickFont(["YuGothB", "CJK-B", "Korean-B"]) : pickFont(["YuGothM", "CJK", "Korean"]);
    case "ko":
      return bold ? pickFont(["Korean-B", "CJK-B", "YuGothB"]) : pickFont(["Korean", "CJK", "YuGothM"]);
    case "zh":
      return bold ? pickFont(["CJK-B", "YuGothB", "Korean-B"]) : pickFont(["CJK", "YuGothM", "Korean"]);
    default:
      return bold ? pickFont(["ArialB", "SegoeB"]) : pickFont(["Arial", "Segoe"]);
  }
}

// Строка ctx.font: основное семейство по скрипту + запасные зарегистрированные.
// Skia использует список как fallback-цепочку для отдельных глифов.
function fontStack(primary, sizePx, bold = true) {
  const others = [...registeredFonts].filter((a) => a !== primary && !/Emoji/.test(a));
  const quoted = [primary, ...others].map((a) => `"${a}"`).join(", ");
  return `${bold ? "bold " : ""}${Math.round(sizePx)}px ${quoted}, sans-serif`;
}

export async function generateCard(track) {
  registerFonts();
  const W = config.showcase.width;
  const H = config.showcase.height;

  let img = null;
  if (track.coverUrl) {
    try {
      const buf = await fetchCover(track.coverUrl);
      if (buf) img = await loadImage(buf);
      // buf === null — заглушка last.fm: рисуем карточку на градиенте без ноты
    } catch (e) {
      console.error(`[card] ${t("card_cover_failed", { message: e.message })}`);
    }
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  drawBackdrop(ctx, img, W, H);

  if (config.showcase.wide) {
    drawBannerContent(ctx, track, img, W, H);
  } else {
    drawPortraitContent(ctx, img, W, H);
  }

  return canvas.toBuffer("image/png");
}

// Фон: размытая обложка на весь холст + затемняющий градиент
// (blur через даунскейл до крошечного размера и апскейл — надёжно и быстро)
function drawBackdrop(ctx, img, W, H) {
  if (!img) {
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(0, 0, W, H);
    return;
  }

  // Средние цвета обложки: левая половина -> фон градиента №1 (более тёмный),
  // правая -> №2. Даунскейл до 1x1 по половинам даёт усреднённый цвет.
  const avg = (sx, sw) => {
    const c = createCanvas(sw, 1);
    c.getContext("2d").drawImage(img, sx, 0, sw, img.height, 0, 0, sw, 1);
    const d = c.getContext("2d").getImageData(0, 0, sw, 1).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2];
    }
    const n = d.length / 4;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  const half = Math.max(1, Math.floor(img.width / 2));
  const [r1, g1, b1] = avg(0, half);
  const [r2, g2, b2] = avg(half, img.width - half);

  // Диагональный градиент из цветов обложки, приглушённый под текст
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, `rgb(${r1},${g1},${b1})`);
  grad.addColorStop(1, `rgb(${r2},${g2},${b2})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Лёгкое затемнение поверх градиента для читаемости текста
  const shade = ctx.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0.35)");
  shade.addColorStop(1, "rgba(0,0,0,0.60)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
}

// Вертикальная карточка: квадратная обложка ЦЕЛИКОМ (без кропа),
// закруглённые углы, тень, текст внизу
function drawPortraitContent(ctx, img, W, H) {
  const margin = Math.round(W * 0.065);
  const S = W - margin * 2; // сторона квадрата
  const x = margin;
  const y = Math.round(H * 0.075);

  drawCover(ctx, img, x, y, S);

  // Текст внизу — шрифт подбирается под скрипт названия (CJK-названия
  // рендерятся Yu Gothic и т.п., латиница/кириллица — Arial)
  const textTop = y + S + Math.round(H * 0.045);
  ctx.font = fontStack(fontFor(track.title, true), W * 0.062);
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.fillText(clip(ctx, track.title || "Unknown", W - margin * 2), margin, textTop);
  ctx.font = fontStack(fontFor(track.artist, false), W * 0.048, false);
  ctx.fillStyle = "#cfcfcf";
  ctx.fillText(clip(ctx, track.artist || "Unknown artist", W - margin * 2), margin, textTop + Math.round(W * 0.075));
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
}

// Широкий баннер: обложка слева (крупная), название/артист справа
function drawBannerContent(ctx, track, img, W, H) {
  const margin = Math.round(H * 0.055);
  const S = H - margin * 2; // обложка почти во всю высоту баннера
  const x = margin;
  const y = margin;

  drawCover(ctx, img, x, y, S);

  // Текст справа от обложки, вертикально по центру
  const textX = x + S + margin * 1.4;
  const maxTextW = W - textX - margin;
  const midY = H / 2;

  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 10;

  // Название — крупно, перенос до 2 строк (CJK-строки без пробелов
  // переносятся посимвольно)
  ctx.font = fontStack(fontFor(track.title, true), H * 0.17);
  const titleLines = wrap(ctx, track.title || "Unknown", maxTextW, 2);
  let ty = midY - (titleLines.length - 1) * H * 0.10 - H * 0.02;
  for (const line of titleLines) {
    ctx.fillText(line, textX, ty);
    ty += H * 0.20;
  }

  // Артист
  ctx.font = fontStack(fontFor(track.artist, false), H * 0.12, false);
  ctx.fillStyle = "#e0e0e0";
  ctx.fillText(clip(ctx, track.artist || "Unknown artist", maxTextW), textX, ty + H * 0.01);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.textBaseline = "alphabetic";
}

// Квадратная обложка с тенью, закруглёнными углами и светлой рамкой.
// contain-fit: квадратная обложка влезает целиком, ничего не срезается.
function drawCover(ctx, img, x, y, S) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  roundRectPath(ctx, x, y, S, S, 18);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, S, S, 18);
  ctx.clip();
  if (img) {
    const scale = Math.min(S / img.width, S / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, x + (S - dw) / 2, y + (S - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(x, y, S, S);
  }
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x + 0.5, y + 0.5, S - 1, S - 1, 18);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Путь скруглённого прямоугольника
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Кэш готовых карточек: ключ = версия дизайна + трек + размер + режим.
// Повторный трек = мгновенная выдача PNG без скачивания обложки и рендера.
export async function getCard(track) {
  const key = crypto
    .createHash("sha1")
    .update(
      `${CARD_VERSION}|wide=${config.showcase.wide}|${track.artist || ""}|${track.title || ""}|${track.coverUrl || ""}|${config.showcase.width}x${config.showcase.height}`
    )
    .digest("hex")
    .slice(0, 24);
  const path = new URL(`${key}.png`, CARD_CACHE_DIR);
  try {
    return fs.readFileSync(path);
  } catch {}

  const png = await generateCard(track);
  try {
    fs.mkdirSync(CARD_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path, png);
  } catch {}
  return png;
}

function clip(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  // Режем по кодпоинтам (Array.from), чтобы не сломать эмодзи/суррогатные пары
  const chars = Array.from(text);
  while (chars.length > 1 && ctx.measureText(chars.join("") + "…").width > maxWidth) chars.pop();
  return chars.join("") + "…";
}

// Перенос по словам, максимум maxLines строк (последняя с многоточием).
// Слово шире строки (CJK-названия почти без пробелов) переносится посимвольно.
function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";

  const pushCur = () => {
    if (cur) {
      lines.push(cur);
      cur = "";
    }
  };

  for (const w of words) {
    if (ctx.measureText(w).width > maxWidth) {
      // Слово не влезает целиком — символ за символом
      pushCur();
      for (const ch of Array.from(w)) {
        if (cur && ctx.measureText(cur + ch).width > maxWidth) {
          lines.push(cur);
          cur = ch;
          if (lines.length === maxLines) break;
        } else {
          cur += ch;
        }
      }
      if (lines.length === maxLines) break;
      continue;
    }
    const next = cur ? cur + " " + w : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) {
      cur = next;
    } else {
      pushCur();
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  pushCur();

  if (lines.length > maxLines) lines.length = maxLines;
  const rendered = lines.join(" ").trim();
  if (rendered !== String(text).trim()) {
    lines[maxLines - 1] = clip(ctx, lines[maxLines - 1], maxWidth);
  }
  return lines;
}
