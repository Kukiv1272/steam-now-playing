import SteamUser from "steam-user";
import SteamTotp from "steam-totp";
import SteamCommunity from "steamcommunity";
import { EAuthTokenPlatformType, LoginSession } from "steam-session";
import { config } from "./config.js";
import { t } from "./i18n.js";
import fs from "node:fs";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";

const client = new SteamUser();
const community = new SteamCommunity();
export { client, community };

const TOKENS_FILE = new URL("../tokens.json", import.meta.url);

let webSessionReady = null;

function loadSavedToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    return data.refreshToken || null;
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.writeFileSync(
    TOKENS_FILE,
    JSON.stringify({ refreshToken: token, savedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`[steam] ${t("token_saved")}`);
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl.output;
  out.mute?.();
  let answer;
  try {
    answer = (await rl.question(question)).trim();
  } finally {
    out.unmute?.();
    rl.close();
  }
  console.log();
  return answer;
}

function attachClientHandlers() {
  client.on("loggedOn", () => {
    console.log(`[steam] ${t("logged_on", { steamid: client.steamID?.getSteamID64?.() || "..." })}`);
    client.setPersona(SteamUser.EPersonaState.Online);
  });

  client.on("webSession", (sessionId, cookies) => {
    community.setCookies(cookies);
    console.log(`[steam] ${t("web_session")}`);
    webSessionReady?.resolve?.();
  });

  client.on("error", (e) => {
    console.error(`[steam] ${t("steam_error", { message: e.message })}`);
    webSessionReady?.reject?.(e);
  });

  client.on("disconnected", (eresult, msg) => {
    console.warn(`[steam] ${t("disconnected", { eresult, msg: msg || "" })}`);
  });
}

function logOnWithRefreshToken(token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    webSessionReady = {
      resolve: () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      },
      reject: (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      },
    };
    client.logOn({ refreshToken: token });
  });
}

function openFile(path) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", path], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [path], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [path], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {}
}

// --- Меню входа ---

async function chooseLoginMethod() {
  console.log(`\n${t("menu_title")}`);
  console.log(t("menu_qr"));
  console.log(t("menu_password"));
  console.log(`${t("menu_exit")}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let choice;
  try {
    choice = (await rl.question(t("menu_prompt"))).trim();
  } finally {
    rl.close();
  }

  switch (choice) {
    case "1":
      return qrLogin();
    case "2":
      return passwordLogin();
    default:
      console.log(t("menu_exit_chosen"));
      process.exit(0);
  }
}

async function qrLogin() {
  const { EAuthTokenPlatformType, LoginSession } = await import("steam-session");
  const QRCode = (await import("qrcode")).default;
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
  session.loginTimeout = 300000; // 5 минут на скан

  const resp = await session.startWithQR();
  const url = resp.qrChallengeUrl;
  if (!url) throw new Error(t("qr_no_challenge"));

  // ASCII QR прямо в консоли
  const ascii = await QRCode.toString(url, { type: "terminal", small: true });
  console.log(`\n${ascii}`);
  console.log(`[login] ${t("qr_prompt")}`);
  try {
    await QRCode.toFile("steam-qr.png", url);
    console.log(`[login] ${t("qr_fallback")}`);
  } catch {}

  await new Promise((resolve, reject) => {
    session.on("remoteInteraction", () => {
      console.log(`[login] ${t("qr_scanned")}`);
    });
    session.on("authenticated", resolve);
    session.on("timeout", () => reject(new Error(t("qr_timeout"))));
    session.on("error", reject);
  });

  const token = session.refreshToken;
  console.log(`[login] ${t("qr_ok")}`);
  return token;
}

async function passwordLogin() {
  let username = config.steam.username;
  let password = config.steam.password;

  if (!username) {
    username = await prompt(t("username_prompt"));
  }
  if (!password) {
    password = await promptHidden(t("password_prompt"));
  }

  const sharedSecret = config.steam.sharedSecret;

  const { EAuthTokenPlatformType, LoginSession } = await import("steam-session");
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);

  session.on("steamGuard", async (domain, callback, lastCodeWrong) => {
    if (lastCodeWrong) console.log(`[login] ${t("code_wrong")}`);
    let code;
    if (sharedSecret) {
      code = SteamTotp.generateAuthCode(sharedSecret);
      console.log(`[login] ${t("code_generated")}`);
    } else {
      code = await prompt(t("code_prompt", { domain: domain || "email" }));
    }
    callback(code);
  });

  await session.startWithCredentials({ accountName: username, password });
  const token = session.refreshToken;
  console.log(`[login] ${t("password_ok")}`);
  return token;
}

export async function login() {
  attachClientHandlers();

  // 1. Пробуем сохранённый токен
  const saved = loadSavedToken();
  if (saved) {
    try {
      console.log(`[steam] ${t("try_token")}`);
      await logOnWithRefreshToken(saved);
      return;
    } catch (e) {
      console.error(`[steam] ${t("token_failed", { message: e.message })}`);
    }
  }

  const token = await chooseLoginMethod();
  saveToken(token);
  await logOnWithRefreshToken(token);
}

export function setNowPlayingText(text) {
  try {
    console.log(`[steam] ${t("setting_status", { text })}`);
    client.gamesPlayed(text);
  } catch (e) {
    console.error(`[steam] ${t("gamesplayed_failed", { message: e.message })}`);
  }
}

export function clearNowPlaying() {
  try {
    console.log(`[steam] ${t("status_cleared")}`);
    client.gamesPlayed([]); // пустой массив = сброс статуса "Играет в ..."
  } catch (e) {
    console.error(`[steam] ${t("gamesplayed_failed", { message: e.message })}`);
  }
}

export function myProfileUrl() {
  try {
    return `https://steamcommunity.com/profiles/${community.steamID.getSteamID64()}`;
  } catch {
    return "https://steamcommunity.com/my";
  }
}
