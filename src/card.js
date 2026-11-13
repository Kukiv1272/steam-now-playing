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

const CACHE_DIR = new URL("../cache/covers/", import.meta.url);
const CARD_CACHE_DIR = new URL("../cache/cards/", import.meta.url);

function coverCachePath(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);
  return new URL(`${hash}.img`, CACHE_DIR);
}

// Returns Buffer of the cover image, downloading once and caching by URL.
// Some CDNs (i.scdn.co) may be unreachable directly — falls back to the
// images.weserv.nl image proxy.
async function fetchCover(url) {
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

function registerFonts() {
  for (const [path, alias] of [
    ["C:\\Windows\\Fonts\\arialbd.ttf", "ArialB"],
    ["C:\\Windows\\Fonts\\arial.ttf", "Arial"],
  ]) {
    try {
      if (fs.existsSync(path)) GlobalFonts.registerFromPath(path, alias);
    } catch {}
  }
}

export async function generateCard(track) {
  registerFonts();
  const W = config.showcase.width;
  const H = config.showcase.height;

  let img = null;
  if (track.coverUrl) {
    try {
      img = await loadImage(await fetchCover(track.coverUrl));
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

  // Текст внизу
  const textTop = y + S + Math.round(H * 0.045);
  ctx.font = `${Math.round(W * 0.062)}px ArialB, sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  ctx.fillText(clip(ctx, track.title || "Unknown", W - margin * 2), margin, textTop);
  ctx.font = `${Math.round(W * 0.048)}px Arial, sans-serif`;
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

  // Название — крупно, перенос до 2 строк
  ctx.font = `${Math.round(H * 0.17)}px ArialB, sans-serif`;
  const titleLines = wrap(ctx, track.title || "Unknown", maxTextW, 2);
  let ty = midY - (titleLines.length - 1) * H * 0.10 - H * 0.02;
  for (const line of titleLines) {
    ctx.fillText(line, textX, ty);
    ty += H * 0.20;
  }

  // Артист
  ctx.font = `${Math.round(H * 0.12)}px Arial, sans-serif`;
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
      `v5|wide=${config.showcase.wide}|${track.artist || ""}|${track.title || ""}|${track.coverUrl || ""}|${config.showcase.width}x${config.showcase.height}`
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
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// Перенос по словам, максимум maxLines строк (последняя с многоточием)
function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (ctx.measureText(next).width <= maxWidth || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (words.join(" ") !== lines.join(" ").trim()) {
      lines[maxLines - 1] = clip(ctx, last, maxWidth);
    }
  }
  return lines;
}
