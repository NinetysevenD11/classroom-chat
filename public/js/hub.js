/** 교실 도구함 — FAB + 플로팅 앱 전환 */

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

const hubAppMenu = document.getElementById("hubAppMenu");
const appFrame = document.getElementById("appFrame");
const hubMenuFab = document.getElementById("hubMenuFab");
const hubMenuBackdrop = document.getElementById("hubMenuBackdrop");

const APP_KEY = "hubActiveApp";

function isMenuOpen() {
  return document.body.classList.contains("hub-menu-open");
}

function openMenu() {
  hubAppMenu.hidden = false;
  hubMenuBackdrop.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("hub-menu-open");
    hubMenuFab?.setAttribute("aria-expanded", "true");
    hubMenuFab?.setAttribute("aria-label", "앱 메뉴 닫기");
  });
}

function closeMenu() {
  document.body.classList.remove("hub-menu-open");
  hubMenuFab?.setAttribute("aria-expanded", "false");
  hubMenuFab?.setAttribute("aria-label", "앱 메뉴 열기");
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

function renderAppMenu(activeId) {
  if (!hubAppMenu) return;
  hubAppMenu.innerHTML = "";
  for (const app of APPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hub-app-chip" + (app.id === activeId ? " is-active" : "");
    btn.dataset.appId = app.id;
    btn.title = app.label;
    btn.innerHTML =
      `<span class="hub-app-chip-icon" aria-hidden="true">${app.icon}</span>` +
      `<span class="hub-app-chip-label">${app.label}</span>`;
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
  renderAppMenu(app.id);
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
  const id = match?.id || (APPS.some((a) => a.id === saved) ? saved : APPS[0].id);
  const app = APPS.find((a) => a.id === id) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderAppMenu(app.id);
  appFrame.src = app.path;
  appFrame.title = app.label;
  updateFabIcon(app.id);
  if (path !== "/" && path !== "/index.html") {
    history.replaceState(null, "", "/");
  }
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

async function ensureHubAuth() {
  try {
    const res = await fetch("/api/grading/me", { credentials: "include" });
    if (res.status === 401) window.location.href = "/login";
  } catch (_) {}
}

ensureHubAuth();
initAppFromUrl();
