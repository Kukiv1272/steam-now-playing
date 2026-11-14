// Проверка и установка обновлений. Два режима:
// - git-режим (репозиторий склонирован): git pull
// - zip-режим (скачан архив, git отсутствует): ZIP с GitHub,
//   распаковка через PowerShell Expand-Archive, замена файлов.
//   Сохраняются: .env, tokens.json, cache/, node_modules, bot.log.
// GitHub API может быть заблокирован в регионе — используется локальный
// прокси: UPDATE_PROXY, а если не задан — тот же, что для last.fm.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { config } from "./config.js";

const REPO = "Kukiv1272/steam-now-playing";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Не трогаем при zip-обновлении: пользовательские данные и зависимости
const PRESERVE = new Set([
  "node_modules",
  ".env",
  "tokens.json",
  "cache",
  "bot.log",
  "steam-qr.png",
  "showcases-debug.html",
  ".git",
]);

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

async function isGitRepo() {
  const r = await run("git", ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout === "true";
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

// Локальная версия: git HEAD для репозитория, иначе файл .version —
// его пишет performUpdateAuto после каждого успешного обновления, так что
// проверка обновлений работает и на ZIP-копиях без git.
const VERSION_FILE = path.join(ROOT, ".version");

function readVersionFile() {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeVersionFile(sha) {
  if (!sha) return;
  try {
    fs.writeFileSync(VERSION_FILE, sha + "\n");
  } catch {}
}

// { updateAvailable, local, remote } | { error } | { versionUnknown, remote }
export async function checkForUpdates() {
  try {
    const [gitSha, remote] = await Promise.all([getLocalSha(), getRemoteSha()]);
    const local = gitSha || readVersionFile();
    if (!local) {
      // ZIP-установка без .version: версию определить нельзя (но remote известен)
      return { versionUnknown: true, remote };
    }
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
    const message = pull.stderr || pull.err?.message || "git pull failed";
    return { ok: false, npmDone: false, message };
  }
  writeVersionFile(await getLocalSha());

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

// ============ ZIP-режим (без git) ============

// Скачивает ZIP дефолтной ветки через прокси (follows redirect с api.github.com)
async function downloadZip() {
  const opts = {
    headers: { "User-Agent": "steam-now-playing" },
    signal: AbortSignal.timeout(60000),
  };
  const p = proxy();
  if (p) {
    const { ProxyAgent } = await import("undici");
    opts.dispatcher = new ProxyAgent(p);
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/zipball`, opts);
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Распаковка через встроенный PowerShell Expand-Archive (Windows)
async function extractZip(zipPath, destDir) {
  const cmd = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`;
  const r = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd]);
  if (!r.ok) throw new Error(`Expand-Archive: ${r.stderr || r.err?.message}`);
}

// Рекурсивное копирование с сохранением пользовательских данных
function copyTree(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const rel = path.relative(src, srcPath);
      if (!rel) return true;
      const first = rel.split(path.sep)[0];
      return !PRESERVE.has(first);
    },
  });
}

async function updateFromZip() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snp-update-"));
  try {
    const zip = await downloadZip();
    const zipPath = path.join(tmp, "repo.zip");
    fs.writeFileSync(zipPath, zip);

    const outDir = path.join(tmp, "out");
    fs.mkdirSync(outDir, { recursive: true });
    await extractZip(zipPath, outDir);

    // Внутри zip единственная папка вида User-Repo-<sha> — sha запишем в .version
    const entries = fs.readdirSync(outDir);
    const repoDir = entries.map((e) => path.join(outDir, e)).find((p) => fs.statSync(p).isDirectory());
    if (!repoDir) throw new Error("не нашёл папку репозитория внутри zip");

    copyTree(repoDir, ROOT);
    const zipSha = path.basename(repoDir).replace(/^.*-steam-now-playing-/, "");
    writeVersionFile(zipSha);
    return { ok: true, npmDone: false, message: "файлы обновлены (зависимости не тронуты)" };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// Обновление: git-режим если репозиторий, иначе ZIP
export async function performUpdateAuto() {
  if (await isGitRepo()) return performUpdate();
  return updateFromZip();
}
