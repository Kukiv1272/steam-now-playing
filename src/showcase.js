import { myProfileUrl } from "./steam.js";
import { t } from "./i18n.js";
import { config } from "./config.js";

// Experimental: upload the track card as profile artwork and set it in the
// artwork showcase. Steam community endpoints are undocumented; this is
// best-effort — failures are logged and skipped. Enable via SHOWCASE_ENABLED=true
// or test one-shot with: node src/index.js --showcase-test

// steamcommunity httpRequest* are callback-based (and not concurrency-safe):
// wrap into a promise, always call sequentially.
function req(community, method, options) {
  return new Promise((resolve, reject) => {
    const fn = method === "POST" ? community.httpRequestPost : community.httpRequestGet;
    fn.call(community, options, (err, res, body) => {
      if (err) reject(err);
      else resolve({ res, body });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Steam лимитирует edit-эндпоинты (429) — ретраим с экспоненциальной выдержкой:
// 5с, 10с, 20с, 40с... (кап 60с), чтобы не долбить API во время долгого лимита
async function reqRetry(community, method, options, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await req(community, method, options);
    } catch (e) {
      if (i < attempts - 1 && /HTTP error 429|HTTP error 5\d\d/.test(e.message)) {
        const wait = Math.min(60000, 5000 * 2 ** i);
        console.log(`[showcase] ${t("showcase_rate_limited", { wait: wait / 1000 })}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

export { req, reqRetry };

export async function uploadShowcaseArtwork(community, buffer) {
  // Флоу как на сайте: GET страницы загрузки арта -> парсим форму -> POST файла
  const { body } = await req(community, "GET", {
    uri: "https://steamcommunity.com/sharedfiles/edititem/767/3/",
  });
  if (!body || !body.includes('id="SubmitItemForm"')) {
    throw new Error(t("showcase_no_upload_form"));
  }

  const { load } = await import("cheerio");
  const $ = load(body);
  const action = $("#SubmitItemForm").attr("action");
  if (!action) throw new Error(t("showcase_no_upload_form"));

  const data = {};
  $("#SubmitItemForm input").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const type = ($el.attr("type") || "").toLowerCase();
    if (type === "hidden" || type === "") data[name] = $el.attr("value") ?? "";
  });
  const prefixMatch = body.match(/cloudfilenameprefix\.value\s*=\s*'([^']+)';/);
  if (prefixMatch) data.cloudfilenameprefix = prefixMatch[1];

  if (config.showcase.stretch === "wide") {
    // Artwall-трюк: заявляем "очень широкую" картинку — Steam растягивает
    // её на всю ширину витрины без letterbox-полос
    data.image_width = "999999";
    data.image_height = "1";
  } else if (config.showcase.stretch === "vertical") {
    // Вертикальный вариант: "очень высокая" картинка — Steam растягивает
    // её на всю высоту блока витрины
    data.image_width = "1";
    data.image_height = "999999";
  } else {
    data.image_width = String(config.showcase.width);
    data.image_height = String(config.showcase.height);
  }
  // Невидимая подпись бота: только в названии — Steam валидирует длину названия
  // и отклоняет >20 ZW символов ("Invalid Parameter"). Метка альбома (тоже
  // невидимая) идёт в описание — по ней треки одного альбома переиспользуют
  // залитый арт без перезаливки.
  data.title = ART_SIGNATURE;
  data.description = ART_SIGNATURE + albumTag(uploadShowcaseArtwork._albumKey || "nocover");
  data.visibility = "0"; // public
  data.agree_terms = "on";

  const { res } = await req(community, "POST", {
    uri: action,
    formData: {
      ...data,
      file: {
        value: buffer,
        options: { filename: "now-playing.png", contentType: "image/png" },
      },
    },
    followRedirect: false,
  });

  const loc = res.headers?.location || "";
  const idMatch = loc.match(/id=(\d+)/) || (res.body ? String(res.body).match(/filedetails\/\?id=(\d+)/) : null);
  if (idMatch) return idMatch[1];
  throw new Error(`Upload response without file id (HTTP ${res.statusCode})`);
}

// Реальный механизм сохранения витрины (как это делает сайт):
// POST /ajaxsetshowcaseconfig с customization_type/purchaseid/slot + поля слота.
// Типы: 22 = Featured Artwork (одна большая), 13 = Artwork 2x2 (slot = ячейка 0..3)
export async function updateShowcase(community, publishedFileId, showcaseType = 22, slot = 0) {
  const url = `${myProfileUrl()}/ajaxsetshowcaseconfig`;
  const form = new URLSearchParams();
  form.set("customization_type", String(showcaseType));
  form.set("purchaseid", "0");
  form.set("slot", String(slot));
  form.set("sessionid", community.getSessionID());
  form.set("publishedfileid", String(publishedFileId));

  const { res, body } = await reqRetry(community, "POST", {
    uri: url,
    form: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);

  try {
    const json = JSON.parse(body);
    if (json.success !== undefined && json.success !== 1) {
      throw new Error(`eresult ${json.success}`);
    }
  } catch (e) {
    if (/^eresult/.test(e.message)) throw e;
    // не JSON — считаем успехом
  }
  return true;
}

// Назначение типа витрины на слот профиля (как форма на edit/showcases):
// собираем все поля страницы, подменяем profile_showcase[slotIndex] и POST-им обратно
export async function setShowcaseSlot(community, slotIndex, showcaseType) {
  const url = `${myProfileUrl()}/edit/showcases`;
  await sleep(2000);
  const { body } = await reqRetry(community, "GET", { uri: url });

  const { load } = await import("cheerio");
  const $ = load(body);

  // Упорядоченные пары name=value — дубликаты (profile_showcase[]) важны
  const pairs = [];
  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name");
    if (!name) return;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "select") {
      pairs.push([name, $el.val() ?? ""]);
    } else if (tag === "textarea") {
      pairs.push([name, $el.val() ?? ""]);
    } else {
      const type = ($el.attr("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if ($el.attr("checked") !== undefined) pairs.push([name, $el.attr("value") || "on"]);
      } else {
        pairs.push([name, $el.attr("value") ?? ""]);
      }
    }
  });

  let seen = -1;
  let replaced = false;
  for (const p of pairs) {
    if (p[0] === "profile_showcase[]") {
      seen++;
      if (seen === slotIndex) {
        p[1] = String(showcaseType);
        replaced = true;
        break;
      }
    }
  }
  if (!replaced) throw new Error(t("showcase_no_slot"));

  const form = new URLSearchParams();
  form.set("sessionid", community.getSessionID());
  for (const [k, v] of pairs) form.append(k, v);

  const { res } = await reqRetry(community, "POST", {
    uri: url,
    form: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return true;
}

// Невидимая подпись бота: 20 zero-width символов (U+200B/U+200C) в названии
// арта. Нигде не видна (ни на витрине, ни в галерее), но читается из HTML
// страницы управления — по ней cleanup отличает карточки бота от твоих
// личных иллюстраций. Плюс распознаём старое видимое имя "now-playing".
// После подписи идёт невидимая метка альбома: биты sha1(albumKey) -> ZWSP/ZWNJ.
// Треки одного альбома переиспользуют один и тот же арт без перезаливки.
export const ART_SIGNATURE = "\u200B\u200C".repeat(10);
export const LEGACY_TITLE = "now-playing";
import crypto from "node:crypto";

// albumKey -> невидимая битовая метка (первые 8 байт sha1 = 64 ZW-символа)
function albumTag(albumKey) {
  const hash = crypto.createHash("sha1").update(albumKey).digest();
  let bits = "";
  for (const byte of hash.subarray(0, 8)) {
    bits += byte.toString(2).padStart(8, "0");
  }
  return bits.replace(/0/g, "\u200B").replace(/1/g, "\u200C");
}
function albumFromTag(text) {
  const m = text.match(new RegExp(ART_SIGNATURE + "([\\u200B\\u200C]+)"));
  if (!m) return null;
  const bits = m[1].replace(/\u200B/g, "0").replace(/\u200C/g, "1");
  if (bits.length < 8 || bits.length % 8 !== 0) return null;
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return "hash:" + Buffer.from(bytes).toString("hex");
}
export function buildArtTitle(albumKey) {
  return ART_SIGNATURE + albumTag(albumKey);
}
function albumHash(albumKey) {
  return "hash:" + crypto.createHash("sha1").update(albumKey).digest().subarray(0, 8).toString("hex");
}

// Ищем в галерее наш арт, у которого метка альбома совпадает с текущим треком.
// Возвращаем fileId или null.
export async function findArtworkByAlbum(community, albumKey) {
  try {
    const { body } = await reqRetry(community, "GET", { uri: `${myProfileUrl()}/images` });
    const items = parseGalleryItems(body);
    const want = albumHash(albumKey);
    for (const [id, text] of items) {
      const ours = text.includes(ART_SIGNATURE) || text.trim() === LEGACY_TITLE;
      if (!ours) continue;
      const got = albumFromTag(text);
      if (got && got === want) return id;
    }
    return null;
  } catch {
    return null;
  }
}

export function albumFromTagSafe(text) {
  const got = albumFromTag(text);
  return got ? "hash-ok" : null;
}

// Парсим галерею: { id -> название+описание арта }. Ищем подпись бота и в
// названии (<q class="ellipsis">), и в описании внутри блока элемента.
export function parseGalleryItems(body) {
  const items = new Map();
  // Блоки: от data-publishedfileid="ID" до следующего data-publishedfileid / конца
  const starts = [...body.matchAll(/data-publishedfileid="(\d+)"/g)];
  for (let i = 0; i < starts.length; i++) {
    const id = starts[i][1];
    const blockEnd = i + 1 < starts.length ? starts[i + 1].index : body.length;
    const block = body.slice(starts[i].index, blockEnd);
    const title = block.match(/<q class="ellipsis">([\s\S]*?)<\/q>/)?.[1] ?? "";
    // Описание тоже в блоке (imgWallHoverDescription / excerpt)
    const desc = block.match(/class="imgWallHoverDescription[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    items.set(id, title + "\n" + desc);
  }
  return items;
}

// POST /imagesaction action=delete для одного арта
async function postImagesActionDelete(community, actionUrl, id) {
  const form = new URLSearchParams();
  form.set("action", "delete");
  form.set("sessionid", community.getSessionID());
  form.set(`screenshots[${id}]`, "on");
  const { res } = await reqRetry(community, "POST", {
    uri: actionUrl,
    form: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.statusCode === 200 || res.statusCode === 302;
}

// Удаляем прошлые now-playing арты из галереи (оставляем текущий).
// Механизм как у сайта: POST /imagesaction с action=delete и screenshots[id]=on
export async function deleteArtwork(community, publishedFileId) {
  try {
    const { body } = await reqRetry(community, "GET", { uri: `${myProfileUrl()}/images` });
    const actionMatch = body.match(/action="(https:\/\/steamcommunity\.com[^"]*imagesaction)"/);
    const actionUrl = actionMatch ? actionMatch[1] : `${myProfileUrl()}/imagesaction`;

    const form = new URLSearchParams();
    form.set("action", "delete");
    form.set("sessionid", community.getSessionID());
    form.set(`screenshots[${publishedFileId}]`, "on");

    const { res } = await reqRetry(community, "POST", {
      uri: actionUrl,
      form: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    // Сайт после успешного POST редиректит обратно в галерею (302) — это успех
    if (res.statusCode !== 200 && res.statusCode !== 302) throw new Error(`HTTP ${res.statusCode}`);
    return true;
  } catch (e) {
    console.error(`[showcase] ${t("showcase_cleanup_failed", { message: e.message })}`);
    return false;
  }
}

// Чистка: удаляем ТОЛЬКО арты с подписью бота (невидимая метка в названии).
// Твои личные иллюстрации без подписи не трогаем.
export async function cleanupOldArtworks(community, keepId) {
  try {
    await sleep(1000);
    const { body } = await reqRetry(community, "GET", { uri: `${myProfileUrl()}/images` });

    const items = parseGalleryItems(body);
    const actionMatch = body.match(/action="(https:\/\/steamcommunity\.com[^"]*imagesaction)"/);
    const actionUrl = actionMatch ? actionMatch[1] : `${myProfileUrl()}/imagesaction`;

    let deleted = 0;
    for (const [id, title] of items) {
      if (id === String(keepId)) continue;
      const ours = title.includes(ART_SIGNATURE) || title.trim() === LEGACY_TITLE;
      if (!ours) continue; // не наш арт — не трогаем
      try {
        if (await postImagesActionDelete(community, actionUrl, id)) deleted++;
        await sleep(300);
      } catch {}
    }
    return deleted;
  } catch (e) {
    console.error(`[showcase] ${t("showcase_cleanup_failed", { message: e.message })}`);
    return 0;
  }
}
