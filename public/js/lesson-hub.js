/** 교실도구 허브 — 수업 자료 생성기 SSO 연결 (허브 iframe에 직접 로드) */

const IS_HOSTED =
  location.hostname !== "localhost" && location.hostname !== "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hintForStatus(data) {
  if (data.disabled) {
    return IS_HOSTED
      ? "서버 관리자에게 문의해 주세요."
      : "PC에서 node server.js 실행 후 http://localhost:3000 으로 접속해 주세요.";
  }
  if (data.failedReason) return data.failedReason;
  if (data.failed) {
    return IS_HOSTED
      ? "서버가 방금 깨어났을 수 있습니다. 잠시 후 다시 시도해 주세요."
      : "터미널에서 node server.js 로그를 확인하고 npm run setup:lesson 을 실행해 주세요.";
  }
  return IS_HOSTED
    ? "첫 실행은 1~3분 걸릴 수 있습니다. 잠시 후 다시 시도해 주세요."
    : "node server.js 실행 후 1~2분 기다렸다가 다시 시도해 주세요.";
}

async function tryRestartLesson() {
  try {
    const res = await fetch("/api/lesson/restart", {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    return Boolean(data.ok || data.starting);
  } catch {
    return false;
  }
}

async function waitLessonReady(maxMs) {
  const limit = maxMs || (IS_HOSTED ? 300000 : 120000);
  const start = Date.now();
  let retried = false;

  while (Date.now() - start < limit) {
    const res = await fetch("/api/lesson/status", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (data.ready) return { ok: true };
    if (data.disabled) {
      return {
        ok: false,
        error: "이 서버에서는 수업 자료 생성기를 사용할 수 없습니다.",
        hint: hintForStatus(data),
      };
    }
    if (data.failed) {
      if (!retried && IS_HOSTED) {
        retried = true;
        await tryRestartLesson();
        await sleep(3000);
        continue;
      }
      return {
        ok: false,
        error: "수업 자료 생성기를 시작하지 못했습니다.",
        hint: hintForStatus(data),
      };
    }
    await sleep(2000);
  }
  return {
    ok: false,
    error: "수업 자료 생성기가 준비되지 않았습니다.",
    hint: hintForStatus({ failed: false }),
  };
}

async function fetchLessonSsoUrl() {
  const ready = await waitLessonReady();
  if (!ready.ok) {
    alert([ready.error, ready.hint].filter(Boolean).join("\n\n"));
    return null;
  }
  const res = await fetch("/api/lesson/sso", { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = "/login";
    return null;
  }
  if (!res.ok || !data.ok) {
    alert(data.error || data.failedReason || "수업 자료 생성기에 연결하지 못했습니다.");
    return null;
  }
  return data.url;
}

async function openLessonInFrame(frameEl) {
  if (!frameEl) return false;
  const prev = frameEl.dataset.lessonLoading;
  if (prev === "1") return false;
  frameEl.dataset.lessonLoading = "1";
  frameEl.title = "수업 자료 생성 — 연결 중…";
  try {
    const url = await fetchLessonSsoUrl();
    if (!url) return false;
    frameEl.src = url;
    frameEl.title = "수업 자료 생성";
    return true;
  } finally {
    delete frameEl.dataset.lessonLoading;
  }
}

window.LessonHub = { openLessonInFrame };
