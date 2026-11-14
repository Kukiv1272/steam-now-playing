// Живая диагностика getNowPlaying: что реально возвращает источник
import { config } from "./src/config.js";
import { ProxyAgent } from "undici";

console.log("=== Конфиг ===");
console.log("statsfm.username:", config.statsfm.username);
console.log("lastfm.apiKey:", config.lastfm.apiKey ? "есть (" + config.lastfm.apiKey.length + " симв)" : "НЕТ");
console.log("lastfm.username:", config.lastfm.username);
console.log("lastfm.proxy:", config.lastfm.proxy || "(нет)");

console.log("\n=== stats.fm ===");
try {
  const r = await fetch(`https://api.stats.fm/api/v1/users/${encodeURIComponent(config.statsfm.username)}/streams/current`);
  console.log("HTTP:", r.status);
  const j = await r.json();
  console.log("item:", JSON.stringify(j?.item)?.slice(0, 150));
} catch (e) {
  console.log("ERR:", e.message);
}

console.log("\n=== last.fm (через прокси) ===");
try {
  const agent = config.lastfm.proxy ? new ProxyAgent(config.lastfm.proxy) : undefined;
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(config.lastfm.username)}&api_key=${encodeURIComponent(config.lastfm.apiKey)}&format=json&limit=1`;
  const r = await fetch(url, agent ? { dispatcher: agent } : {});
  console.log("HTTP:", r.status);
  const j = await r.json();
  const raw = j?.recenttracks?.track;
  const t = Array.isArray(raw) ? raw[0] : raw;
  console.log("nowplaying attr:", t?.["@attr"]?.nowplaying ?? "ОТСУТСТВУЕТ");
  console.log("track:", t ? `${t.name} — ${t.artist?.["#text"]}` : "none");
} catch (e) {
  console.log("ERR:", e.message);
}
