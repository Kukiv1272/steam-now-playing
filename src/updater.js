// Проверка и установка обновлений: бот сравнивает локальный git HEAD с
// GitHub (публичный API, без авторизации) и умеет обновляться `git pull`.
// GitHub API может быть заблокирован в регионе — используется локальный
// прокси: UPDATE_PROXY, а если не задан — тот же, что для last.fm.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";

const REPO = "Kukiv1272/steam-now-playing";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function proxy() {
  return process.env.UPDATE_PROXY || config.lastfm.proxy || "";
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: ROOT, windowsHide: true, timeout: 180000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim(), err });
      },
    );
  });
}

async function getLocalSha() {
  const r = await run("git", ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout : null;
}

async function getRemoteSha() {
  const opts = {
    headers: { "User-Agent": "steam-now-playing", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  };
  const p = proxy();
  if (p) {
    const { ProxyAgent } = await import("undici");
    opts.dispatcher = new ProxyAgent(p);
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, opts);
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const j = await res.json();
  return j.sha;
}

// { updateAvailable, local, remote } или { error } — не бросает исключений
export async function checkForUpdates() {
  try {
    const [local, remote] = await Promise.all([getLocalSha(), getRemoteSha()]);
    if (!local || !remote) return { error: "git not available / not a git checkout" };
    return { updateAvailable: local.slice(0, 7) !== remote.slice(0, 7), local, remote };
  } catch (e) {
    return { error: e.message };
  }
}

// git pull (с прокси) + npm install, если изменились зависимости.
// Возвращает { ok, npmDone, message }.
export async function performUpdate() {
  const p = proxy();
  const args = ["pull", "--ff-only"];
  if (p) args.unshift("-c", `http.proxy=${p}`, "-c", `https.proxy=${p}`);

  const pull = await run("git", args);
  if (!pull.ok) {
    // Частые случаи: не git-репозиторий (архив) или локальные правки конфликтуют
    const message = pull.stderr || pull.err?.message || "git pull failed";
    return { ok: false, npmDone: false, message };
  }

  let npmDone = false;
  const diff = await run("git", ["diff", "--name-only", "ORIG_HEAD", "HEAD"]);
  const changed = diff.ok ? diff.stdout.split(/\r?\n/) : [];
  if (changed.includes("package.json") || changed.includes("package-lock.json")) {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npm = await run(npmCmd, ["install", "--no-audit", "--no-fund"]);
    npmDone = npm.ok;
  }

  return { ok: true, npmDone, message: pull.stdout.split(/\r?\n/).slice(-4).join("\n") };
}
