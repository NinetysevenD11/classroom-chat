let selectedStyle = "minimal";
let pollTimer = null;

const styleGrid = document.getElementById("styleGrid");
const themeInput = document.getElementById("themeInput");
const sceneCount = document.getElementById("sceneCount");
const sceneLabel = document.getElementById("sceneLabel");
const generateBtn = document.getElementById("generateBtn");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
const emptyState = document.getElementById("emptyState");
const resultWrap = document.getElementById("resultWrap");
const resultVideo = document.getElementById("resultVideo");
const downloadBtn = document.getElementById("downloadBtn");
const gallery = document.getElementById("gallery");
const errorText = document.getElementById("errorText");

styleGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".style-btn");
  if (!btn) return;
  selectedStyle = btn.dataset.style;
  styleGrid.querySelectorAll(".style-btn").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
});

sceneCount.addEventListener("input", () => {
  sceneLabel.textContent = sceneCount.value;
});

generateBtn.addEventListener("click", startGeneration);

async function startGeneration() {
  clearError();
  stopPolling();

  generateBtn.disabled = true;
  emptyState.classList.add("hidden");
  resultWrap.classList.add("hidden");
  progressWrap.classList.remove("hidden");
  setProgress(0, "작업 시작 중…");

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        style: selectedStyle,
        theme: themeInput.value.trim(),
        sceneCount: Number(sceneCount.value),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "요청 실패");

    pollJob(data.jobId);
  } catch (err) {
    showError(err.message);
    resetUi();
  }
}

function pollJob(jobId) {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || "상태 조회 실패");

      setProgress(job.progress || 0, job.message || "처리 중…");

      if (job.images?.length) {
        renderGallery(job.images);
      }

      if (job.status === "done") {
        stopPolling();
        showResult(job.videoUrl);
        generateBtn.disabled = false;
      }

      if (job.status === "error") {
        stopPolling();
        showError(job.error || job.message);
        resetUi();
      }
    } catch (err) {
      stopPolling();
      showError(err.message);
      resetUi();
    }
  }, 1500);
}

function setProgress(value, message) {
  progressFill.style.width = `${value}%`;
  progressText.textContent = message;
}

function renderGallery(imageUrls) {
  gallery.innerHTML = imageUrls
    .map((url) => `<img src="${url}" alt="lookbook scene" loading="lazy" />`)
    .join("");
}

function showResult(videoUrl) {
  progressWrap.classList.add("hidden");
  resultWrap.classList.remove("hidden");
  resultVideo.src = `${videoUrl}?t=${Date.now()}`;
  downloadBtn.href = videoUrl;
}

function showError(message) {
  errorText.textContent = message;
  errorText.classList.remove("hidden");
}

function clearError() {
  errorText.textContent = "";
  errorText.classList.add("hidden");
}

function resetUi() {
  generateBtn.disabled = false;
  progressWrap.classList.add("hidden");
  emptyState.classList.remove("hidden");
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
