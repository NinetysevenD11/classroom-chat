/** 교실도구 허브 — 수업 자료 생성기 SSO 연결 (허브 iframe에 직접 로드) */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitLessonReady(maxMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch("/api/lesson/status", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (data.ready) return { ok: true };
    if (data.disabled) {
      return {
        ok: false,
        error: "이 서버에서는 수업 자료 생성기를 사용할 수 없습니다.",
        hint: "PC에서 node server.js 실행 후 http://localhost:3000 으로 접속해 주세요.",
      };
    }
    if (data.failed) {
      return {
        ok: false,
        error: "수업 자료 생성기를 시작하지 못했습니다.",
        hint: "터미널 로그를 확인하고 npm.cmd run setup:lesson 을 실행해 주세요.",
      };
    }
    await sleep(1500);
  }
  return {
    ok: false,
    error: "수업 자료 생성기가 준비되지 않았습니다.",
    hint: "node server.js 실행 후 1~2분 기다렸다가 다시 시도해 주세요.",
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
    alert(data.error || "수업 자료 생성기에 연결하지 못했습니다.");
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
