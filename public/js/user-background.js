/** 사용자 업로드 배경 — 전 페이지 공통 */

const BG_CACHE_KEY = "userBackgroundImage";

function cssUrlValue(url) {
  return `url("${String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

function applyBackground(image) {
  const html = document.documentElement;
  if (!image) {
    html.classList.remove("has-user-bg");
    html.style.removeProperty("--user-bg-image");
    localStorage.removeItem(BG_CACHE_KEY);
    return;
  }
  html.classList.add("has-user-bg");
  html.style.setProperty("--user-bg-image", cssUrlValue(image));
  try {
    localStorage.setItem(BG_CACHE_KEY, image);
  } catch (_) {}
}

function loadFromCache() {
  try {
    const cached = localStorage.getItem(BG_CACHE_KEY);
    if (cached && cached.startsWith("data:image/")) {
      applyBackground(cached);
      return cached;
    }
  } catch (_) {}
  return null;
}

async function syncFromServer() {
  const res = await fetch("/api/preferences", { credentials: "include" });
  if (res.status === 401) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "배경을 불러오지 못했습니다.");
  applyBackground(data.backgroundImage || null);
  broadcastBackground(data.backgroundImage || null);
  return data.backgroundImage || null;
}

async function saveBackground(image) {
  const res = await fetch("/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ backgroundImage: image }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "배경을 저장하지 못했습니다.");
  applyBackground(data.backgroundImage || null);
  broadcastBackground(data.backgroundImage || null);
  return data.backgroundImage || null;
}

function broadcastBackground(image) {
  try {
    const frame = document.getElementById("appFrame");
    frame?.contentWindow?.postMessage({ type: "user-bg-update", image: image || null }, "*");
  } catch (_) {}
  window.parent?.postMessage({ type: "user-bg-update", image: image || null }, "*");
}

function resizeImageFile(file, maxWidth = 1920, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("이미지 처리에 실패했습니다."));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length > 2_800_000) {
          reject(new Error("사진이 너무 큽니다. 더 작은 사진을 선택해 주세요."));
          return;
        }
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

window.UserBackground = {
  apply: applyBackground,
  clear: () => applyBackground(null),
  loadFromCache,
  syncFromServer,
  saveBackground,
  resizeImageFile,
  broadcastBackground,
};

window.addEventListener("message", (e) => {
  if (e.data?.type === "user-bg-update") {
    applyBackground(e.data.image || null);
  }
});

loadFromCache();
syncFromServer().catch(() => {});
