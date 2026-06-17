/** 교실도구 허브 → 수업 자료 생성기 SSO iframe 연결 */

(function () {
  const loading = document.getElementById("lessonLoading");
  const errBox = document.getElementById("lessonError");
  const errText = document.getElementById("lessonErrorText");
  const errHint = document.getElementById("lessonErrorHint");
  const frame = document.getElementById("lessonFrame");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function waitUntilReady(maxMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
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
          "PC에서 node server.js 를 실행한 뒤 http://localhost:3000 으로 접속해 주세요."
        );
        return false;
      }
      if (data.failed) {
        showError(
          "수업 자료 생성기를 시작하지 못했습니다.",
          "터미널에서 node server.js 로그를 확인하고, npm.cmd run setup:lesson 을 실행해 주세요."
        );
        return false;
      }
      setLoadingMessage(Math.round((Date.now() - start) / 1000));
      await sleep(1500);
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
            "node server.js 실행 후 1~2분 기다렸다가 이 메뉴를 다시 열어 주세요."
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
        throw new Error(data.error || "수업 자료 생성기에 연결하지 못했습니다.");
      }
      showFrame(data.url);
    } catch (err) {
      showError(
        err.message || "연결하지 못했습니다.",
        "node server.js 가 켜져 있는지 확인하고, npm.cmd run setup:lesson 도 실행해 보세요."
      );
    }
  }

  connect();
})();
