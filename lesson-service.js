import { spawn, execSync } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSON_DIR = path.join(__dirname, "lesson-app");
const LESSON_PORT = Number(process.env.LESSON_PORT || 18080);
const LESSON_PREFIX = "/lesson-svc";
const NICEGUI_HEALTH = "/_nicegui/3.10.0/static/nicegui.css";

let child = null;
let ready = false;
let starting = false;
let failed = false;
let failedReason = "";
let mode = "local";

function normalizeRemoteUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/$/, "");
  return `https://${s.replace(/\/$/, "")}`;
}

function getLessonRemoteUrl() {
  return normalizeRemoteUrl(
    process.env.LESSON_REMOTE_URL || process.env.LESSON_APP_URL || ""
  );
}

export function getLessonPort() {
  return LESSON_PORT;
}

export function getLessonPrefix() {
  return LESSON_PREFIX;
}

export function isLessonReady() {
  return ready;
}

export function getLessonProxyTarget() {
  const remote = getLessonRemoteUrl();
  if (remote) return remote;
  return `http://127.0.0.1:${LESSON_PORT}`;
}

export function getLessonStatus() {
  return {
    ready,
    starting: starting && !ready && !failed,
    failed,
    failedReason: failed ? failedReason : "",
    disabled: process.env.LESSON_APP_DISABLED === "1",
    mode,
    remote: Boolean(getLessonRemoteUrl()),
  };
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return __dirname;
}

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  if (process.platform === "win32") return "python";
  return "python3";
}

function hasPython() {
  const python = resolvePython();
  try {
    execSync(`${python} --version`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function probeUrl(urlString, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlString);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.get(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          timeout: timeoutMs,
          rejectUnauthorized: true,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 500);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

function probeLocalHealth() {
  return probeUrl(`http://127.0.0.1:${LESSON_PORT}${NICEGUI_HEALTH}`);
}

function probeRemoteHealth(baseUrl) {
  return probeUrl(`${baseUrl}${NICEGUI_HEALTH}`, 8000);
}

async function waitForHealth(probeFn, maxMs) {
  const limit =
    maxMs ||
    (process.env.RENDER === "true" || process.env.NODE_ENV === "production" ? 300000 : 120000);
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (await probeFn()) {
      ready = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("수업 자료 생성기가 시간 내에 준비되지 않았습니다.");
}

function killChild() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  }
  child = null;
}

export async function restartLessonService(sessionSecret) {
  killChild();
  ready = false;
  failed = false;
  failedReason = "";
  starting = false;
  return startLessonService(sessionSecret);
}

async function startRemoteLessonService(remoteUrl) {
  mode = "remote";
  starting = true;
  failed = false;
  failedReason = "";
  console.log(`[lesson-app] 원격 연동 — ${remoteUrl}`);
  try {
    await waitForHealth(() => probeRemoteHealth(remoteUrl));
    ready = true;
    starting = false;
    console.log(`[lesson-app] 원격 준비 완료 — ${remoteUrl}`);
    return true;
  } catch (err) {
    failed = true;
    starting = false;
    failedReason =
      "원격 수업 자료 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    console.warn(`[lesson-app] 원격 연결 실패: ${err.message}`);
    return false;
  }
}

async function startLocalLessonService(sessionSecret) {
  mode = "local";
  if (!fs.existsSync(path.join(LESSON_DIR, "app.py"))) {
    failed = true;
    failedReason = "수업 자료 생성기 파일이 없습니다.";
    console.warn("[lesson-app] lesson-app/app.py 가 없어 시작하지 않습니다.");
    return false;
  }
  if (!hasPython()) {
    failed = true;
    failedReason =
      process.env.RENDER === "true"
        ? "이 서버에 Python이 없습니다. Render 설정에서 Runtime을 Docker로 바꾸거나 LESSON_REMOTE_URL을 설정해 주세요."
        : "Python이 설치되어 있지 않습니다.";
    console.warn(`[lesson-app] ${failedReason}`);
    return false;
  }

  starting = true;
  failed = false;
  failedReason = "";

  const persistDir =
    process.env.LESSON_PERSIST_DIR || path.join(resolveDataDir(), "lesson-data");
  fs.mkdirSync(persistDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(LESSON_PORT),
    HOST: "127.0.0.1",
    LESSON_ROOT_PATH: LESSON_PREFIX,
    CLASSROOM_INTEGRATED: "1",
    CLASSROOM_SSO_SECRET: sessionSecret,
    LESSON_PERSIST_DIR: persistDir,
    STORAGE_SECRET: sessionSecret,
    RENDER: process.env.RENDER || "",
  };

  const python = resolvePython();
  child = spawn(python, ["app.py"], {
    cwd: LESSON_DIR,
    env,
    stdio: "inherit",
    windowsHide: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (ready) {
      ready = false;
      failed = true;
      failedReason = `수업 자료 생성기가 종료되었습니다 (code=${code ?? "?"})`;
      console.warn(`[lesson-app] 종료됨 (code=${code}, signal=${signal})`);
    }
    starting = false;
  });

  try {
    await waitForHealth(probeLocalHealth);
    ready = true;
    starting = false;
    console.log(
      `[lesson-app] 연동 완료 — http://127.0.0.1:${LESSON_PORT} (허브: ${LESSON_PREFIX})`
    );
    return true;
  } catch (err) {
    failed = true;
    starting = false;
    failedReason =
      process.env.RENDER === "true"
        ? "수업 자료 생성기 시작에 실패했습니다. Render 로그를 확인하거나 플랜(RAM 2GB 이상)을 확인해 주세요."
        : "수업 자료 생성기가 시간 내에 시작되지 않았습니다. npm run setup:lesson 을 실행해 주세요.";
    console.warn(`[lesson-app] 시작 실패: ${err.message}`);
    killChild();
    return false;
  }
}

export async function startLessonService(sessionSecret) {
  if (process.env.LESSON_APP_DISABLED === "1") {
    console.log("[lesson-app] LESSON_APP_DISABLED=1 — 수업 자료 생성기를 건너뜁니다.");
    return false;
  }
  if (starting || ready) return ready;

  const remoteUrl = getLessonRemoteUrl();
  if (remoteUrl) return startRemoteLessonService(remoteUrl);
  return startLocalLessonService(sessionSecret);
}
