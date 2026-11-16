import { readFileSync } from "node:fs";
const bat = readFileSync("start-bot.bat", "utf8");
const used = new Set([...bat.matchAll(/%([A-Z0-9_]+)%/g)].map((m) => m[1]).filter((k) => k.startsWith("L_")));
for (const f of ["docs/menu-ru.txt", "docs/menu-en.txt"]) {
  const keys = new Set([...readFileSync(f, "utf8").matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const missing = [...used].filter((k) => !keys.has(k));
  console.log(f, "-> missing:", JSON.stringify(missing));
}
const nonAscii = [...bat].filter((ch) => ch.charCodeAt(0) > 127).length;
console.log("non-ascii in bat:", nonAscii);
const crlf = ([...bat.matchAll(/\r\n/g)]).length, lf = ([...bat.matchAll(/(?<!\r)\n/g)]).length;
console.log("crlf:", crlf, "bare lf:", lf);
