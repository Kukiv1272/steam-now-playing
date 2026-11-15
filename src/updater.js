// Проверка и установка обновлений. Два режима:
// - git-режим (репозиторий склонирован): git pull
// - zip-режим (скачан архив, git отсутствует): ZIP с GitHub,
//   распаковка через PowerShell Expand-Archive, замена файлов.
//   Сохраняются: .env, tokens.json, cache/, node_modules, bot.log.
// Версии сверяются по GitHub Releases: последний релиз -> коммит его тега.
// Если релизов ещё нет — сравниваем с HEAD ветки, как раньше.
// GitHub API может быть заблокирован в регионе — используется локальный
// прокси: UPDATE_PROXY, а если не задан — тот же, что для last.fm.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { config } from "./config.js";
import { t } from "./i18n.js";

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

// GET к api.github.com с User-Agent и прокси
async function gh(pathname, opts = {}) {
  const headers = {
    "User-Agent": "steam-now-playing",
    Accept: "application/vnd.github+json",
    ...opts.headers,
  };
  const p = proxy();
  if (p) {
    const { ProxyAgent } = await import("undici");
    opts.dispatcher = new ProxyAgent(p);
  }
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...opts,
    headers,
    signal: opts.signal || AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
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
  const j = await gh("/repos/" + REPO + "/commits/HEAD");
  return j.sha;
}

// Последний релиз: { tag, sha, zipballUrl } | null, если релизов ещё нет.
// sha — коммит, на который указывает тег релиза: именно коммиты удобно
// сравнивать (git-копия знает HEAD-sha, ZIP-копия хранит sha в .version).
async function getLatestRelease() {
  let rel;
  try {
    rel = await gh(`/repos/${REPO}/releases/latest`);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return null; // релизов ещё не было
    throw e;
  }
  const tag = rel.tag_name;
  let sha = null;
  try {
    const commit = await gh(`/repos/${REPO}/commits/${encodeURIComponent(tag)}`);
    sha = commit.sha;
  } catch {}
  return { tag, sha, zipballUrl: rel.zipball_url };
}

// Ушла ли локальная HEAD вперёд указанного коммита (коммит запушен, а релиз
// ещё не выпущен) — это не "доступно обновление". Для ZIP-копий не применимо.
async function isAncestor(sha) {
  const r = await run("git", ["merge-base", "--is-ancestor", sha, "HEAD"]);
  return r.ok; // exit 0 = коммит уже есть в локальной истории
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

// { updateAvailable, local, remote, version } | { error } | { versionUnknown, remote, version }
// version — тег последнего релиза (null, если релизов ещё нет).
export async function checkForUpdates() {
  try {
    const gitSha = await getLocalSha();
    const local = gitSha || readVersionFile();
    const release = await getLatestRelease();

    // Релизов ещё нет — сверяемся с HEAD ветки, как раньше
    if (!release || !release.sha) {
      const remote = await getRemoteSha();
      if (!local) return { versionUnknown: true, remote, version: null };
      return { updateAvailable: local.slice(0, 7) !== remote.slice(0, 7), local, remote, version: null };
    }

    const { tag, sha: remote } = release;
    if (!local) return { versionUnknown: true, remote, version: tag };

    // git-копия: HEAD уже содержит релизный коммит (стоит на нём или ушла
    // вперёд — коммиты запушены, релиз ещё не выпущен) — обновление не нужно
    if (gitSha && (await isAncestor(remote))) {
      return { updateAvailable: false, local, remote, version: tag };
    }
    return { updateAvailable: local.slice(0, 7) !== remote.slice(0, 7), local, remote, version: tag };
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

// Скачивает ZIP: релиза (если есть) или дефолтной ветки (fallback).
// zipball_url релиза — абсолютная ссылка на api.github.com, редиректит сам.
async function downloadZip(release) {
  const opts = {
    headers: { "User-Agent": "steam-now-playing" },
    signal: AbortSignal.timeout(60000),
  };
  const p = proxy();
  if (p) {
    const { ProxyAgent } = await import("undici");
    opts.dispatcher = new ProxyAgent(p);
  }
  const url = release?.zipballUrl || `https://api.github.com/repos/${REPO}/zipball`;
  const res = await fetch(url, opts);
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
    // Релиз есть — качаем его ZIP; нет — дефолтную ветку (как раньше)
    const release = await getLatestRelease().catch(() => null);
    const zip = await downloadZip(release);
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
    return {
      ok: true,
      npmDone: false,
      message: release?.tag
        ? t("update_zip_done_tag", { version: release.tag })
        : t("update_zip_done"),
    };
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
