/** 교실 도구함 — 사이드바 + 앱 전환 */

const APPS = [
  {
    id: "chalkboard",
    label: "우리반 칠판",
    icon: "📋",
    path: "/app/chalkboard",
  },
];

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarNav = document.getElementById("sidebarNav");
const appFrame = document.getElementById("appFrame");
const hubLogout = document.getElementById("hubLogout");

const COLLAPSE_KEY = "hubSidebarCollapsed";
const APP_KEY = "hubActiveApp";

function isCollapsed() {
  return localStorage.getItem(COLLAPSE_KEY) === "1";
}

function applyCollapse(collapsed) {
  sidebar.classList.toggle("is-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  sidebarToggle.title = collapsed ? "메뉴 펼치기" : "메뉴 접기";
}

function renderNav(activeId) {
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

function selectApp(appId) {
  const app = APPS.find((a) => a.id === appId) || APPS[0];
  localStorage.setItem(APP_KEY, app.id);
  renderNav(app.id);
  const currentPath = new URL(appFrame.getAttribute("src") || app.path, window.location.origin)
    .pathname;
  if (currentPath === app.path) return;
  appFrame.src = app.path;
  appFrame.title = app.label;
}

function initAppFromUrl() {
  const path = window.location.pathname;
  const match = APPS.find((a) => path === a.path || path.startsWith(a.path + "/"));
  const saved = localStorage.getItem(APP_KEY);
  const id = match?.id || (APPS.some((a) => a.id === saved) ? saved : APPS[0].id);
  selectApp(id);
  if (path !== "/" && path !== "/index.html") {
    history.replaceState(null, "", "/");
  }
}

sidebarToggle.addEventListener("click", () => {
  const next = !sidebar.classList.contains("is-collapsed");
  sidebar.classList.toggle("is-collapsed", next);
  localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  applyCollapse(next);
});

hubLogout.addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
  } catch (_) {}
  window.location.href = "/login";
});

applyCollapse(isCollapsed());
initAppFromUrl();
