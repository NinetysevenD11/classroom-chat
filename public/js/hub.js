/** 교실 도구함 — 하단 메뉴 시트 + 앱 전환 */

const APPS = [
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

const sidebarNav = document.getElementById("sidebarNav");
const appFrame = document.getElementById("appFrame");
const hubLogout = document.getElementById("hubLogout");
const hubMenuFab = document.getElementById("hubMenuFab");
const hubMenuOverlay = document.getElementById("hubMenuOverlay");
const hubMenuBackdrop = document.getElementById("hubMenuBackdrop");
const hubMenuSheet = document.getElementById("hubMenuSheet");

const APP_KEY = "hubActiveApp";

function isMenuOpen() {
  return hubMenuOverlay?.classList.contains("is-open");
}

function openMenu() {
  if (!hubMenuOverlay) return;
  hubMenuOverlay.hidden = false;
  requestAnimationFrame(() => {
    hubMenuOverlay.classList.add("is-open");
    document.body.classList.add("hub-menu-open");
    hubMenuFab?.setAttribute("aria-expanded", "true");
    hubMenuFab?.setAttribute("aria-label", "교실 도구함 메뉴 닫기");
  });
}

function closeMenu() {
  if (!hubMenuOverlay) return;
  hubMenuOverlay.classList.remove("is-open");
  document.body.classList.remove("hub-menu-open");
  hubMenuFab?.setAttribute("aria-expanded", "false");
  hubMenuFab?.setAttribute("aria-label", "교실 도구함 메뉴 열기");
  const onEnd = (e) => {
    if (e.target !== hubMenuSheet || e.propertyName !== "transform") return;
    hubMenuSheet.removeEventListener("transitionend", onEnd);
    if (!isMenuOpen()) hubMenuOverlay.hidden = true;
  };
  hubMenuSheet?.addEventListener("transitionend", onEnd);
  setTimeout(() => {
    if (!isMenuOpen()) hubMenuOverlay.hidden = true;
  }, 320);
}

function toggleMenu() {
  if (isMenuOpen()) closeMenu();
  else openMenu();
}

function renderNav(activeId) {
  if (!sidebarNav) return;
  sidebarNav.innerHTML = "";
  for (const app of APPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item" + (app.id === activeId ? " is-active" : "");
    btn.dataset.appId = app.id;
    btn.dataset.path = app.path;
    btn.title = app.label;
    btn.innerHTML =
      `<span class="nav-icon" aria-hidden="true">${app.icon}</span>` +
      `<span class="nav-label">${app.label}</span>`;
    btn.addEventListener("click", () => selectApp(app.id));
    sidebarNav.appendChild(btn);
  }
}

function updateFabLabel(activeId) {
  const app = APPS.find((a) => a.id === activeId) || APPS[0];
  const iconEl = hubMenuFab?.querySelector(".hub-menu-fab-icon");
  const labelEl = hubMenuFab?.querySelector(".hub-menu-fab-label");
  if (iconEl) iconEl.textContent = app.icon;
  if (labelEl) labelEl.textContent = app.label;
}

function selectApp(appId) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderNav(app.id);
  updateFabLabel(app.id);
  const currentPath = new URL(appFrame.getAttribute("src") || app.path, window.location.origin)
    .pathname;
  if (currentPath !== app.path) {
    appFrame.src = app.path;
    appFrame.title = app.label;
  }
  closeMenu();
}

function initAppFromUrl() {
  const path = window.location.pathname;
  const match = APPS.find((a) => path === a.path || path.startsWith(a.path + "/"));
  const saved = localStorage.getItem(APP_KEY);
  const id = match?.id || (APPS.some((a) => a.id === saved) ? saved : APPS[0].id);
  const app = APPS.find((a) => a.id === id) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderNav(app.id);
  updateFabLabel(app.id);
  appFrame.src = app.path;
  appFrame.title = app.label;
  if (path !== "/" && path !== "/index.html") {
    history.replaceState(null, "", "/");
  }
}

hubMenuFab?.addEventListener("click", toggleMenu);
hubMenuBackdrop?.addEventListener("click", closeMenu);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isMenuOpen()) closeMenu();
});

hubLogout?.addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
  } catch (_) {}
  window.location.href = "/login";
});

async function loadHubProfile() {
  const emailEl = document.getElementById("hubProfileEmail");
  const nameEl = document.getElementById("hubProfileName");
  const schoolEl = document.getElementById("hubProfileSchool");
  if (!emailEl || !nameEl || !schoolEl) return;
  try {
    const res = await fetch("/api/grading/me", { credentials: "include" });
    if (res.status === 401) {
      window.location.href = "/login";
      return;
    }
    const me = await res.json();
    emailEl.textContent = me.userId ? String(me.userId) : "—";
    nameEl.textContent = me.displayName || me.userId || "선생님";
    schoolEl.textContent = me.school || "우리반";
  } catch (_) {
    emailEl.textContent = "—";
    nameEl.textContent = "선생님";
    schoolEl.textContent = "—";
  }
}

loadHubProfile();
initAppFromUrl();
