/** 교실 도구함 — FAB + 플로팅 메뉴 */

const APPS = [
  {
    id: "bookmarks",
    label: "자주 가는 사이트",
    icon: "⭐",
    path: "/app/bookmarks",
  },
  {
    id: "chalkboard",
    label: "우리반 칠판",
    icon: "📋",
    path: "/app/chalkboard",
  },
  {
    id: "grading",
    label: "채점도구",
    icon: "📝",
    path: "/app/grading",
  },
];

const hubAppMenu = document.getElementById("hubAppMenu");
const appFrame = document.getElementById("appFrame");
const hubMenuFab = document.getElementById("hubMenuFab");
const hubMenuBackdrop = document.getElementById("hubMenuBackdrop");

const APP_KEY = "hubActiveApp";

let hubProfile = {
  email: "—",
  name: "선생님",
  school: "—",
};

function isMenuOpen() {
  return document.body.classList.contains("hub-menu-open");
}

function openMenu() {
  hubAppMenu.hidden = false;
  hubMenuBackdrop.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("hub-menu-open");
    hubMenuFab?.setAttribute("aria-expanded", "true");
    hubMenuFab?.setAttribute("aria-label", "메뉴 닫기");
  });
}

function closeMenu() {
  document.body.classList.remove("hub-menu-open");
  hubMenuFab?.setAttribute("aria-expanded", "false");
  hubMenuFab?.setAttribute("aria-label", "메뉴 열기");
  setTimeout(() => {
    if (!isMenuOpen()) {
      hubAppMenu.hidden = true;
      hubMenuBackdrop.hidden = true;
    }
  }, 220);
}

function toggleMenu() {
  if (isMenuOpen()) closeMenu();
  else openMenu();
}

function updateProfileChip() {
  const nameEl = document.getElementById("hubProfileName");
  const schoolEl = document.getElementById("hubProfileSchool");
  const emailEl = document.getElementById("hubProfileEmail");
  if (nameEl) nameEl.textContent = hubProfile.name;
  if (schoolEl) schoolEl.textContent = hubProfile.school;
  if (emailEl) emailEl.textContent = hubProfile.email;
}

function renderFabMenu(activeId) {
  if (!hubAppMenu) return;
  hubAppMenu.innerHTML = "";

  const profile = document.createElement("div");
  profile.className = "hub-float-chip hub-profile-chip";
  profile.setAttribute("aria-label", "계정 정보");
  profile.innerHTML =
    `<span class="hub-float-icon" aria-hidden="true">👤</span>` +
    `<div class="hub-profile-text">` +
    `<span id="hubProfileName" class="hub-profile-name">${hubProfile.name}</span>` +
    `<span id="hubProfileSchool" class="hub-profile-school">${hubProfile.school}</span>` +
    `<span id="hubProfileEmail" class="hub-profile-email">${hubProfile.email}</span>` +
    `</div>`;
  hubAppMenu.appendChild(profile);

  const bgChip = document.createElement("div");
  bgChip.className = "hub-float-chip hub-bg-chip";
  bgChip.innerHTML =
    `<span class="hub-float-icon" aria-hidden="true">🖼️</span>` +
    `<div class="hub-bg-panel">` +
    `<span class="hub-bg-title">배경 사진</span>` +
    `<div class="hub-bg-actions">` +
    `<button type="button" class="hub-bg-btn" id="hubBgUploadBtn">올리기</button>` +
    `<button type="button" class="hub-bg-btn hub-bg-btn-ghost" id="hubBgResetBtn">기본</button>` +
    `</div>` +
    `<input type="file" id="hubBgFile" accept="image/*" hidden />` +
    `</div>`;
  hubAppMenu.appendChild(bgChip);
  mountBackgroundControls();

  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "hub-float-chip hub-logout-chip";
  logout.id = "hubLogout";
  logout.title = "로그아웃";
  logout.innerHTML =
    `<span class="hub-float-icon" aria-hidden="true">🚪</span>` +
    `<span class="hub-float-label">로그아웃</span>`;
  logout.addEventListener("click", onLogout);
  hubAppMenu.appendChild(logout);

  for (const app of APPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hub-float-chip hub-app-chip" + (app.id === activeId ? " is-active" : "");
    btn.dataset.appId = app.id;
    btn.title = app.label;
    btn.innerHTML =
      `<span class="hub-float-icon" aria-hidden="true">${app.icon}</span>` +
      `<span class="hub-float-label">${app.label}</span>`;
    btn.addEventListener("click", () => selectApp(app.id));
    hubAppMenu.appendChild(btn);
  }
}

function updateFabIcon(activeId) {
  const iconEl = hubMenuFab?.querySelector(".hub-menu-fab-icon");
  if (!iconEl) return;
  if (isMenuOpen()) {
    iconEl.textContent = "✕";
    return;
  }
  const app = APPS.find((a) => a.id === activeId) || APPS[0];
  iconEl.textContent = app.icon;
}

function selectApp(appId) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderFabMenu(app.id);
  const currentPath = new URL(appFrame.getAttribute("src") || app.path, window.location.origin)
    .pathname;
  if (currentPath !== app.path) {
    appFrame.src = app.path;
    appFrame.title = app.label;
  }
  closeMenu();
  updateFabIcon(app.id);
}

function initAppFromUrl() {
  const path = window.location.pathname;
  const match = APPS.find((a) => path === a.path || path.startsWith(a.path + "/"));
  const saved = localStorage.getItem(APP_KEY);
  const defaultAppId = "chalkboard";
  const id =
    match?.id ||
    (APPS.some((a) => a.id === saved) ? saved : defaultAppId);
  const app = APPS.find((a) => a.id === id) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderFabMenu(app.id);
  appFrame.src = app.path;
  appFrame.title = app.label;
  updateFabIcon(app.id);
  if (path !== "/" && path !== "/index.html") {
    history.replaceState(null, "", "/");
  }
}

async function onLogout() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
  } catch (_) {}
  window.UserBackground?.clear?.();
  window.location.href = "/login";
}

async function loadHubProfile() {
  try {
    const res = await fetch("/api/grading/me", { credentials: "include" });
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const me = await res.json();
    hubProfile = {
      email: me.userId ? String(me.userId) : "—",
      name: me.displayName || me.userId || "선생님",
      school: me.school || "우리반",
    };
  } catch (_) {
    hubProfile = { email: "—", name: "선생님", school: "—" };
  }
  updateProfileChip();
}

function mountBackgroundControls() {
  const uploadBtn = document.getElementById("hubBgUploadBtn");
  const resetBtn = document.getElementById("hubBgResetBtn");
  const fileInput = document.getElementById("hubBgFile");
  if (!uploadBtn || !resetBtn || !fileInput || uploadBtn.dataset.bound) return;
  uploadBtn.dataset.bound = "1";

  uploadBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("이미지 파일만 올릴 수 있습니다.");
      return;
    }
    try {
      uploadBtn.disabled = true;
      uploadBtn.textContent = "처리 중…";
      const dataUrl = await window.UserBackground.resizeImageFile(file);
      await window.UserBackground.saveBackground(dataUrl);
      uploadBtn.textContent = "완료!";
      setTimeout(() => {
        uploadBtn.textContent = "올리기";
      }, 1200);
    } catch (err) {
      alert(err.message || "배경을 저장하지 못했습니다.");
      uploadBtn.textContent = "올리기";
    } finally {
      uploadBtn.disabled = false;
    }
  });

  resetBtn.addEventListener("click", async () => {
    if (!confirm("배경 사진을 기본으로 되돌릴까요?")) return;
    try {
      resetBtn.disabled = true;
      await window.UserBackground.saveBackground(null);
    } catch (err) {
      alert(err.message || "기본 배경으로 되돌리지 못했습니다.");
    } finally {
      resetBtn.disabled = false;
    }
  });
}

hubMenuFab?.addEventListener("click", () => {
  toggleMenu();
  updateFabIcon(localStorage.getItem(APP_KEY) || APPS[0].id);
});

hubMenuBackdrop?.addEventListener("click", () => {
  closeMenu();
  updateFabIcon(localStorage.getItem(APP_KEY) || APPS[0].id);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isMenuOpen()) {
    closeMenu();
    updateFabIcon(localStorage.getItem(APP_KEY) || APPS[0].id);
  }
});

loadHubProfile();
initAppFromUrl();
