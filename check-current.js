// Проверка: какая обложка у текущего трека и что лежит в кэше
import fs from "node:fs";
import crypto from "node:crypto";

function coverCachePath(url) {
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);
  return `cache/covers/${hash}.img`;
}

const url = "https://lastfm-img.freetls.fastly.net/i/u/300x300/211fdf70de48ee4e2d98fbb03e267759.jpg";
const p = coverCachePath(url);
console.log("cache path:", p);
if (fs.existsSync(p)) {
  const buf = fs.readFileSync(p);
  console.log("размер:", buf.length);
  console.log("header:", buf.subarray(0, 12).toString("hex"));
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89;
  console.log("тип:", isJpg ? "JPEG" : isPng ? "PNG" : "НЕ КАРТИНКА: " + buf.subarray(0, 60).toString().replace(/\s+/g, " ").slice(0, 50));
  fs.writeFileSync("D:/links/Temp/opencode/current-cover.png", buf);
  console.log("сохранил для просмотра: D:/links/Temp/opencode/current-cover.png");
} else {
  console.log("файла нет в кэше!");
}
