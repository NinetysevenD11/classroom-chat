const teacherTableBody = document.getElementById("teacherTableBody");
const loginLogBody = document.getElementById("loginLogBody");
const loadError = document.getElementById("loadError");
const globalSearch = document.getElementById("globalSearch");
const tableSearch = document.getElementById("tableSearch");
const pageTitle = document.getElementById("pageTitle");
const panelTeachers = document.getElementById("panelTeachers");
const panelLogs = document.getElementById("panelLogs");
const rowMenu = document.getElementById("rowMenu");
const rosterModal = document.getElementById("rosterModal");
const pwModal = document.getElementById("pwModal");

let allTeachers = [];
let allLogs = [];
let activeTeacherId = null;
let menuTargetUserId = null;
let pwTargetUserId = null;
let currentTab = "teachers";

const MAX_SEATS = 19;

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setTab(tab) {
  currentTab = tab;
  const isTeachers = tab === "teachers";
  panelTeachers.classList.toggle("hidden", !isTeachers);
  panelLogs.classList.toggle("hidden", isTeachers);
  pageTitle.textContent = isTeachers ? "선생님 계정" : "로그인 기록";
  document.querySelectorAll(".side-nav .nav-item[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  document.querySelectorAll(".panel .tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
  applySearch();
}

function renderStats(teachers, activeId) {
  const online = teachers.filter((t) => t.teacherOnline).length;
  const students = teachers.reduce((s, t) => s + t.rosterCount, 0);
  document.getElementById("statTeachers").textContent = String(teachers.length);
  document.getElementById("statOnline").textContent = String(online);
  document.getElementById("statStudents").textContent = String(students);
  document.getElementById("teacherCount").textContent = `${teachers.length} records`;

  const hint = document.getElementById("activeHint");
  if (activeId) {
    hint.textContent = activeId;
  } else {
    hint.textContent = "접속 중인 교사 없음";
  }

  const offline = teachers.length - online;
  document.getElementById("onlineLegend").innerHTML = `
    <span><span class="legend-dot" style="background:var(--green)"></span>접속 ${online}</span>
    <span><span class="legend-dot" style="background:#cbd5e1"></span>오프라인 ${offline}</span>
    <span><span class="legend-dot" style="background:var(--primary)"></span>명단 등록 ${students}명</span>`;
}

function matchesQuery(t, q) {
  if (!q) return true;
  const lower = q.toLowerCase();
  if (t.id.toLowerCase().includes(lower)) return true;
  return t.students.some(
    (s) => s.name.toLowerCase().includes(lower) || String(s.seat).includes(lower)
  );
}

function renderTeacherTable(list) {
  if (!list.length) {
    teacherTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="6">등록된 선생님 계정이 없습니다.</td></tr>';
    return;
  }

  teacherTableBody.innerHTML = list
    .map((t) => {
      const pct = Math.round((t.rosterCount / MAX_SEATS) * 100);
      const pwDisplay = t.password
        ? `<code class="pw-text pw-masked" data-pw="${escapeHtml(t.password)}">••••••••</code>
           <button type="button" class="pw-toggle" title="보기">👁</button>`
        : `<span class="pw-text muted">미확인</span>`;

      return `
      <tr data-user-id="${escapeHtml(t.id)}">
        <td><span class="cell-id">${escapeHtml(t.id)}</span></td>
        <td><span class="badge-pill ${t.teacherOnline ? "online" : "offline"}">${
        t.teacherOnline ? "접속 중" : "오프라인"
      }</span></td>
        <td>${fmtTime(t.lastLoginAt)}</td>
        <td><div class="pw-cell">${pwDisplay}</div></td>
        <td>
          <div class="roster-bar">
            <div class="roster-progress"><div class="roster-progress-fill" style="width:${pct}%"></div></div>
            <span class="roster-count">${t.rosterCount}/${MAX_SEATS}</span>
          </div>
        </td>
        <td>
          <div class="btn-row">
            <button type="button" class="btn icon-only menu-trigger" data-user-id="${escapeHtml(t.id)}" title="메뉴">⋮</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");
}

function renderLoginTable(list) {
  document.getElementById("logCount").textContent = `${list.length} records`;
  if (!list.length) {
    loginLogBody.innerHTML =
      '<tr class="empty-row"><td colspan="3">로그인 기록이 없습니다.</td></tr>';
    return;
  }
  loginLogBody.innerHTML = list
    .map(
      (e) => `
    <tr>
      <td>${fmtTime(e.at)}</td>
      <td><span class="cell-id">${escapeHtml(e.userId)}</span></td>
      <td><span class="badge-pill ${e.isAdmin ? "admin" : "teacher"}">${
        e.isAdmin ? "관리자" : "선생님"
      }</span></td>
    </tr>`
    )
    .join("");
}

function applySearch() {
  const q = (globalSearch.value || tableSearch.value || "").trim().toLowerCase();
  if (currentTab === "teachers") {
    const filtered = allTeachers.filter((t) => matchesQuery(t, q));
    renderTeacherTable(filtered);
    document.getElementById("teacherCount").textContent = `${filtered.length} records`;
  } else {
    const filtered = allLogs.filter((e) => {
      if (!q) return true;
      return e.userId.toLowerCase().includes(q);
    });
    renderLoginTable(filtered);
  }
}

function openRosterModal(userId) {
  const t = allTeachers.find((x) => x.id === userId);
  if (!t) return;
  document.getElementById("rosterModalTitle").textContent = `👥 ${userId} · 우리반 학생`;
  const body = document.getElementById("rosterModalBody");
  if (!t.students.length) {
    body.innerHTML = '<p class="empty-row">등록된 학생 명단이 없습니다.</p>';
  } else {
    body.innerHTML = `<div class="roster-grid-modal">${t.students
      .map(
        (s) =>
          `<div class="roster-chip-modal"><b>${s.seat}번</b> ${escapeHtml(s.name)}</div>`
      )
      .join("")}</div>`;
  }
  rosterModal.classList.remove("hidden");
}

function openPwModal(userId) {
  pwTargetUserId = userId;
  document.getElementById("pwModalTitle").textContent = `🔑 ${userId} 비밀번호 변경`;
  document.getElementById("pwModalInput").value = "";
  pwModal.classList.remove("hidden");
  document.getElementById("pwModalInput").focus();
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function showRowMenu(btn, userId) {
  menuTargetUserId = userId;
  rowMenu.classList.remove("hidden");
  const rect = btn.getBoundingClientRect();
  rowMenu.style.top = `${rect.bottom + 4}px`;
  rowMenu.style.left = `${Math.max(8, rect.left - 120)}px`;
}

function hideRowMenu() {
  rowMenu.classList.add("hidden");
  menuTargetUserId = null;
}

async function loadOverview() {
  loadError.classList.add("hidden");
  try {
    const res = await fetch("/api/admin/overview");
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "데이터를 불러오지 못했습니다.");

    allTeachers = data.teachers || [];
    allLogs = data.recentLogins || [];
    activeTeacherId = data.activeTeacherId || null;
    renderStats(allTeachers, activeTeacherId);
    applySearch();
    if (currentTab === "logs") renderLoginTable(allLogs);
  } catch (err) {
    loadError.textContent = err.message;
    loadError.classList.remove("hidden");
  }
}

async function resetPassword(userId, password) {
  const res = await fetch("/api/admin/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "비밀번호 변경 실패");
  return data.password;
}

async function deleteUser(userId) {
  const res = await fetch("/api/admin/delete-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "탈퇴 실패");
}

document.querySelectorAll(".side-nav .nav-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});
document.querySelectorAll(".panel .tab").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

globalSearch.addEventListener("input", applySearch);
tableSearch.addEventListener("input", () => {
  globalSearch.value = tableSearch.value;
  applySearch();
});

teacherTableBody.addEventListener("click", (e) => {
  const toggle = e.target.closest(".pw-toggle");
  if (toggle) {
    const code = toggle.previousElementSibling;
    if (code?.dataset.pw) {
      const hidden = code.classList.contains("pw-masked");
      code.textContent = hidden ? code.dataset.pw : "••••••••";
      code.classList.toggle("pw-masked", !hidden);
      toggle.textContent = hidden ? "🙈" : "👁";
    }
    return;
  }
  const menuBtn = e.target.closest(".menu-trigger");
  if (menuBtn) {
    e.stopPropagation();
    showRowMenu(menuBtn, menuBtn.dataset.userId);
  }
});

rowMenu.addEventListener("click", async (e) => {
  const action = e.target.closest("button")?.dataset?.menu;
  const userId = menuTargetUserId;
  hideRowMenu();
  if (!action || !userId) return;

  if (action === "roster") {
    openRosterModal(userId);
    return;
  }
  if (action === "reset-pw") {
    openPwModal(userId);
    return;
  }
  if (action === "delete") {
    if (
      !confirm(
        `'${userId}' 계정을 탈퇴할까요?\n\n명단·프로필이 삭제되며 복구할 수 없습니다.`
      )
    )
      return;
    try {
      await deleteUser(userId);
      alert(`'${userId}' 계정이 삭제되었습니다.`);
      await loadOverview();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-trigger") && !e.target.closest("#rowMenu")) {
    hideRowMenu();
  }
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
rosterModal.addEventListener("click", (e) => {
  if (e.target === rosterModal) closeModal("rosterModal");
});
pwModal.addEventListener("click", (e) => {
  if (e.target === pwModal) closeModal("pwModal");
});

document.getElementById("pwModalSave").addEventListener("click", async () => {
  const password = document.getElementById("pwModalInput").value.trim();
  if (!password || password.length < 4) {
    alert("비밀번호는 4자 이상이어야 합니다.");
    return;
  }
  try {
    const newPw = await resetPassword(pwTargetUserId, password);
    closeModal("pwModal");
    alert(`비밀번호가 변경되었습니다.\n\n새 비밀번호: ${newPw}`);
    await loadOverview();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("refreshBtn").addEventListener("click", loadOverview);
document.getElementById("logoutLink").addEventListener("click", async (e) => {
  e.preventDefault();
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

loadOverview();
setInterval(loadOverview, 30000);
