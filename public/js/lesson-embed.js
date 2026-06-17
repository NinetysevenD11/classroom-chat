/** 교실도구 허브 → 수업 자료 생성기 SSO iframe 연결 */

(function () {
  const loading = document.getElementById("lessonLoading");
  const errBox = document.getElementById("lessonError");
  const errText = document.getElementById("lessonErrorText");
  const errHint = document.getElementById("lessonErrorHint");
  const frame = document.getElementById("lessonFrame");

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

  async function connect() {
    try {
      const res = await fetch("/api/lesson/sso", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.top.location.href = "/login";
        return;
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "수업 자료 생성기에 연결하지 못했습니다.");
      }
      if (!frame) return;
      frame.src = data.url;
      frame.hidden = false;
      if (loading) loading.hidden = true;
      if (errBox) {
        errBox.hidden = true;
        errBox.classList.add("hidden");
      }
    } catch (err) {
      showError(
        err.message || "연결하지 못했습니다.",
        "Python·Playwright 설치: pip install -r lesson-app/requirements.txt && playwright install chromium"
      );
    }
  }

  connect();
})();
