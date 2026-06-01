const teacherList = document.getElementById("teacherList");
const teacherCount = document.getElementById("teacherCount");
const activeHint = document.getElementById("activeHint");
const loginLogBody = document.getElementById("loginLogBody");
const loadError = document.getElementById("loadError");

function fmtTime(ts) {
  if (!ts) return "기록 없음";
  const d = new Date(ts);
  return d.toLocaleString("ko-KR", {
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

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function passwordLabel(pw) {
  if (pw) return escapeHtml(pw);
  return '<span class="pw-unknown">미확인 (아래에서 재설정)</span>';
}

function renderTeachers(teachers, activeTeacherId) {
  teacherCount.textContent = String(teachers.length);
  if (activeTeacherId) {
    activeHint.textContent = `지금 학생이 접속하는 교사 화면: ${activeTeacherId}`;
  } else {
    activeHint.textContent = "현재 교사 화면에 접속한 선생님이 없습니다.";
  }

  if (!teachers.length) {
    teacherList.innerHTML = '<p class="empty-state">등록된 선생님 계정이 없습니다.</p>';
    return;
  }

  teacherList.innerHTML = teachers
    .map((t) => {
      const rosterHtml = t.students.length
        ? `<div class="roster-grid">${t.students
            .map((s) => `<span class="roster-chip">${s.seat}번 ${escapeHtml(s.name)}</span>`)
            .join("")}</div>`
        : '<p class="roster-empty">우리반 학생 명단이 비어 있습니다.</p>';

      return `
        <article class="teacher-card" data-user-id="${escapeAttr(t.id)}">
          <div class="teacher-card-head">
            <span class="teacher-id">${escapeHtml(t.id)}</span>
            <span class="status ${t.teacherOnline ? "online" : "offline"}">${
        t.teacherOnline ? "교사 화면 접속 중" : "오프라인"
      }</span>
            <span class="last-login">마지막 로그인: ${fmtTime(t.lastLoginAt)}</span>
          </div>
          <div class="pw-row">
            <span class="pw-label">비밀번호</span>
            <code class="pw-value">${passwordLabel(t.password)}</code>
          </div>
          <div class="admin-row">
            <input type="password" class="pw-input" data-pw-for="${escapeAttr(t.id)}" placeholder="새 비밀번호 (4자 이상)" maxlength="32" autocomplete="new-password" />
            <button type="button" class="btn small" data-action="reset-pw" data-user-id="${escapeAttr(t.id)}">비밀번호 변경</button>
            <button type="button" class="btn small danger" data-action="delete-user" data-user-id="${escapeAttr(t.id)}">탈퇴</button>
          </div>
          <div class="roster-title">우리반 학생 (${t.rosterCount}명)</div>
          ${rosterHtml}
        </article>`;
    })
    .join("");
}

function renderLoginLogs(logs) {
  if (!logs.length) {
    loginLogBody.innerHTML =
      '<tr><td colspan="3" class="empty-state">로그인 기록이 없습니다.</td></tr>';
    return;
  }

  loginLogBody.innerHTML = logs
    .map(
      (e) => `
    <tr>
      <td>${fmtTime(e.at)}</td>
      <td>${escapeHtml(e.userId)}</td>
      <td>${e.isAdmin ? '<span class="tag-admin">관리자</span>' : '<span class="tag-teacher">선생님</span>'}</td>
    </tr>`
    )
    .join("");
}

async function loadOverview() {
  loadError.classList.add("hidden");
  loadError.textContent = "";
  try {
    const res = await fetch("/api/admin/overview");
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "데이터를 불러오지 못했습니다.");
    }
    renderTeachers(data.teachers || [], data.activeTeacherId);
    renderLoginLogs(data.recentLogins || []);
  } catch (err) {
    loadError.textContent = err.message || "오류가 발생했습니다.";
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

teacherList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const userId = btn.dataset.userId;
  const action = btn.dataset.action;

  if (action === "reset-pw") {
    const card = btn.closest(".teacher-card");
    const inp = card?.querySelector(".pw-input");
    const password = inp?.value?.trim();
    if (!password || password.length < 4) {
      alert("새 비밀번호는 4자 이상이어야 합니다.");
      return;
    }
    btn.disabled = true;
    try {
      const newPw = await resetPassword(userId, password);
      alert(`'${userId}' 비밀번호가 변경되었습니다.\n\n새 비밀번호: ${newPw}`);
      if (inp) inp.value = "";
      await loadOverview();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === "delete-user") {
    if (
      !confirm(
        `'${userId}' 계정을 탈퇴 처리할까요?\n\n명단·프로필 데이터도 함께 삭제되며 되돌릴 수 없습니다.`
      )
    ) {
      return;
    }
    btn.disabled = true;
    try {
      await deleteUser(userId);
      alert(`'${userId}' 계정이 삭제되었습니다.`);
      await loadOverview();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  }
});

document.getElementById("refreshBtn").addEventListener("click", loadOverview);
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

loadOverview();
setInterval(loadOverview, 30000);
