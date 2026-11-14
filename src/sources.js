import { config } from "./config.js";
import { ProxyAgent } from "undici";

// Unified "now playing" track: { playing, title, artist, album, coverUrl, source }
// Sources are tried in order: stats.fm -> last.fm (first configured wins).
//
// Some regions (e.g. BY/RU) are blocked by last.fm. If a local VPN proxy is
// running (v2rayN/clash etc.), set LASTFM_PROXY=http://127.0.0.1:10809 in .env
// — only last.fm requests go through it, everything else stays direct.

let lfmDispatcher = null;
async function getLfmDispatcher() {
  if (!config.lastfm.proxy) return undefined;
  if (!lfmDispatcher) lfmDispatcher = new ProxyAgent(config.lastfm.proxy);
  return lfmDispatcher;
}

export async function getNowPlaying() {
  if (config.statsfm.username) {
    try {
      const t = await statsfmNowPlaying(config.statsfm.username);
      if (t) return t; // null = сейчас ничего не играет через stats.fm — пробуем last.fm
    } catch (e) {
      console.error("[stats.fm]", e.message);
    }
  }
  if (config.lastfm.apiKey && config.lastfm.username) {
    try {
      return await lastfmNowPlaying(config.lastfm);
    } catch (e) {
      console.error("[last.fm]", e.message);
    }
  }
  return null;
}

// stats.fm: GET /users/{user}/streams/current
// item.track.image or item.track.albums[].image — handle several shapes defensively.
async function statsfmNowPlaying(username) {
  const res = await fetch(`https://api.stats.fm/api/v1/users/${encodeURIComponent(username)}/streams/current`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const item = json?.item;
  const track = item?.track;
  if (!track) return null;
  const artists = (track.artists || []).map((a) => a.name).filter(Boolean);
  const coverUrl =
    track.image ||
    (Array.isArray(track.albums) ? track.albums.map((a) => a.image).find(Boolean) : null) ||
    item.image ||
    null;
  return {
    playing: item.isPlaying === true,
    title: track.name || "",
    artist: artists.join(", "),
    album: track.albumName || "",
    coverUrl,
    source: "stats.fm",
  };
}

// last.fm: user.getRecentTracks&limit=1, nowplaying attr
async function lastfmNowPlaying({ apiKey, username }) {
  const url =
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}` +
    `&api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`;
  const dispatcher = await getLfmDispatcher();
  const res = await fetch(url, dispatcher ? { dispatcher } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const raw = json?.recenttracks?.track;
  const track = Array.isArray(raw) ? raw[0] : raw;
  if (!track) return null;
  const images = Array.isArray(track.image) ? track.image : [];
  const coverUrl = images.find((i) => i.size === "extralarge")?.["#text"] || images.at(-1)?.["#text"] || null;
  return {
    playing: track["@attr"]?.nowplaying === "true",
    title: track.name || "",
    artist: track.artist?.["#text"] || "",
    album: track.album?.["#text"] || "",
    coverUrl,
    source: "last.fm",
  };
}
