/** 선생님 채점도구 — 교실 도구함 탭 */

let state = null;
let currentView = "home";
let saveTimer = null;
let roster = {};
let onlineSeats = {};
let studentUrl = "";
let qrDataUrl = "";

const mainEl = document.getElementById("gradingMain");
const subjectList = document.getElementById("subjectList");
const classList = document.getElementById("classList");
const lockList = document.getElementById("lockList");

const CHECKLIST = [
  { id: "exam", title: "시험 추가", desc: "시험을 만들고 활성화하면 학생 화면에 반영됩니다.", view: "exam", badge: "done" },
  { id: "class", title: "학반 추가", desc: "학반을 만들고 학생 수를 설정하세요.", view: "home", badge: "warn" },
  { id: "subject", title: "과목 추가", desc: "시험 설정에서 과목·단원을 추가합니다.", view: "exam", badge: "warn" },
  { id: "answer", title: "정답 설정", desc: "객관식·단답형·서술형 정답과 배점을 입력합니다.", view: "exam", badge: "warn" },
  { id: "lock", title: "학생화면 과목 잠금", desc: "학생이 답을 보거나 수정할 수 있는 시점을 제어합니다.", view: "home", badge: "pick" },
  { id: "qr", title: "학생 QR 접속 확인", desc: "QR·주소로 학생이 /exam 에 접속하는지 확인하세요.", view: "home", badge: "pick" },
  { id: "login", title: "학생 로그인·비밀번호 안내", desc: "이름과 4자리 비밀번호로 시험에 참여합니다.", view: "home", badge: "pick" },
  { id: "live", title: "실시간 현황 확인", desc: "제출 상태와 점수를 실시간으로 확인합니다.", view: "grades", badge: "pick" },
  { id: "print", title: "성적표 인쇄", desc: "개별·일괄 성적표를 인쇄합니다.", view: "grades", badge: "pick" },
  { id: "ai", title: "AI 도우미", desc: "이미지에서 정답 생성·채점 제안(준비 중).", view: "home", badge: "pick" },
];

function activeExam() {
  return state.exams?.find((e) => e.id === state.activeExamId) || state.exams?.[0];
}

function activeSubject() {
  const exam = activeExam();
  if (!exam) return null;
  return exam.subjects?.find((s) => s.id === state.activeSubjectId) || exam.subjects?.[0];
}

function activeUnit() {
  const sub = activeSubject();
  if (!sub) return null;
  return sub.units?.find((u) => u.id === state.activeUnitId) || sub.units?.[0];
}

function activeClass() {
  return state.classes?.find((c) => c.id === state.activeClassId) || state.classes?.[0];
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fetch("/api/grading", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(state),
      });
    } catch (err) {
      console.error("[채점] 저장 실패", err);
    }
  }, 400);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadData() {
  const [gradingRes, rosterRes, meRes, onlineRes] = await Promise.all([
    fetch("/api/grading", { credentials: "include" }),
    fetch("/api/grading/roster", { credentials: "include" }),
    fetch("/api/grading/me", { credentials: "include" }),
    fetch("/api/grading/online", { credentials: "include" }),
  ]);
  if (gradingRes.status === 401) {
    window.top.location.href = "/login";
    return;
  }
  state = await gradingRes.json();
  const rosterData = await rosterRes.json();
  roster = rosterData.roster || {};
  const me = await meRes.json();
  onlineSeats = (await onlineRes.json()).online || {};
  document.getElementById("profileEmail").textContent = me.userId ? `${me.userId}@교실도구함` : "—";
  document.getElementById("profileName").textContent = me.displayName || me.userId || "선생님";
  document.getElementById("profileSchool").textContent = me.school || "우리반";
  renderSidebar();
  renderView(currentView);
  updateChecklistBadges();
}

function renderSidebar() {
  const exam = activeExam();
  subjectList.innerHTML = "";
  if (!exam) return;
  for (const sub of exam.subjects || []) {
    const li = document.createElement("li");
    li.className = "sb-item" + (sub.id === state.activeSubjectId ? " is-active" : "");
    li.innerHTML = `
      <span class="dot ${sub.active ? "on" : "off"}"></span>
      <span class="label">${escapeHtml(sub.name)}</span>
      <button type="button" class="icon-btn" data-action="edit-sub" title="이름 수정">✎</button>
      <button type="button" class="icon-btn" data-action="del-sub" title="삭제">✕</button>
    `;
    li.querySelector(".label").addEventListener("click", () => {
      state.activeSubjectId = sub.id;
      if (sub.units?.[0]) state.activeUnitId = sub.units[0].id;
      scheduleSave();
      renderSidebar();
      if (currentView === "exam") renderView("exam");
      renderLockList();
    });
    li.querySelector('[data-action="edit-sub"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const name = prompt("과목 이름", sub.name);
      if (name?.trim()) {
        sub.name = name.trim();
        scheduleSave();
        renderSidebar();
        if (currentView === "exam") renderView("exam");
      }
    });
    li.querySelector('[data-action="del-sub"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`"${sub.name}" 과목을 삭제할까요?`)) return;
      exam.subjects = exam.subjects.filter((s) => s.id !== sub.id);
      if (state.activeSubjectId === sub.id) state.activeSubjectId = exam.subjects[0]?.id;
      scheduleSave();
      renderSidebar();
      renderView(currentView);
      renderLockList();
    });
    subjectList.appendChild(li);
  }

  classList.innerHTML = "";
  for (const cls of state.classes || []) {
    const li = document.createElement("li");
    li.className = "sb-item" + (cls.id === state.activeClassId ? " is-active" : "");
    li.innerHTML = `
      <span class="label">${escapeHtml(cls.name)} (${cls.studentCount}명)</span>
      <button type="button" class="icon-btn" data-action="del-class">✕</button>
    `;
    li.addEventListener("click", () => {
      state.activeClassId = cls.id;
      scheduleSave();
      renderSidebar();
      if (currentView === "grades") renderView("grades");
    });
    li.querySelector('[data-action="del-class"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`"${cls.name}" 을 삭제할까요?`)) return;
      state.classes = state.classes.filter((c) => c.id !== cls.id);
      if (state.activeClassId === cls.id) state.activeClassId = state.classes[0]?.id;
      scheduleSave();
      renderSidebar();
    });
    classList.appendChild(li);
  }

  renderLockList();
}

function renderLockList() {
  lockList.innerHTML = "";
  const sub = activeSubject();
  if (!sub) return;
  for (const unit of sub.units || []) {
    const li = document.createElement("li");
    li.className = "sb-item lock-item";
    li.innerHTML = `
      <div class="lock-name">${escapeHtml(unit.name)}</div>
      <div class="lock-toggle">
        <button type="button" class="btn-lock ${unit.locked ? "locked" : ""}" data-lock="1">🔒 잠금</button>
        <button type="button" class="btn-lock ${!unit.locked ? "open" : ""}" data-lock="0">📶 열림</button>
      </div>
    `;
    li.querySelector('[data-lock="1"]').addEventListener("click", () => {
      unit.locked = true;
      scheduleSave();
      renderLockList();
    });
    li.querySelector('[data-lock="0"]').addEventListener("click", () => {
      unit.locked = false;
      scheduleSave();
      renderLockList();
    });
    lockList.appendChild(li);
  }
}

function updateChecklistBadges() {
  const exam = activeExam();
  const sub = activeSubject();
  const unit = activeUnit();
  const hasExam = (state.exams?.length || 0) > 0;
  const hasClass = (state.classes?.length || 0) > 0;
  const hasSubject = (exam?.subjects?.length || 0) > 0;
  const hasAnswers = unit?.questions?.some((q) => q.answer) || false;
  CHECKLIST[0].badge = hasExam ? "done" : "warn";
  CHECKLIST[1].badge = hasClass ? "done" : "warn";
  CHECKLIST[2].badge = hasSubject ? "done" : "warn";
  CHECKLIST[3].badge = hasAnswers ? "done" : "warn";
  CHECKLIST[4].badge = sub?.units?.length ? "done" : "pick";
}

function setView(view) {
  currentView = view;
  renderView(view);
}

function renderView(view) {
  updateChecklistBadges();
  if (view === "home") renderHome();
  else if (view === "exam") renderExam();
  else if (view === "grades") renderGrades();
}

function renderHome() {
  const cards = CHECKLIST.map((c) => {
    const badgeClass = c.badge === "done" ? "done" : c.badge === "warn" ? "warn" : "pick";
    const badgeLabel = c.badge === "done" ? "완료" : c.badge === "warn" ? "확인" : "선택";
    return `
      <article class="check-card">
        <span class="check-badge ${badgeClass}">${badgeLabel}</span>
        <h3>${escapeHtml(c.title)}</h3>
        <p>${escapeHtml(c.desc)}</p>
        <button type="button" class="btn-goto" data-goto="${c.view}" data-id="${c.id}">위치 보기</button>
      </article>
    `;
  }).join("");

  mainEl.innerHTML = `
    <div class="view-home">
      <div class="hero">
        <h1>선생님을 위한 채점도구</h1>
        <p class="hero-sub">학생은 QR로 접속하고, 선생님은 시험 설정부터 채점·성적표 인쇄까지 한곳에서 관리합니다.</p>
        <div class="hero-actions">
          <button type="button" class="btn btn-ghost" id="patchNotesBtn" style="background:#fff;border:1px solid #e2e8f0;color:#334155">최근 패치노트</button>
          <button type="button" class="btn btn-ghost" id="devContactBtn" style="background:#fff;border:1px solid #e2e8f0;color:#334155">개발자 문의</button>
          <span class="badge-space">교사 전용 데이터 공간 사용 중</span>
        </div>
      </div>
      <div class="checklist-grid">${cards}</div>
    </div>
  `;

  mainEl.querySelectorAll(".btn-goto").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.goto;
      const id = btn.dataset.id;
      if (id === "qr") document.getElementById("qrOpenBtn").click();
      else if (id === "lock") renderSidebar();
      else setView(v);
    });
  });
  document.getElementById("patchNotesBtn")?.addEventListener("click", () => {
    alert("v1.0 — 교실 도구함에 채점도구가 추가되었습니다.");
  });
  document.getElementById("devContactBtn")?.addEventListener("click", () => {
    alert("문의: 교실 도구함 관리자에게 연락해 주세요.");
  });
}

function renderExam() {
  const sub = activeSubject();
  const unit = activeUnit();
  if (!sub || !unit) {
    mainEl.innerHTML = `<p>왼쪽에서 과목을 선택하거나 과목을 추가해 주세요.</p>`;
    return;
  }

  const tabs = (sub.units || [])
    .map(
      (u) =>
        `<button type="button" class="unit-tab ${u.id === unit.id ? "is-active" : ""}" data-unit="${u.id}">${escapeHtml(u.name)}</button>`
    )
    .join("");

  const qCards = (unit.questions || [])
    .map((q, idx) => {
      const typeClass = q.type === "short" ? "type-short" : q.type === "essay" ? "type-essay" : "";
      const essayExtra =
        q.type === "essay"
          ? `<div class="q-essay-extra"><a href="#" data-rubric="${idx}">+ 채점기준 추가</a></div>
             <button type="button" class="btn-manual-grade" data-manual="${idx}">이 문항 수동채점</button>`
          : "";
      return `
        <div class="q-card ${typeClass}" data-qidx="${idx}">
          <div class="q-card-head">
            <span class="num">${q.num}번</span>
            <select data-field="type">
              <option value="mc" ${q.type === "mc" ? "selected" : ""}>객관식</option>
              <option value="short" ${q.type === "short" ? "selected" : ""}>단답형</option>
              <option value="essay" ${q.type === "essay" ? "selected" : ""}>서술형</option>
            </select>
            <button type="button" class="del" data-del="${idx}">✕</button>
          </div>
          <input type="text" data-field="answer" placeholder="정답" value="${escapeHtml(q.answer)}" />
          <div class="pts">
            <select data-field="points">
              ${[1, 2, 3, 4, 5].map((p) => `<option value="${p}" ${String(q.points) === String(p) ? "selected" : ""}>${p}점</option>`).join("")}
            </select>
          </div>
          ${essayExtra}
        </div>
      `;
    })
    .join("");

  const thumbs = (unit.images || [])
    .map(
      (src, i) =>
        `<div class="paper-thumb"><img src="${src}" alt="시험지 ${i + 1}" /><button type="button" class="rm" data-rm-img="${i}">✕</button></div>`
    )
    .join("");

  mainEl.innerHTML = `
    <div class="view-exam">
      <div class="page-head">
        <h1>🎯 정답 및 문항 설정: ${escapeHtml(sub.name)}</h1>
        <div class="head-actions">
          <select id="importSubjectSelect" disabled><option>가져올 과목 선택</option></select>
          <button type="button" class="btn btn-import" disabled>가져오기</button>
          <button type="button" class="btn btn-share" disabled>공유 게시판에 올리기</button>
          <button type="button" class="btn btn-green" id="addSubjectBtn">+ 과목 추가</button>
          <button type="button" class="btn btn-ai" disabled>AI 도우미 열기</button>
        </div>
      </div>

      <div class="guide-box" id="guideBox">
        <button type="button" class="guide-toggle" id="guideToggle">정답·문항 설정 안내 보이기/숨기기</button>
        <div class="guide-steps">
          <div class="guide-step"><b>1</b>과목 추가</div>
          <div class="guide-step"><b>2</b>정답 입력</div>
          <div class="guide-step"><b>3</b>문항 유형 구분</div>
          <div class="guide-step"><b>4</b>시험 운영</div>
          <div class="guide-step"><b>5</b>서술형 채점</div>
        </div>
      </div>

      <div class="unit-tabs">${tabs}
        <button type="button" class="unit-tab" id="addUnitBtn" style="border-style:dashed">+ 단원</button>
      </div>

      <section class="paper-section">
        <div class="section-head">
          <h2>시험지 이미지 등록 (학생 화면 표시용)</h2>
          <div>
            <input type="file" id="paperInput" accept="image/*" multiple hidden />
            <button type="button" class="btn btn-blue" id="paperSelectBtn">파일 선택</button>
            <span class="paper-status">✓ ${(unit.images || []).length}장 등록됨</span>
          </div>
        </div>
        <div class="paper-thumbs" id="paperThumbs">${thumbs || '<span style="color:#94a3b8;font-size:13px">등록된 이미지가 없습니다.</span>'}</div>
      </section>

      <section class="answers-section">
        <div class="section-head">
          <h2>${escapeHtml(unit.name)} 정답 ${(unit.questions || []).length}문항</h2>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0 0 12px">문항 유형을 선택하고 정답·배점을 입력하세요.</p>
        <div class="questions-grid" id="questionsGrid">${qCards}</div>
        <button type="button" class="btn-add-q" id="addQuestionBtn">+ 문항 1개 수동 추가</button>
      </section>
    </div>
  `;

  document.getElementById("guideToggle").addEventListener("click", () => {
    document.getElementById("guideBox").classList.toggle("is-open");
  });

  mainEl.querySelectorAll(".unit-tab[data-unit]").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeUnitId = tab.dataset.unit;
      scheduleSave();
      renderExam();
      renderLockList();
    });
  });

  document.getElementById("addUnitBtn").addEventListener("click", () => {
    const name = prompt("단원 이름");
    if (!name?.trim()) return;
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    sub.units = sub.units || [];
    sub.units.push({
      id,
      name: name.trim(),
      locked: true,
      images: [],
      questions: [{ id, num: 1, type: "mc", answer: "", points: "1", rubric: "" }],
    });
    state.activeUnitId = id;
    scheduleSave();
    renderExam();
    renderLockList();
  });

  document.getElementById("addSubjectBtn").addEventListener("click", () => {
    const exam = activeExam();
    const name = prompt("과목 이름");
    if (!name?.trim() || !exam) return;
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    exam.subjects.push({
      id,
      name: name.trim(),
      active: false,
      units: [],
    });
    state.activeSubjectId = id;
    scheduleSave();
    renderSidebar();
    renderExam();
  });

  bindQuestionEditors(unit);
  bindPaperUpload(unit);
}

function bindQuestionEditors(unit) {
  const grid = document.getElementById("questionsGrid");
  if (!grid) return;

  grid.querySelectorAll(".q-card").forEach((card) => {
    const idx = Number(card.dataset.qidx);
    const q = unit.questions[idx];
    card.querySelector('[data-field="type"]').addEventListener("change", (e) => {
      q.type = e.target.value;
      scheduleSave();
      renderExam();
    });
    card.querySelector('[data-field="answer"]').addEventListener("input", (e) => {
      q.answer = e.target.value;
      scheduleSave();
    });
    card.querySelector('[data-field="points"]').addEventListener("change", (e) => {
      q.points = e.target.value;
      scheduleSave();
    });
    card.querySelector(".del")?.addEventListener("click", () => {
      unit.questions.splice(idx, 1);
      unit.questions.forEach((item, i) => {
        item.num = i + 1;
      });
      scheduleSave();
      renderExam();
    });
    card.querySelector("[data-rubric]")?.addEventListener("click", (e) => {
      e.preventDefault();
      const text = prompt("채점 기준", q.rubric || "");
      if (text !== null) {
        q.rubric = text;
        scheduleSave();
      }
    });
    card.querySelector("[data-manual]")?.addEventListener("click", () => {
      alert(`${q.num}번 서술형 — 성적표에서 학생별 수동 채점을 진행하세요.`);
      setView("grades");
    });
  });

  document.getElementById("addQuestionBtn")?.addEventListener("click", () => {
    const n = (unit.questions?.length || 0) + 1;
    unit.questions.push({
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      num: n,
      type: "mc",
      answer: "",
      points: "1",
      rubric: "",
    });
    scheduleSave();
    renderExam();
  });
}

function bindPaperUpload(unit) {
  const input = document.getElementById("paperInput");
  document.getElementById("paperSelectBtn")?.addEventListener("click", () => input.click());
  input?.addEventListener("change", () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    let pending = files.length;
    unit.images = unit.images || [];
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string" && reader.result.length < 800000) {
          unit.images.push(reader.result);
        }
        pending -= 1;
        if (pending === 0) {
          scheduleSave();
          renderExam();
        }
      };
      reader.readAsDataURL(file);
    }
    input.value = "";
  });

  document.getElementById("paperThumbs")?.querySelectorAll("[data-rm-img]").forEach((btn) => {
    btn.addEventListener("click", () => {
      unit.images.splice(Number(btn.dataset.rmImg), 1);
      scheduleSave();
      renderExam();
    });
  });
}

function getRosterStudents() {
  const list = [];
  for (let seat = 1; seat <= 19; seat++) {
    const name = roster[seat] || roster[String(seat)];
    if (name) list.push({ seat, name });
  }
  list.sort((a, b) => a.seat - b.seat);
  return list;
}

function scoreFor(studentKey, unitId) {
  const v = state.studentScores?.[studentKey]?.[unitId];
  return v === undefined || v === null ? "—" : v;
}

function formatSubmitted(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderGrades() {
  const sub = activeSubject();
  const cls = activeClass();
  const students = getRosterStudents();
  const units = sub?.units || [];

  const cols = units
    .map((u) => `<th>${escapeHtml(u.name)}</th>`)
    .join("");

  const rows = students.length
    ? students
        .map((st) => {
          const key = `${st.seat}:${st.name}`;
          const scores = units.map((u) => scoreFor(key, u.id));
          const nums = scores.filter((s) => typeof s === "number" || (typeof s === "string" && s !== "—" && !isNaN(Number(s))));
          const avg =
            nums.length > 0
              ? (nums.reduce((a, b) => a + Number(b), 0) / nums.length).toFixed(1)
              : "—";
          const online = !!onlineSeats[st.seat];
          return `
            <tr>
              <td><span class="dot ${online ? "on" : "off"}"></span>${st.seat}</td>
              <td class="name">${escapeHtml(st.name)}</td>
              ${scores.map((s) => `<td>${s}</td>`).join("")}
              <td class="avg">${avg}</td>
              <td>${formatSubmitted(state.studentScores?.[key]?._submittedAt)}</td>
              <td>
                <div class="row-actions">
                  <button type="button" class="view" data-student="${escapeHtml(key)}">학생결과보기</button>
                  <button type="button" class="print">인쇄</button>
                  <button type="button" class="reset" data-reset="${escapeHtml(key)}">초기화</button>
                  <button type="button" class="del" data-del="${escapeHtml(key)}">삭제</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="${6 + units.length}">우리반 학생 명단을 칠판에서 먼저 등록해 주세요.</td></tr>`;

  mainEl.innerHTML = `
    <div class="view-grades">
      <div class="grades-head">
        <div>
          <h1>📊 실시간 성적 현황표</h1>
          <p class="legend"><span class="dot on"></span> 온라인 · <span class="dot off"></span> 오프라인</p>
        </div>
        <div class="grades-actions">
          <button type="button" class="btn btn-publish ${state.resultsPublished ? "on" : "off"}" id="togglePublish">
            ${state.resultsPublished ? "결과 공개 중 (ON)" : "결과 비공개 (OFF)"}
          </button>
          <button type="button" class="btn btn-excel" id="excelBtn">📥 엑셀 다운로드</button>
          <button type="button" class="btn btn-print" id="bulkPrintBtn">🖨️ 일괄 인쇄</button>
        </div>
      </div>
      ${cls ? `<span class="class-badge">${escapeHtml(cls.name)}</span>` : ""}
      <div class="grades-table-wrap">
        <table class="grades-table">
          <thead>
            <tr>
              <th>번호</th>
              <th>이름</th>
              ${cols}
              <th>평균</th>
              <th>최종 제출</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("togglePublish")?.addEventListener("click", () => {
    state.resultsPublished = !state.resultsPublished;
    scheduleSave();
    renderGrades();
  });

  document.getElementById("excelBtn")?.addEventListener("click", () => {
    const lines = ["번호,이름," + units.map((u) => u.name).join(",") + ",평균"];
    for (const st of students) {
      const key = `${st.seat}:${st.name}`;
      const sc = units.map((u) => scoreFor(key, u.id));
      lines.push([st.seat, st.name, ...sc].join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "성적현황.csv";
    a.click();
  });

  document.getElementById("bulkPrintBtn")?.addEventListener("click", () => window.print());

  if (window._gradesPoll) clearInterval(window._gradesPoll);
  window._gradesPoll = setInterval(async () => {
    if (currentView !== "grades") return;
    try {
      const res = await fetch("/api/grading/online", { credentials: "include" });
      onlineSeats = (await res.json()).online || {};
      renderGrades();
    } catch (_) {}
  }, 8000);

  mainEl.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("이 학생의 제출·점수를 초기화할까요?")) return;
      delete state.studentScores[btn.dataset.reset];
      scheduleSave();
      renderGrades();
    });
  });

  mainEl.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("점수 기록을 삭제할까요?")) return;
      delete state.studentScores[btn.dataset.del];
      scheduleSave();
      renderGrades();
    });
  });
}

/* QR */
async function loadQr() {
  const res = await fetch("/api/grading/student-url", { credentials: "include" });
  const data = await res.json();
  studentUrl = data.examUrl || data.url || "";
  qrDataUrl = data.dataUrl || "";
  document.getElementById("qrUrlText").textContent = studentUrl;
  const img = document.getElementById("qrImage");
  if (qrDataUrl) img.src = qrDataUrl;
}

document.getElementById("qrOpenBtn").addEventListener("click", async () => {
  await loadQr();
  document.getElementById("qrModal").classList.remove("hidden");
});

document.querySelector('[data-close="qrModal"]').addEventListener("click", () => {
  document.getElementById("qrModal").classList.add("hidden");
});

document.getElementById("qrCopyBtn").addEventListener("click", async () => {
  await loadQr();
  try {
    await navigator.clipboard.writeText(studentUrl);
    alert("주소를 복사했습니다.");
  } catch (_) {
    prompt("아래 주소를 복사하세요", studentUrl);
  }
});

document.getElementById("qrSaveBtn").addEventListener("click", async () => {
  await loadQr();
  if (!qrDataUrl) return;
  const a = document.createElement("a");
  a.href = qrDataUrl;
  a.download = "student-exam-qr.png";
  a.click();
});

document.getElementById("addExamBtn").addEventListener("click", () => {
  const name = prompt("시험 이름");
  if (!name?.trim()) return;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  state.exams.push({
    id,
    name: name.trim(),
    active: true,
    subjects: [],
  });
  state.activeExamId = id;
  scheduleSave();
  renderSidebar();
});

document.getElementById("addClassBtn").addEventListener("click", () => {
  const name = prompt("학반 이름 (예: 5-3반)");
  if (!name?.trim()) return;
  const count = Number(prompt("학생 수", "20")) || 20;
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  state.classes.push({ id, name: name.trim(), studentCount: count, selected: false });
  if (!state.activeClassId) state.activeClassId = id;
  scheduleSave();
  renderSidebar();
});

document.getElementById("gradingLogout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
  window.top.location.href = "/login";
});

/* 과목 클릭 시 시험 설정으로 */
subjectList.addEventListener("click", (e) => {
  if (e.target.closest("[data-action]")) return;
  setView("exam");
});

loadData();
