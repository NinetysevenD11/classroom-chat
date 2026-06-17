import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSON_DIR = path.join(__dirname, "lesson-app");
const LESSON_PORT = Number(process.env.LESSON_PORT || 18080);
const LESSON_PREFIX = "/lesson-svc";

let child = null;
let ready = false;
let starting = false;
let failed = false;

export function getLessonPort() {
  return LESSON_PORT;
}

export function getLessonPrefix() {
  return LESSON_PREFIX;
}

export function isLessonReady() {
  return ready;
}

export function getLessonStatus() {
  return {
    ready,
    starting: starting && !ready && !failed,
    failed,
    disabled: process.env.LESSON_APP_DISABLED === "1",
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

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: LESSON_PORT,
        path: `${LESSON_PREFIX}/_nicegui/3.10.0/static/nicegui.css`,
        timeout: 2500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await probeHealth()) {
      ready = true;
      return;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error("수업 자료 생성기가 시간 내에 시작되지 않았습니다.");
}

export async function startLessonService(sessionSecret) {
  if (process.env.LESSON_APP_DISABLED === "1") {
    console.log("[lesson-app] LESSON_APP_DISABLED=1 — 수업 자료 생성기를 건너뜁니다.");
    return false;
  }
  if (!fs.existsSync(path.join(LESSON_DIR, "app.py"))) {
    console.warn("[lesson-app] lesson-app/app.py 가 없어 수업 자료 생성기를 시작하지 않습니다.");
    return false;
  }
  if (starting || ready) return ready;
  starting = true;

  const persistDir = path.join(resolveDataDir(), "lesson-data");
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
  };

  const python = resolvePython();
  child = spawn(python, ["app.py"], {
    cwd: LESSON_DIR,
    env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    ready = false;
    starting = false;
    failed = true;
    console.warn(`[lesson-app] 종료됨 (code=${code}, signal=${signal})`);
  });

  try {
    await waitForHealth();
    ready = true;
    starting = false;
    console.log(`[lesson-app] 연동 완료 — http://127.0.0.1:${LESSON_PORT} (허브: ${LESSON_PREFIX})`);
    return true;
  } catch (err) {
    failed = true;
    starting = false;
    console.warn(`[lesson-app] 시작 실패: ${err.message}`);
    console.warn(
      "[lesson-app] Python 의존성 설치: pip install -r lesson-app/requirements.txt && playwright install chromium"
    );
    if (child && !child.killed) child.kill();
    child = null;
    starting = false;
    return false;
  }
}
