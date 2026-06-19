/**
 * Render(Node) 빌드 시 Python + lesson-app 의존성을 프로젝트 안에 설치합니다.
 * Docker 없이도 수업 자료 생성기가 동작하게 합니다.
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PY_HOME = path.join(ROOT, ".python");
const PY_BIN = path.join(PY_HOME, "bin", "python3");
const REQ = path.join(ROOT, "lesson-app", "requirements.txt");
const MARKER = path.join(PY_HOME, ".render-setup-done");

const PY_TAR_URL =
  "https://github.com/indygreg/python-build-standalone/releases/download/20241016/cpython-3.12.7+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz";

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

function ensurePython() {
  if (fs.existsSync(PY_BIN)) return PY_BIN;
  console.log("[render-setup] Python 3.12 다운로드 중…");
  fs.mkdirSync(PY_HOME, { recursive: true });
  const tarPath = path.join(ROOT, ".python-tar.gz");
  run(`curl -fsSL "${PY_TAR_URL}" -o "${tarPath}"`);
  run(`tar -xzf "${tarPath}" -C "${PY_HOME}" --strip-components=1`);
  fs.unlinkSync(tarPath);
  if (!fs.existsSync(PY_BIN)) throw new Error("Python 설치 후 실행 파일을 찾지 못했습니다.");
  console.log("[render-setup] Python 설치 완료");
  return PY_BIN;
}

function main() {
  if (process.env.RENDER !== "true" || process.platform !== "linux") {
    console.log("[render-setup] Render Linux가 아니어서 건너뜁니다.");
    return;
  }
  if (!fs.existsSync(REQ)) {
    console.warn("[render-setup] lesson-app/requirements.txt 없음 — 건너뜀");
    return;
  }

  const py = ensurePython();
  const pip = path.join(PY_HOME, "bin", "pip3");
  const reqHash = fs.readFileSync(REQ, "utf8");
  const prevHash = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8") : "";

  if (reqHash !== prevHash) {
    console.log("[render-setup] pip 패키지 설치 중…");
    run(`"${pip}" install --no-cache-dir -r "${REQ}"`);
    fs.writeFileSync(MARKER, reqHash);
  } else {
    console.log("[render-setup] pip 패키지 최신 상태");
  }

  console.log("[render-setup] Playwright Chromium 설치 시도…");
  try {
    run(`"${py}" -m playwright install chromium`, { timeout: 900000 });
  } catch (err) {
    console.warn("[render-setup] Chromium 설치 실패 — UI는 동작, PDF 변환만 제한될 수 있음:", err.message);
  }

  try {
    run(`"${py}" -c "import nicegui; print('nicegui', nicegui.__version__)"`);
  } catch (err) {
    console.error("[render-setup] nicegui import 실패:", err.message);
    process.exit(1);
  }

  console.log("[render-setup] 수업 자료 생성기 준비 완료");
}

main();
