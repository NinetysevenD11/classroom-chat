/** 교실도구 허브 → 수업 자료 생성기 SSO iframe 연결 */

(function () {
  const loading = document.getElementById("lessonLoading");
  const errBox = document.getElementById("lessonError");
  const errText = document.getElementById("lessonErrorText");
  const errHint = document.getElementById("lessonErrorHint");
  const frame = document.getElementById("lessonFrame");

  const IS_HOSTED =
    location.hostname !== "localhost" && location.hostname !== "127.0.0.1";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hintForStatus(data) {
    if (data.disabled) {
      return IS_HOSTED
        ? "서버 관리자에게 문의해 주세요."
        : "PC에서 node server.js 를 실행한 뒤 http://localhost:3000 으로 접속해 주세요.";
    }
    if (data.failedReason) return data.failedReason;
    if (data.failed) {
      return IS_HOSTED
        ? "서버가 방금 깨어났을 수 있습니다. 잠시 후 다시 시도해 주세요."
        : "터미널에서 node server.js 로그를 확인하고, npm run setup:lesson 을 실행해 주세요.";
    }
    return IS_HOSTED
      ? "첫 실행은 1~3분 걸릴 수 있습니다."
      : "node server.js 실행 후 1~2분 기다렸다가 이 메뉴를 다시 열어 주세요.";
  }

  function setLoadingMessage(sec) {
    if (!loading) return;
    const main = loading.querySelector("div");
    if (main) {
      main.textContent =
        sec > 0
          ? `📚 수업 자료 생성기 시작 중… (${sec}초)`
          : "📚 수업 자료 생성기 연결 중…";
    }
  }

  function showError(message, hint) {
    if (loading) loading.hidden = true;
    if (frame) frame.hidden = true;
    if (errBox) {
      errBox.hidden = false;
      errBox.classList.remove("hidden");
    }
    if (errText) errText.textContent = message;
    if (errHint) errHint.textContent = hint || "";
  }

  function showFrame(url) {
    if (!frame) return;
    frame.src = url;
    frame.hidden = false;
    if (loading) loading.hidden = true;
    if (errBox) {
      errBox.hidden = true;
      errBox.classList.add("hidden");
    }
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

  async function waitUntilReady(maxMs) {
    const limit = maxMs || (IS_HOSTED ? 300000 : 120000);
    const start = Date.now();
    let retried = false;

    while (Date.now() - start < limit) {
      const res = await fetch("/api/lesson/status", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.top.location.href = "/login";
        return false;
      }
      if (data.ready) return true;
      if (data.disabled) {
        showError(
          data.error || "이 서버에서는 수업 자료 생성기를 사용할 수 없습니다.",
          hintForStatus(data)
        );
        return false;
      }
      if (data.failed) {
        if (!retried && IS_HOSTED) {
          retried = true;
          setLoadingMessage(Math.round((Date.now() - start) / 1000));
          await tryRestartLesson();
          await sleep(3000);
          continue;
        }
        showError("수업 자료 생성기를 시작하지 못했습니다.", hintForStatus(data));
        return false;
      }
      setLoadingMessage(Math.round((Date.now() - start) / 1000));
      await sleep(2000);
    }
    return false;
  }

  async function connect() {
    try {
      setLoadingMessage(0);
      const ready = await waitUntilReady();
      if (!ready) {
        if (!errBox || errBox.hidden) {
          showError(
            "수업 자료 생성기가 아직 준비되지 않았습니다.",
            hintForStatus({ failed: false })
          );
        }
        return;
      }

      const res = await fetch("/api/lesson/sso", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.top.location.href = "/login";
        return;
      }
      if (!res.ok || !data.ok) {
        if (data.starting) {
          await sleep(2000);
          return connect();
        }
        throw new Error(
          data.error || data.failedReason || "수업 자료 생성기에 연결하지 못했습니다."
        );
      }
      showFrame(data.url);
    } catch (err) {
      showError(
        err.message || "연결하지 못했습니다.",
        IS_HOSTED
          ? "잠시 후 다시 시도해 주세요."
          : "node server.js 가 켜져 있는지 확인하고, npm run setup:lesson 도 실행해 보세요."
      );
    }
  }

  connect();
})();
