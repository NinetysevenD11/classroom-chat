/** 선생님 채점도구 — 동작 중심 (iframe에서 prompt 사용 안 함) */

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
const aiOverlay = document.getElementById("aiOverlay");
const aiOverlayText = document.getElementById("aiOverlayText");
const dialogEl = document.getElementById("gradingDialog");
const dialogTitle = document.getElementById("dialogTitle");
const dialogBody = document.getElementById("dialogBody");
const dialogConfirm = document.getElementById("dialogConfirm");
const toastEl = document.getElementById("toast");

const CHECKLIST = [
  { id: "exam", title: "시험(과목) 추가", desc: "왼쪽 「+ 새 시험(과목) 추가」로 과목을 만든 뒤 정답을 입력하세요.", view: "exam", badge: "warn" },
  { id: "class", title: "학반 추가", desc: "학반을 만들거나, 칠판의 「우리반 학생」 명단을 사용합니다.", view: "home", badge: "warn" },
  { id: "subject", title: "단원·문항 설정", desc: "과목을 선택한 뒤 단원 탭에서 문항과 정답을 설정합니다.", view: "exam", badge: "warn" },
  { id: "answer", title: "정답 설정", desc: "객관식·단답형·서술형 정답과 배점을 입력합니다.", view: "exam", badge: "warn" },
  { id: "lock", title: "학생화면 과목 잠금", desc: "잠금 해제한 단원만 학생 /exam 에서 응시할 수 있습니다.", view: "home", badge: "pick" },
  { id: "qr", title: "학생 QR 접속", desc: "왼쪽에 QR이 항상 표시됩니다. 학생은 스캔 후 이름·번호로 입장합니다.", view: "home", badge: "pick" },
  { id: "live", title: "실시간 현황 확인", desc: "제출 상태와 점수를 실시간으로 확인합니다.", view: "grades", badge: "pick" },
  { id: "print", title: "성적표 인쇄", desc: "개별·일괄 성적표를 인쇄합니다.", view: "grades", badge: "pick" },
];

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return String(Date.now()) + Math.random().toString(16).slice(2, 8);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("is-error", !!isError);
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

function normalizeState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  if (!Array.isArray(s.exams) || !s.exams.length) {
    const examId = newId();
    s.exams = [{ id: examId, name: "기본 평가", active: true, subjects: [] }];
    s.activeExamId = examId;
  }
  if (!Array.isArray(s.classes)) s.classes = [];
  if (!s.studentScores || typeof s.studentScores !== "object") s.studentScores = {};
  if (!s.settings || typeof s.settings !== "object") {
    s.settings = { aiProvider: "gemini", hasApiKey: false };
  }
  for (const exam of s.exams) {
    if (!Array.isArray(exam.subjects)) exam.subjects = [];
    for (const sub of exam.subjects) {
      if (!Array.isArray(sub.units)) sub.units = [];
      if (typeof sub.active !== "boolean") sub.active = true;
      for (const unit of sub.units) {
        if (!Array.isArray(unit.questions)) unit.questions = [];
        if (typeof unit.locked !== "boolean") unit.locked = true;
        if (!Array.isArray(unit.images)) unit.images = [];
      }
    }
  }
  if (!s.activeExamId) s.activeExamId = s.exams[0].id;
  const exam = s.exams.find((e) => e.id === s.activeExamId) || s.exams[0];
  s.activeExamId = exam.id;
  if (s.activeSubjectId && !exam.subjects.some((x) => x.id === s.activeSubjectId)) {
    s.activeSubjectId = exam.subjects[0]?.id || null;
    s.activeUnitId = exam.subjects[0]?.units?.[0]?.id || null;
  }
  if (!s.activeSubjectId && exam.subjects[0]) {
    s.activeSubjectId = exam.subjects[0].id;
    s.activeUnitId = exam.subjects[0].units?.[0]?.id || null;
  }
  // 예전 다중 평가 세트 → 한 세트로 합침
  if (s.exams.length > 1) {
    const main = s.exams[0];
    for (let i = 1; i < s.exams.length; i++) {
      main.subjects.push(...(s.exams[i].subjects || []));
    }
    s.exams = [main];
    s.activeExamId = main.id;
  }
  return s;
}

function getAllUnits() {
  const units = [];
  for (const exam of state?.exams || []) {
    for (const sub of exam.subjects || []) {
      if (sub.active === false) continue;
      for (const u of sub.units || []) {
        units.push({ ...u, subjectName: sub.name, subjectId: sub.id, colLabel: `${sub.name}_${u.name}` });
      }
    }
  }
  return units;
}

/** 시험 관리에 등록된 활성 과목 목록 */
function getExamSubjects() {
  const exam = activeExam();
  return (exam?.subjects || []).filter((s) => s.active !== false);
}

function getUnitsForSubject(subjectId) {
  const exam = activeExam();
  const sub = exam?.subjects?.find((s) => s.id === subjectId);
  if (!sub || sub.active === false) return [];
  return (sub.units || []).map((u) => ({
    ...u,
    subjectName: sub.name,
    subjectId: sub.id,
    colLabel: `${sub.name}_${u.name}`,
  }));
}

/** 성적표에서 보고 있는 과목 (시험 관리 과목과 동일) */
let gradesSubjectId = null;

function getGradesSubject() {
  const subjects = getExamSubjects();
  if (!subjects.length) return null;
  if (gradesSubjectId && subjects.some((s) => s.id === gradesSubjectId)) {
    return subjects.find((s) => s.id === gradesSubjectId);
  }
  const fromActive = subjects.find((s) => s.id === state.activeSubjectId);
  return fromActive || subjects[0];
}

function showAiOverlay(msg) {
  aiOverlayText.textContent = msg || "AI가 시험지를 분석하는 중…";
  aiOverlay.classList.remove("hidden");
}

function hideAiOverlay() {
  aiOverlay.classList.add("hidden");
}

async function pdfFileToDataUrls(file, maxPages = 8) {
  if (!window.pdfjsLib) throw new Error("PDF 라이브러리를 불러오지 못했습니다.");
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const urls = [];
  const total = Math.min(pdf.numPages, maxPages);
  for (let p = 1; p <= total; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    urls.push(canvas.toDataURL("image/jpeg", 0.88));
  }
  return urls;
}

async function fileToScanPayload(file) {
  if (file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf")) {
    const pages = await pdfFileToDataUrls(file);
    return pages.map((dataUrl, i) => ({ dataUrl, name: `${file.name}-p${i + 1}` }));
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return [{ dataUrl, name: file.name }];
}

async function runAiScan(unit) {
  if (!apiKeyMeta.canScan) {
    showToast("사이드바 하단에서 AI API 키를 먼저 저장해 주세요.", true);
    document.querySelector(".sb-api-footer")?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  const files = (unit.images || []).map((dataUrl, i) => ({ dataUrl, name: `page-${i + 1}` }));
  if (!files.length) {
    showToast("먼저 시험지 이미지 또는 PDF를 올려 주세요.", true);
    return;
  }
  showAiOverlay("AI가 문항과 정답을 추출하는 중… (30초~1분)");
  try {
    const res = await fetch("/api/grading/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ unitId: unit.id, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI 분석 실패");
    unit.questions = data.questions || unit.questions;
    await saveNow();
    renderExam();
    showToast(`${data.count || unit.questions.length}문항 자동 생성 완료`);
  } catch (err) {
    showToast(err.message || "AI 분석 실패", true);
  } finally {
    hideAiOverlay();
  }
}

function activeExam() {
  return state.exams?.find((e) => e.id === state.activeExamId) || state.exams?.[0];
}

function activeSubject() {
  const exam = activeExam();
  if (!exam) return null;
  return exam.subjects?.find((s) => s.id === state.activeSubjectId) || exam.subjects?.[0] || null;
}

function activeUnit() {
  const sub = activeSubject();
  if (!sub) return null;
  return sub.units?.find((u) => u.id === state.activeUnitId) || sub.units?.[0] || null;
}

function activeClass() {
  return state?.classes?.find((c) => c.id === state.activeClassId) || null;
}

/** 서술형 수동채점 모달 세션 */
let manualGradeSession = null;

function createQuestion(num) {
  return { id: newId(), num, type: "mc", answer: "", points: "1", rubric: "" };
}

function createUnit(name) {
  const questions = [];
  for (let i = 1; i <= 5; i++) questions.push(createQuestion(i));
  return { id: newId(), name, locked: true, images: [], questions };
}

function createSubject(name) {
  const unitName = `${name}_1단원`;
  return {
    id: newId(),
    name: name.trim(),
    active: true,
    units: [createUnit(unitName)],
  };
}

async function saveNow() {
  try {
    const res = await fetch("/api/grading", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(state),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "저장 실패");
    return true;
  } catch (err) {
    console.error("[채점] 저장 실패", err);
    showToast(err.message || "저장하지 못했습니다.", true);
    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 400);
}

let dialogOnConfirm = null;

function closeDialog() {
  dialogEl.classList.add("hidden");
  dialogOnConfirm = null;
  dialogBody.innerHTML = "";
}

function openDialog({ title, fields, message, confirmText, onConfirm }) {
  dialogTitle.textContent = title;
  dialogConfirm.textContent = confirmText || "확인";
  let html = "";
  if (message) html += `<p class="g-dialog-msg">${escapeHtml(message)}</p>`;
  for (const f of fields || []) {
    html += `<label class="g-field"><span>${escapeHtml(f.label)}</span>`;
    if (f.type === "number") {
      html += `<input type="number" data-field="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? "")}" min="${f.min ?? 1}" max="${f.max ?? 99}" />`;
    } else {
      html += `<input type="text" data-field="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? "")}" placeholder="${escapeHtml(f.placeholder || "")}" maxlength="${f.maxlength || 40}" />`;
    }
    html += `</label>`;
  }
  dialogBody.innerHTML = html;
  dialogOnConfirm = onConfirm;
  dialogEl.classList.remove("hidden");
  const first = dialogBody.querySelector("input");
  if (first) {
    first.focus();
    first.select();
  }
}

dialogEl.querySelectorAll("[data-close-dialog]").forEach((el) => {
  el.addEventListener("click", closeDialog);
});

dialogConfirm.addEventListener("click", async () => {
  if (!dialogOnConfirm) return closeDialog();
  const inputs = {};
  dialogBody.querySelectorAll("[data-field]").forEach((inp) => {
    inputs[inp.dataset.field] = inp.value;
  });
  const ok = await dialogOnConfirm(inputs);
  if (ok !== false) closeDialog();
});

function confirmDialog(title, message, onConfirm) {
  openDialog({
    title,
    message,
    confirmText: "확인",
    fields: [],
    onConfirm: async () => {
      await onConfirm();
      return true;
    },
  });
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
  state = normalizeState(await gradingRes.json());
  roster = (await rosterRes.json()).roster || {};
  const me = await meRes.json();
  onlineSeats = (await onlineRes.json()).online || {};
  document.getElementById("profileEmail").textContent = me.userId ? `${me.userId}` : "—";
  document.getElementById("profileName").textContent = me.displayName || me.userId || "선생님";
  document.getElementById("profileSchool").textContent = me.school || "우리반";
  renderSidebar();
  bindMainNav();
  renderView(currentView);
  loadQrInline(); /* 주소·QR 미리 받아 두기 (화면은 접힌 상태) */
  loadApiKeyPanel();
}

const AI_PROVIDER_LABELS = { openai: "OpenAI", gemini: "Gemini", claude: "Claude", grok: "Grok" };
const AI_KEY_PLACEHOLDERS = {
  openai: "sk-...",
  gemini: "AIza...",
  claude: "sk-ant-...",
  grok: "xai-...",
};

let apiKeyMeta = { canScan: false, envKeys: {} };

function selectedAiProvider() {
  return document.getElementById("aiProviderSelect")?.value || "gemini";
}

function updateApiKeyInputPlaceholder(provider) {
  const input = document.getElementById("apiKeyInput");
  if (input) input.placeholder = AI_KEY_PLACEHOLDERS[provider] || "API 키 입력";
}

async function loadApiKeyPanel() {
  try {
    const res = await fetch("/api/grading/api-key", { credentials: "include" });
    const data = await res.json();
    if (!res.ok) return;
    apiKeyMeta = data;
    const s = data.settings || {};
    const providerEl = document.getElementById("aiProviderSelect");
    if (providerEl && s.aiProvider) providerEl.value = s.aiProvider;
    updateApiKeyInputPlaceholder(s.aiProvider || selectedAiProvider());
    updateApiKeyStatusUI(s);
    const hint = document.getElementById("apiKeyHint");
    if (hint) {
      const label = AI_PROVIDER_LABELS[s.aiProvider] || s.aiProvider;
      if (data.canScan) {
        hint.textContent = s.hasApiKey
          ? `저장된 ${label} 키로 시험지 AI 분석이 가능합니다.`
          : "서버 기본 키로 분석합니다.";
      } else {
        hint.textContent = "키를 저장해야 시험지 AI 정답 생성을 사용할 수 있습니다.";
      }
    }
  } catch (_) {}
}

function updateApiKeyStatusUI(s) {
  const el = document.getElementById("apiKeyStatus");
  if (!el) return;
  const provider = s.aiProvider || selectedAiProvider();
  const label = AI_PROVIDER_LABELS[provider] || provider;
  const registered = s.keysRegistered?.[provider];
  if (s.hasApiKey) {
    el.textContent = `${label} 저장됨: ${s.apiKeyHint}`;
    el.classList.add("is-on");
  } else if (registered) {
    el.textContent = `${label} 키 저장됨 (다른 AI 선택 중)`;
    el.classList.add("is-on");
  } else {
    el.textContent = `${label} 미등록`;
    el.classList.remove("is-on");
  }
}

async function saveApiKeys() {
  const apiKey = document.getElementById("apiKeyInput")?.value?.trim() || "";
  const aiProvider = selectedAiProvider();
  if (!apiKey) {
    showToast("API 키를 입력하세요.", true);
    return;
  }
  const res = await fetch("/api/grading/api-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiKey, aiProvider }),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || "저장 실패", true);
    return;
  }
  document.getElementById("apiKeyInput").value = "";
  if (state) state.settings = data.settings;
  apiKeyMeta.canScan = data.canScan;
  updateApiKeyStatusUI(data.settings);
  loadApiKeyPanel();
  showToast("API 키가 저장되었습니다.");
}

async function saveAiProviderOnly() {
  const aiProvider = selectedAiProvider();
  const res = await fetch("/api/grading/api-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ aiProvider }),
  });
  const data = await res.json();
  if (!res.ok) return;
  if (state) state.settings = data.settings;
  apiKeyMeta.canScan = data.canScan;
  updateApiKeyInputPlaceholder(aiProvider);
  updateApiKeyStatusUI(data.settings);
  const hint = document.getElementById("apiKeyHint");
  if (hint && data.canScan) {
    const label = AI_PROVIDER_LABELS[aiProvider] || aiProvider;
    hint.textContent = data.settings?.hasApiKey
      ? `저장된 ${label} 키로 시험지 AI 분석이 가능합니다.`
      : "서버 기본 키로 분석합니다.";
  }
}

function clearApiKeys() {
  confirmDialog("API 키 삭제", "저장된 모든 AI API 키를 삭제할까요?", async () => {
    const res = await fetch("/api/grading/api-key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ clearAll: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "삭제 실패", true);
      return;
    }
    if (state) state.settings = data.settings;
    apiKeyMeta.canScan = data.canScan;
    updateApiKeyStatusUI(data.settings);
    loadApiKeyPanel();
    showToast("내 API 키를 삭제했습니다.");
  });
}

function renderSidebar() {
  const exam = activeExam();
  subjectList.innerHTML = "";

  if (!exam.subjects?.length) {
    subjectList.innerHTML = `<li class="sb-empty">등록된 과목이 없습니다.<br>아래 버튼으로 추가하세요.</li>`;
  } else {
    for (const sub of exam.subjects) {
      const li = document.createElement("li");
      li.className = "sb-item" + (sub.id === state.activeSubjectId ? " is-active" : "");
      li.innerHTML = `
        <button type="button" class="dot-btn dot ${sub.active ? "on" : "off"}" title="활성/비활성 전환"></button>
        <span class="label">${escapeHtml(sub.name)}</span>
        <button type="button" class="icon-btn" data-action="edit-sub" title="이름 수정">✎</button>
        <button type="button" class="icon-btn" data-action="del-sub" title="삭제">✕</button>
      `;
      li.querySelector(".dot-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        sub.active = !sub.active;
        scheduleSave();
        renderSidebar();
        showToast(sub.active ? `${sub.name} 활성화` : `${sub.name} 비활성화`);
      });
      li.querySelector(".label").addEventListener("click", () => selectSubject(sub));
      li.querySelector('[data-action="edit-sub"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openDialog({
          title: "과목 이름 수정",
          fields: [{ name: "name", label: "이름", value: sub.name }],
          onConfirm: async (v) => {
            if (!v.name?.trim()) {
              showToast("이름을 입력하세요.", true);
              return false;
            }
            sub.name = v.name.trim();
            await saveNow();
            renderSidebar();
            if (currentView === "exam") renderView("exam");
            return true;
          },
        });
      });
      li.querySelector('[data-action="del-sub"]').addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDialog("과목 삭제", `"${sub.name}" 과목과 단원·정답을 모두 삭제할까요?`, async () => {
          exam.subjects = exam.subjects.filter((s) => s.id !== sub.id);
          if (state.activeSubjectId === sub.id) {
            state.activeSubjectId = exam.subjects[0]?.id || null;
            state.activeUnitId = exam.subjects[0]?.units?.[0]?.id || null;
          }
          await saveNow();
          renderSidebar();
          renderView(currentView);
        });
      });
      subjectList.appendChild(li);
    }
  }

  classList.innerHTML = "";
  if (!state.classes?.length) {
    classList.innerHTML = `<li class="sb-empty">학반이 없습니다.</li>`;
  } else {
    for (const cls of state.classes) {
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
        if (currentView === "grades" || currentView === "trend") renderView(currentView);
      });
      li.querySelector('[data-action="del-class"]').addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDialog("학반 삭제", `"${cls.name}" 을 삭제할까요?`, async () => {
          state.classes = state.classes.filter((c) => c.id !== cls.id);
          if (state.activeClassId === cls.id) state.activeClassId = state.classes[0]?.id || null;
          await saveNow();
          renderSidebar();
        });
      });
      classList.appendChild(li);
    }
  }

  renderLockList();
}

function selectSubject(sub) {
  state.activeSubjectId = sub.id;
  state.activeUnitId = sub.units?.[0]?.id || null;
  gradesSubjectId = sub.id;
  scheduleSave();
  renderSidebar();
  if (currentView === "grades" || currentView === "trend") renderView(currentView);
  else setView("exam");
}

function syncLockRowUi(li, unit) {
  const lockBtn = li.querySelector('[data-lock="1"]');
  const openBtn = li.querySelector('[data-lock="0"]');
  if (lockBtn) lockBtn.classList.toggle("locked", !!unit.locked);
  if (openBtn) openBtn.classList.toggle("open", !unit.locked);
}

function renderLockList() {
  lockList.innerHTML = "";
  const sub = activeSubject();
  if (!sub?.units?.length) {
    lockList.innerHTML = `<li class="sb-empty">과목·단원을 먼저 추가하세요.</li>`;
    return;
  }
  for (const unit of sub.units) {
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
      if (unit.locked) return;
      unit.locked = true;
      syncLockRowUi(li, unit);
      scheduleSave();
      showToast("학생 화면에서 숨깁니다.");
    });
    li.querySelector('[data-lock="0"]').addEventListener("click", () => {
      if (!unit.locked) return;
      unit.locked = false;
      syncLockRowUi(li, unit);
      scheduleSave();
      showToast("학생이 응시할 수 있습니다.");
    });
    lockList.appendChild(li);
  }
}

function updateChecklistBadges() {
  const exam = activeExam();
  const unit = activeUnit();
  CHECKLIST[0].badge = (exam?.subjects?.length || 0) > 0 ? "done" : "warn";
  CHECKLIST[1].badge = (state.classes?.length || 0) > 0 || Object.keys(roster).length > 0 ? "done" : "warn";
  CHECKLIST[2].badge = (activeSubject()?.units?.length || 0) > 0 ? "done" : "warn";
  CHECKLIST[3].badge = unit?.questions?.some((q) => q.answer) ? "done" : "warn";
}

function refreshGradesOrTrendView() {
  if (currentView === "grades") renderGrades();
  else if (currentView === "trend") renderTrend();
}

function setView(view) {
  currentView = view;
  if ((view === "grades" || view === "trend") && !gradesSubjectId && state.activeSubjectId) {
    gradesSubjectId = state.activeSubjectId;
  }
  if (view !== "trend" && view !== "grades") destroyTrendCharts();
  bindMainNav();
  renderView(view);
}

function renderView(view) {
  if (!state) {
    if (mainEl) {
      mainEl.innerHTML = `<div class="view-home"><p class="muted">데이터를 불러오는 중…</p></div>`;
    }
    return;
  }
  updateChecklistBadges();
  try {
    if (view === "home") renderHome();
    else if (view === "exam") renderExam();
    else if (view === "grades") renderGrades();
    else if (view === "trend") renderTrend();
  } catch (err) {
    console.error("[채점] 화면 렌더 오류", err);
    if (mainEl) {
      mainEl.innerHTML = `<div class="view-home"><p class="error-inline">화면을 표시하지 못했습니다. 새로고침해 주세요.<br><small>${escapeHtml(err.message)}</small></p></div>`;
    }
  }
}

function buildDashboardStats() {
  const subjects = getExamSubjects();
  let units = 0;
  let questions = 0;
  for (const s of subjects) {
    for (const u of s.units || []) {
      units += 1;
      questions += (u.questions || []).length;
    }
  }
  const students = getStudentsForGrades();
  let submissions = 0;
  for (const key of Object.keys(state.studentScores || {})) {
    if (key.startsWith("_")) continue;
    if (state.studentScores[key]?._submittedAt) submissions += 1;
  }
  const setupDone = CHECKLIST.filter((c) => c.badge === "done").length;
  return {
    subjects: subjects.length,
    units,
    questions,
    students: students.length,
    submissions,
    pending: countPendingReviews(),
    published: !!state.resultsPublished,
    setupDone,
    setupTotal: CHECKLIST.length,
  };
}

function formatLogTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function trendLogItemHtml(log, opts = {}) {
  const compact = !!opts.compact;
  const a = log.analysis || {};
  const summary = String(a.trendSummary || "").slice(0, compact ? 120 : 500);
  const name = log.studentName || log.studentKey?.split(":")[1] || "학생";
  const seat = log.studentSeat ?? log.studentKey?.split(":")[0] ?? "";
  return `
    <article class="trend-log-item" data-log-id="${escapeHtml(log.id)}">
      <header class="trend-log-head">
        <span class="trend-log-student">${escapeHtml(seat)}번 ${escapeHtml(name)}</span>
        <time class="trend-log-time">${formatLogTime(log.createdAt)}</time>
      </header>
      <p class="trend-log-meta">${escapeHtml(log.subjectSummary || "")}${log.aiProvider ? ` · ${escapeHtml(log.aiProvider)}` : ""}</p>
      <p class="trend-log-summary">${escapeHtml(summary)}${summary.length < String(a.trendSummary || "").length ? "…" : ""}</p>
      <button type="button" class="btn btn-ghost btn-sm trend-log-expand">${compact ? "보기" : "전체 보기"}</button>
    </article>`;
}

async function fetchTrendAnalysisLogs(studentKey, limit = 30) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (studentKey) q.set("studentKey", studentKey);
  const res = await fetch(`/api/grading/trend-analysis-logs?${q}`, { credentials: "include" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "기록을 불러오지 못했습니다.");
  return data.logs || [];
}

function renderTrendLogList(logs, containerId = "trendLogList") {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!logs.length) {
    el.innerHTML = `<p class="trend-log-empty">아직 저장된 AI 학습 분석 기록이 없습니다. 「AI 학습 분석」을 실행하면 여기에 쌓입니다.</p>`;
    return;
  }
  el.innerHTML = logs.map((log) => trendLogItemHtml(log, { compact: true })).join("");
  el.querySelectorAll(".trend-log-expand").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".trend-log-item");
      const id = item?.dataset.logId;
      const log = logs.find((l) => l.id === id);
      if (!log) return;
      if (currentView === "home") {
        trendSelectedStudentKey = log.studentKey;
        setView("trend");
        return;
      }
      if (log.analysis) {
        trendAnalysisCache[log.studentKey] = log.analysis;
        renderTrendAnalysisPanel(log.analysis);
        showToast("선택한 기록의 분석을 표시합니다.");
      }
    });
  });
}

async function renderHome() {
  updateChecklistBadges();
  const stats = buildDashboardStats();
  const teacherName = document.getElementById("profileName")?.textContent || "선생님";
  const cls = activeClass();
  const setupPct = stats.setupTotal ? Math.round((stats.setupDone / stats.setupTotal) * 100) : 0;

  const setupSteps = CHECKLIST.map((c) => {
    const badgeClass = c.badge === "done" ? "done" : c.badge === "warn" ? "warn" : "pick";
    return `
      <li class="dash-setup-item ${badgeClass}">
        <span class="dash-setup-dot"></span>
        <div>
          <strong>${escapeHtml(c.title)}</strong>
          <p>${escapeHtml(c.desc)}</p>
        </div>
        <button type="button" class="btn-dash-link" data-goto="${c.view}" data-id="${c.id}">이동</button>
      </li>`;
  }).join("");

  mainEl.innerHTML = `
    <div class="view-home dash-home">
      <header class="dash-hero">
        <p class="dash-greeting">안녕하세요, <strong>${escapeHtml(teacherName)}</strong>님</p>
        <h1>교실 도구함 · 채점도구</h1>
        <p class="dash-mission">
          시험지를 올리면 AI가 문항·정답을 잡아 주고, 학생은 QR로 태블릿 시험에 응시합니다.
          제출 즉시 자동 채점되며, 서술형은 선생님이 확정합니다. 성적은 실시간으로 모이고,
          추이 그래프와 AI 학습 분석으로 학생별 강·약점을 파악할 수 있습니다.
        </p>
        <div class="dash-hero-tags">
          <span class="badge-space">${escapeHtml(cls?.name || "우리반")}</span>
          <span class="dash-tag ${stats.published ? "is-on" : ""}">${stats.published ? "성적 공개 중" : "성적 비공개"}</span>
          ${stats.pending > 0 ? `<span class="dash-tag warn">서술형 채점 대기 ${stats.pending}건</span>` : ""}
        </div>
      </header>

      <section class="dash-stats" aria-label="현황 요약">
        <article class="dash-stat-card">
          <span class="dash-stat-icon">📚</span>
          <div><strong>${stats.subjects}</strong><span>과목</span></div>
        </article>
        <article class="dash-stat-card">
          <span class="dash-stat-icon">📑</span>
          <div><strong>${stats.units}</strong><span>단원</span></div>
        </article>
        <article class="dash-stat-card">
          <span class="dash-stat-icon">✏️</span>
          <div><strong>${stats.questions}</strong><span>문항</span></div>
        </article>
        <article class="dash-stat-card">
          <span class="dash-stat-icon">👥</span>
          <div><strong>${stats.students}</strong><span>학생</span></div>
        </article>
        <article class="dash-stat-card">
          <span class="dash-stat-icon">📤</span>
          <div><strong>${stats.submissions}</strong><span>제출</span></div>
        </article>
        <article class="dash-stat-card highlight">
          <span class="dash-stat-icon">⏳</span>
          <div><strong>${stats.pending}</strong><span>채점 대기</span></div>
        </article>
      </section>

      <section class="dash-actions" aria-label="빠른 이동">
        <h2 class="dash-section-title">빠른 이동</h2>
        <div class="dash-action-grid">
          <button type="button" class="dash-action-card" data-view="exam">
            <span class="dash-action-icon">📝</span>
            <strong>시험·정답</strong>
            <p>과목·단원·문항·AI 시험지 스캔</p>
          </button>
          <button type="button" class="dash-action-card" data-view="grades">
            <span class="dash-action-icon">📊</span>
            <strong>실시간 성적</strong>
            <p>제출·점수·결과 공개·인쇄</p>
          </button>
          <button type="button" class="dash-action-card" data-view="trend">
            <span class="dash-action-icon">📈</span>
            <strong>성적 변화 추이</strong>
            <p>그래프·AI 학습 분석 기록</p>
          </button>
          <button type="button" class="dash-action-card" data-action="qr">
            <span class="dash-action-icon">📱</span>
            <strong>학생 QR</strong>
            <p>왼쪽 사이드바 QR·주소 복사</p>
          </button>
        </div>
      </section>

      <div class="dash-columns">
        <section class="dash-panel" aria-label="시작 체크리스트">
          <div class="dash-panel-head">
            <h2 class="dash-section-title">시작 가이드</h2>
            <span class="dash-progress-label">${setupPct}%</span>
          </div>
          <div class="dash-progress-bar"><span style="width:${setupPct}%"></span></div>
          <ol class="dash-setup-list">${setupSteps}</ol>
        </section>
        <section class="dash-panel" aria-label="최근 AI 분석 기록">
          <h2 class="dash-section-title">최근 AI 학습 분석</h2>
          <div id="dashRecentLogs" class="trend-log-list compact"><p class="muted">불러오는 중…</p></div>
        </section>
      </div>
    </div>
  `;

  mainEl.querySelectorAll(".dash-action-card[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });
  mainEl.querySelector("[data-action='qr']")?.addEventListener("click", () => {
    document.querySelector(".sb-qr-block")?.scrollIntoView({ behavior: "smooth" });
  });
  mainEl.querySelectorAll(".btn-dash-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.id === "qr") {
        document.querySelector(".sb-qr-block")?.scrollIntoView({ behavior: "smooth" });
        return;
      }
      setView(btn.dataset.goto);
    });
  });

  try {
    const logs = await fetchTrendAnalysisLogs(null, 5);
    renderTrendLogList(logs, "dashRecentLogs");
  } catch (_) {
    const el = document.getElementById("dashRecentLogs");
    if (el) el.innerHTML = `<p class="trend-log-empty">기록을 불러오지 못했습니다.</p>`;
  }
}

function renderExam() {
  const sub = activeSubject();
  const unit = activeUnit();
  if (!sub) {
    mainEl.innerHTML = `
      <div class="view-exam empty-main">
        <h1>과목을 추가해 주세요</h1>
        <p>왼쪽 「+ 새 시험(과목) 추가」를 눌러 수학, 국어 등 과목을 만드세요.</p>
        <button type="button" class="btn btn-purple" id="emptyAddSubject">+ 새 시험(과목) 추가</button>
      </div>`;
    document.getElementById("emptyAddSubject")?.addEventListener("click", () => addSubjectFlow());
    return;
  }
  if (!unit) {
    mainEl.innerHTML = `<div class="view-exam empty-main"><p>단원이 없습니다. 아래에서 단원을 추가하세요.</p></div>`;
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
          ? `<div class="q-essay-extra"><button type="button" class="link-btn" data-rubric="${idx}">+ 채점기준 추가</button></div>
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
        </div>`;
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
        <button type="button" class="btn btn-green" id="addSubjectMainBtn">+ 과목 추가</button>
      </div>
      <div class="guide-box is-open">
        <div class="guide-steps" style="display:grid">
          <div class="guide-step"><b>1</b>과목·단원 추가</div>
          <div class="guide-step"><b>2</b>정답 입력</div>
          <div class="guide-step"><b>3</b>잠금 해제 후 학생 응시</div>
        </div>
      </div>
      <div class="unit-tabs">${tabs}
        <button type="button" class="unit-tab" id="addUnitBtn" style="border-style:dashed">+ 단원</button>
      </div>
      <section class="paper-section">
        <div class="section-head">
          <h2>시험지 등록 · AI 정답 생성</h2>
          <div class="paper-actions">
            <input type="file" id="paperInput" accept="image/*,application/pdf" multiple hidden />
            <button type="button" class="btn btn-blue" id="paperSelectBtn">이미지/PDF 올리기</button>
            <button type="button" class="btn btn-ai" id="aiScanBtn">🤖 AI 정답 자동 생성</button>
            <span class="paper-status">${(unit.images || []).length}장</span>
          </div>
        </div>
        <p class="paper-hint">시험지를 올리면 AI가 정답을 채웁니다. 키는 왼쪽 하단 「내 AI API 키」에 저장하세요.</p>
        <div class="paper-thumbs" id="paperThumbs">${thumbs || '<span class="muted">이미지 없음</span>'}</div>
      </section>
      <section class="answers-section">
        <h2>${escapeHtml(unit.name)} · ${(unit.questions || []).length}문항</h2>
        <div class="questions-grid" id="questionsGrid">${qCards}</div>
        <button type="button" class="btn-add-q" id="addQuestionBtn">+ 문항 1개 추가</button>
      </section>
    </div>`;

  document.getElementById("addSubjectMainBtn")?.addEventListener("click", addSubjectFlow);
  document.getElementById("addUnitBtn")?.addEventListener("click", () => {
    openDialog({
      title: "단원 추가",
      fields: [{ name: "name", label: "단원 이름", placeholder: "예: 3단원_대응관계" }],
      onConfirm: async (v) => {
        if (!v.name?.trim()) {
          showToast("단원 이름을 입력하세요.", true);
          return false;
        }
        const id = newId();
        sub.units.push(createUnit(v.name.trim()));
        state.activeUnitId = sub.units[sub.units.length - 1].id;
        await saveNow();
        renderSidebar();
        renderExam();
        showToast("단원이 추가되었습니다.");
        return true;
      },
    });
  });

  mainEl.querySelectorAll(".unit-tab[data-unit]").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeUnitId = tab.dataset.unit;
      scheduleSave();
      renderExam();
      renderLockList();
    });
  });

  document.getElementById("aiScanBtn")?.addEventListener("click", () => runAiScan(unit));
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
    card.querySelector("[data-rubric]")?.addEventListener("click", () => {
      openDialog({
        title: `${q.num}번 채점 기준`,
        fields: [{ name: "rubric", label: "기준", value: q.rubric || "" }],
        onConfirm: async (v) => {
          q.rubric = v.rubric || "";
          await saveNow();
          return true;
        },
      });
    });
    card.querySelector("[data-manual]")?.addEventListener("click", () => {
      if (q.type !== "essay") {
        showToast("서술형 문항만 수동 채점할 수 있습니다.", true);
        return;
      }
      openManualGradeModal(q, unit, sub);
    });
  });
  document.getElementById("addQuestionBtn")?.addEventListener("click", () => {
    const n = unit.questions.length + 1;
    unit.questions.push(createQuestion(n));
    scheduleSave();
    renderExam();
  });
}

function bindPaperUpload(unit) {
  const input = document.getElementById("paperInput");
  document.getElementById("paperSelectBtn")?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    unit.images = unit.images || [];
    showAiOverlay("시험지 파일 처리 중…");
    try {
      for (const file of files) {
        const payloads = await fileToScanPayload(file);
        for (const p of payloads) {
          if (p.dataUrl.length < 4_000_000) unit.images.push(p.dataUrl);
          else showToast(`${file.name} 용량이 너무 큽니다.`, true);
        }
      }
      await saveNow();
      renderExam();
      await runAiScan(unit);
    } catch (err) {
      showToast(err.message || "파일 처리 실패", true);
    } finally {
      hideAiOverlay();
      input.value = "";
    }
  });
  document.getElementById("paperThumbs")?.querySelectorAll("[data-rm-img]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      unit.images.splice(Number(btn.dataset.rmImg), 1);
      await saveNow();
      renderExam();
    });
  });
}

function addSubjectFlow() {
  openDialog({
    title: "새 시험(과목) 추가",
    fields: [{ name: "name", label: "과목 이름", placeholder: "예: 수학, 국어", value: "" }],
    onConfirm: async (v) => {
      const name = v.name?.trim();
      if (!name) {
        showToast("과목 이름을 입력하세요.", true);
        return false;
      }
      const exam = activeExam();
      const sub = createSubject(name);
      exam.subjects.push(sub);
      state.activeSubjectId = sub.id;
      state.activeUnitId = sub.units[0].id;
      const ok = await saveNow();
      if (!ok) return false;
      renderSidebar();
      setView("exam");
      showToast(`「${name}」 과목이 추가되었습니다.`);
      return true;
    },
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

/** 명단 + 제출만 한 학생(점수 기록 키) */
function getStudentsForGrades() {
  const map = new Map();
  for (const st of getRosterStudents()) {
    map.set(`${st.seat}:${st.name}`, st);
  }
  for (const key of Object.keys(state.studentScores || {})) {
    if (key.startsWith("_") || !key.includes(":")) continue;
    if (map.has(key)) continue;
    const colon = key.indexOf(":");
    const seat = Number(key.slice(0, colon));
    const name = key.slice(colon + 1);
    if (name) map.set(key, { seat: Number.isFinite(seat) ? seat : 0, name });
  }
  return [...map.values()].sort((a, b) => a.seat - b.seat);
}

function countPendingReviews() {
  let n = 0;
  for (const rec of Object.values(state.studentScores || {})) {
    const detail = rec._detail || {};
    for (const sub of Object.values(detail)) {
      if (sub && sub.finalized === false) n += 1;
    }
  }
  return n;
}

function scoreFor(studentKey, unitId) {
  const v = state.studentScores?.[studentKey]?.[unitId];
  return v === undefined || v === null ? "—" : v;
}

function scoreCellHtml(studentKey, unitId) {
  const rec = state.studentScores?.[studentKey];
  if (!rec) return "—";
  const v = rec[unitId];
  const sub = rec._detail?.[unitId];
  if (sub && sub.finalized === false) {
    const prov = sub.provisionalScore;
    if (prov !== null && prov !== undefined) {
      return `<span class="score-pending">${prov}<small> (확정전)</small></span>`;
    }
    return `<span class="score-pending">채점중</span>`;
  }
  if (v === "—" || v === undefined || v === null) return "—";
  if (v === "채점중" || v === "대기") return `<span class="score-pending">채점중</span>`;
  return `<span class="score-final">${escapeHtml(String(v))}</span>`;
}

function formatSubmitted(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function displayScore(val) {
  if (val === "—" || val === undefined || val === null) return "—";
  if (val === "채점중" || val === "대기") return "채점중";
  return val;
}

function calcStudentAverage(studentKey, units) {
  const nums = [];
  for (const u of units) {
    const v = scoreFor(studentKey, u.id);
    const sub = state.studentScores?.[studentKey]?._detail?.[u.id];
    if (sub?.finalized === false) {
      if (sub.provisionalScore !== null && sub.provisionalScore !== undefined) {
        nums.push(Number(sub.provisionalScore));
      }
      continue;
    }
    if (v !== "—" && v !== "채점중" && v !== "대기" && !isNaN(Number(v))) nums.push(Number(v));
  }
  if (!nums.length) return "—";
  return (nums.reduce((a, b) => a + Number(b), 0) / nums.length).toFixed(1);
}

function collectQuestionSubmissions(unitId, questionNum) {
  const qKey = String(questionNum);
  const rows = [];
  for (const [studentKey, rec] of Object.entries(state.studentScores || {})) {
    if (studentKey.startsWith("_")) continue;
    const sub = rec._detail?.[unitId];
    if (!sub?.detail) continue;
    const d = sub.detail[qKey];
    if (!d) continue;
    const colon = studentKey.indexOf(":");
    const seat = Number(studentKey.slice(0, colon));
    const name = studentKey.slice(colon + 1);
    rows.push({
      studentKey,
      seat: Number.isFinite(seat) ? seat : 0,
      name,
      given: d.given || "",
      skipped: !!d.skipped,
      mark: sub.essayMarks?.[qKey] || null,
    });
  }
  rows.sort((a, b) => a.seat - b.seat);
  return rows;
}

function renderManualGradeRow(row) {
  const mark = manualGradeSession?.marks?.[row.studentKey] || "";
  const answer = row.skipped || !String(row.given).trim() ? "(미작성)" : row.given;
  return `
    <article class="manual-grade-row" data-student-key="${escapeHtml(row.studentKey)}">
      <div class="manual-grade-student">
        <div class="manual-grade-name">${row.seat}번 ${escapeHtml(row.name)}</div>
        <div class="manual-grade-answer">${escapeHtml(answer)}</div>
      </div>
      <div class="manual-grade-btns" role="group" aria-label="${row.seat}번 채점">
        <button type="button" class="mg-btn mg-correct ${mark === "correct" ? "is-on" : ""}" data-mark="correct">정답</button>
        <button type="button" class="mg-btn mg-partial ${mark === "partial" ? "is-on" : ""}" data-mark="partial">부분점수</button>
        <button type="button" class="mg-btn mg-wrong ${mark === "wrong" ? "is-on" : ""}" data-mark="wrong">오답</button>
      </div>
    </article>`;
}

function renderManualGradeBody() {
  const body = document.getElementById("manualGradeBody");
  if (!body || !manualGradeSession) return;
  const { question, rows, rubricLabel } = manualGradeSession;

  if (!rows.length) {
    body.innerHTML = `<p class="manual-grade-empty">이 단원에 제출한 학생이 없습니다.<br>학생이 시험을 제출하면 여기에 답안이 표시됩니다.</p>`;
    return;
  }

  body.innerHTML = `
    <div class="manual-grade-block">
      <div class="manual-grade-qhead">${question.num}번 서술형 기준: ${escapeHtml(rubricLabel)}</div>
      <div class="manual-grade-list">
        ${rows.map((r) => renderManualGradeRow(r)).join("")}
      </div>
    </div>`;

  body.querySelectorAll(".manual-grade-row").forEach((rowEl) => {
    const key = rowEl.dataset.studentKey;
    rowEl.querySelectorAll(".mg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        manualGradeSession.marks[key] = btn.dataset.mark;
        rowEl.querySelectorAll(".mg-btn").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
      });
    });
  });
}

function openManualGradeModal(question, unit, subject) {
  const rows = collectQuestionSubmissions(unit.id, question.num);
  const cls = activeClass();
  const rubricLabel = (question.rubric || "").trim() || "1";

  manualGradeSession = {
    unitId: unit.id,
    questionNum: question.num,
    question,
    subject,
    unit,
    marks: {},
    rows,
    rubricLabel,
  };

  for (const row of rows) {
    if (row.mark) manualGradeSession.marks[row.studentKey] = row.mark;
  }

  const classLabel = cls?.name || "우리반";
  const unitLabel = `${subject.name}_${unit.name}`;
  document.getElementById("manualGradeMeta").textContent =
    `${subject.name} · ${classLabel} · ${unitLabel} · ${question.num}번 / 1개 문항 · ${rows.length}개 답안`;

  renderManualGradeBody();
  document.getElementById("manualGradeModal").classList.remove("hidden");
}

function closeManualGradeModal() {
  document.getElementById("manualGradeModal")?.classList.add("hidden");
  manualGradeSession = null;
}

async function saveManualGradeModal() {
  if (!manualGradeSession) return;
  const marks = {};
  for (const [key, mark] of Object.entries(manualGradeSession.marks || {})) {
    if (["correct", "wrong", "partial"].includes(mark)) marks[key] = mark;
  }
  if (!Object.keys(marks).length) {
    showToast("채점할 학생을 선택해 주세요.", true);
    return;
  }

  const res = await fetch("/api/grading/review-question", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      unitId: manualGradeSession.unitId,
      questionNum: manualGradeSession.questionNum,
      marks,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "저장 실패");

  const gradingRes = await fetch("/api/grading", { credentials: "include" });
  state.studentScores = normalizeState(await gradingRes.json()).studentScores;

  showToast(`${data.updated || Object.keys(marks).length}명 채점을 저장했습니다.`);
  closeManualGradeModal();
  updateMainNavBadge();
  refreshGradesOrTrendView();
}

async function postReview(studentKey, unitId, essayMarks, finalize) {
  const res = await fetch("/api/grading/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ studentKey, unitId, essayMarks, finalize }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "채점 저장 실패");
  if (!state.studentScores[studentKey]) state.studentScores[studentKey] = {};
  state.studentScores[studentKey][unitId] = data.score;
  if (data.submission) {
    state.studentScores[studentKey]._detail = state.studentScores[studentKey]._detail || {};
    state.studentScores[studentKey]._detail[unitId] = data.submission;
  }
  return data;
}

function buildStudentResultHtml(studentKey, seat, name) {
  const units = getAllUnits();
  const record = state.studentScores?.[studentKey] || {};
  const detail = record._detail || {};
  const online = onlineSeats[seat];

  let rows = "";
  for (const u of units) {
    const sc = scoreFor(studentKey, u.id);
    const sub = detail[u.id];
    const scoreLabel = sub && sub.finalized === false
      ? `자동 ${sub.provisionalScore ?? "—"}점 (확정 전)`
      : `${displayScore(sc)}점`;

    const answerLines = sub?.detail
      ? Object.entries(sub.detail)
          .map(([num, info]) => {
            const mark = info.correct ? "✓" : info.partial ? "△" : info.pending ? "⋯" : "✗";
            const givenText = info.skipped || !info.given ? "(미작성)" : info.given;
            const essayMarks = sub.essayMarks || {};
            const isEssayPending = info.pending && String(info.given || "").trim();
            const essayBtns = isEssayPending
              ? `<div class="essay-grade-actions" data-unit-id="${escapeHtml(u.id)}" data-q-num="${escapeHtml(num)}">
                  <button type="button" class="essay-mark ${essayMarks[num] === "correct" ? "is-correct" : ""}" data-mark="correct">정답</button>
                  <button type="button" class="essay-mark ${essayMarks[num] === "partial" ? "is-partial" : ""}" data-mark="partial">부분</button>
                  <button type="button" class="essay-mark ${essayMarks[num] === "wrong" ? "is-wrong" : ""}" data-mark="wrong">오답</button>
                </div>`
              : "";
            return `<tr data-q-row="${escapeHtml(num)}"><td>${num}번</td><td>${mark}</td><td>${escapeHtml(givenText)}${essayBtns}</td><td>${info.points}점</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="4">제출 내역 없음</td></tr>`;

    const finalizeBtn = sub && sub.finalized === false
      ? `<div class="result-unit-foot">
          <button type="button" class="btn btn-blue btn-finalize-unit" data-unit-id="${escapeHtml(u.id)}">이 시험 채점 확정</button>
        </div>`
      : "";

    rows += `
      <section class="result-unit-block" data-unit-id="${escapeHtml(u.id)}">
        <h4>${escapeHtml(u.colLabel || u.name)} <span class="result-score">${scoreLabel}</span></h4>
        <table class="result-answers-table">
          <thead><tr><th>문항</th><th>채점</th><th>학생 답</th><th>배점</th></tr></thead>
          <tbody>${answerLines}</tbody>
        </table>
        ${finalizeBtn}
      </section>`;
  }

  if (!units.length) {
    rows = `<p class="muted">등록된 시험(단원)이 없습니다.</p>`;
  }

  return `
    <div class="result-summary">
      <p><span class="dot ${online ? "on" : "off"}"></span> <strong>${escapeHtml(name)}</strong> · ${seat}번</p>
      <p>평균 <strong class="result-avg">${calcStudentAverage(studentKey, units)}</strong> · 최종 제출 ${formatSubmitted(record._submittedAt)}</p>
    </div>
    ${rows}`;
}

function bindStudentResultModal(studentKey) {
  const modal = document.getElementById("studentResultModal");
  const body = document.getElementById("studentResultBody");

  body.querySelectorAll(".essay-mark").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const unitId = btn.closest(".essay-grade-actions")?.dataset.unitId;
      const qNum = btn.closest(".essay-grade-actions")?.dataset.qNum;
      if (!unitId || !qNum) return;
      const marks = { [qNum]: btn.dataset.mark };
      try {
        await postReview(studentKey, unitId, marks, false);
        openStudentResult(studentKey, modal.dataset.seat, modal.dataset.studentName);
        refreshGradesOrTrendView();
        updateMainNavBadge();
        showToast("서술형 채점을 반영했습니다.");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  body.querySelectorAll(".btn-finalize-unit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const unitId = btn.dataset.unitId;
      try {
        await postReview(studentKey, unitId, null, true);
        openStudentResult(studentKey, modal.dataset.seat, modal.dataset.studentName);
        refreshGradesOrTrendView();
        updateMainNavBadge();
        showToast("채점을 확정했습니다.");
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

function openStudentResult(studentKey, seat, name) {
  const modal = document.getElementById("studentResultModal");
  const body = document.getElementById("studentResultBody");
  document.getElementById("studentResultTitle").textContent = `${name} (${seat}번) 결과`;
  body.innerHTML = buildStudentResultHtml(studentKey, seat, name);
  modal.dataset.studentKey = studentKey;
  modal.dataset.seat = seat;
  modal.dataset.studentName = name;
  modal.classList.remove("hidden");
  bindStudentResultModal(studentKey);
}

function closeStudentResultModal() {
  document.getElementById("studentResultModal")?.classList.add("hidden");
}

function printStudentReport(studentKey, seat, name) {
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"/><title>${escapeHtml(name)} 성적표</title>
  <style>body{font-family:sans-serif;padding:24px} h1{font-size:18px} .result-avg{color:#2563eb;font-size:20px}
  table{width:100%;border-collapse:collapse;margin:12px 0} th,td{border:1px solid #ddd;padding:8px;font-size:13px}
  th{background:#f5f5f5}</style></head><body>
  <h1>${escapeHtml(name)} (${seat}번) 시험 결과</h1>
  ${buildStudentResultHtml(studentKey, seat, name)}
  </body></html>`;
  const w = window.open("", "_blank", "width=800,height=700");
  if (!w) {
    showToast("팝업이 차단되었습니다.", true);
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
}

document.querySelectorAll('[data-close="studentResultModal"]').forEach((el) => {
  el.addEventListener("click", closeStudentResultModal);
});

document.querySelectorAll('[data-close="manualGradeModal"]').forEach((el) => {
  el.addEventListener("click", closeManualGradeModal);
});
document.getElementById("manualGradeSave")?.addEventListener("click", async () => {
  try {
    await saveManualGradeModal();
  } catch (err) {
    showToast(err.message || "저장하지 못했습니다.", true);
  }
});
document.getElementById("studentResultPrint")?.addEventListener("click", () => {
  const modal = document.getElementById("studentResultModal");
  if (modal.classList.contains("hidden")) return;
  printStudentReport(modal.dataset.studentKey, modal.dataset.seat, modal.dataset.studentName);
});

const TREND_CHART_COLORS = ["#e8955c", "#7cb87a", "#f0a8bc", "#8fad7a", "#c9a87c", "#5a9a58"];
let trendSelectedStudentKey = null;
let trendCharts = [];
const trendAnalysisCache = {};

function getNumericScore(studentKey, unitId) {
  const rec = state.studentScores?.[studentKey];
  if (!rec) return null;
  const v = rec[unitId];
  const sub = rec._detail?.[unitId];
  if (v === "채점중" || v === "대기") {
    if (sub?.provisionalScore !== null && sub?.provisionalScore !== undefined) {
      const n = Number(sub.provisionalScore);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  if (v === undefined || v === null || v === "—") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildTrendSeriesBySubject(studentKey, subjectIdFilter) {
  const bySubject = {};
  const subjects = subjectIdFilter
    ? getExamSubjects().filter((s) => s.id === subjectIdFilter)
    : getExamSubjects();

  for (const sub of subjects) {
    const subName = sub.name;
    if (!bySubject[subName]) bySubject[subName] = [];
    for (const u of sub.units || []) {
      const score = getNumericScore(studentKey, u.id);
      if (score !== null) {
        bySubject[subName].push({ label: u.name, score, unitId: u.id });
      }
    }
  }
  return bySubject;
}

function destroyTrendCharts() {
  for (const c of trendCharts) {
    try {
      c.destroy();
    } catch (_) {}
  }
  trendCharts = [];
}

function renderTrendCharts(studentKey) {
  destroyTrendCharts();
  const grid = document.getElementById("trendChartsGrid");
  if (!grid) return;

  if (!studentKey) {
    grid.innerHTML = `<p class="trend-empty">학생을 선택해 주세요.</p>`;
    return;
  }

  const series = buildTrendSeriesBySubject(studentKey, gradesSubjectId || undefined);
  const subjects = Object.keys(series);
  if (!subjects.length) {
    grid.innerHTML = `<p class="trend-empty">표시할 점수가 없습니다. 학생이 시험을 제출하면 그래프가 나타납니다.</p>`;
    return;
  }

  if (!window.Chart) {
    grid.innerHTML = `<p class="trend-empty">차트를 불러오지 못했습니다. 페이지를 새로고침해 주세요.</p>`;
    return;
  }

  grid.innerHTML = subjects
    .map(
      (sub, i) => `
    <div class="trend-chart-card">
      <h3>${escapeHtml(sub)}</h3>
      <div class="trend-chart-wrap"><canvas id="trendChart_${i}" aria-label="${escapeHtml(sub)} 성적 추이"></canvas></div>
    </div>`
    )
    .join("");

  subjects.forEach((sub, i) => {
    const points = series[sub];
    const canvas = document.getElementById(`trendChart_${i}`);
    if (!canvas) return;
    const color = TREND_CHART_COLORS[i % TREND_CHART_COLORS.length];
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: points.map((p) => p.label),
        datasets: [
          {
            label: "점수",
            data: points.map((p) => p.score),
            borderColor: color,
            backgroundColor: color + "33",
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            pointRadius: 5,
            pointHoverRadius: 7,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
            ticks: { stepSize: 20 },
            title: { display: true, text: "점수" },
          },
          x: {
            ticks: { maxRotation: 45, minRotation: 0, autoSkip: true },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.parsed.y}점`,
            },
          },
        },
      },
    });
    trendCharts.push(chart);
  });
}

function renderTrendAnalysisPanel(analysis) {
  const panel = document.getElementById("trendAiPanel");
  if (!panel) return;
  panel.classList.remove("hidden", "is-loading");

  const listHtml = (items) =>
    items?.length ? `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "<p class=\"muted\">—</p>";

  panel.innerHTML = `
    <h3>🤖 AI 학습 분석</h3>
    <div class="trend-ai-summary">${escapeHtml(analysis.trendSummary || "")}</div>
    <div class="trend-ai-block strengths">
      <h4>💪 강한 부분</h4>
      ${listHtml(analysis.strengths)}
    </div>
    <div class="trend-ai-block weaknesses">
      <h4>📌 약한 부분</h4>
      ${listHtml(analysis.weaknesses)}
    </div>
    <div class="trend-ai-block recommendations">
      <h4>✅ 보완·학습 제안</h4>
      ${listHtml(analysis.recommendations)}
    </div>`;
}

async function fetchTrendAnalysis(studentKey) {
  const panel = document.getElementById("trendAiPanel");
  if (!panel) return;

  if (!apiKeyMeta.canScan) {
    showToast("사이드바 하단에서 AI API 키를 먼저 저장해 주세요.", true);
    document.querySelector(".sb-api-footer")?.scrollIntoView({ behavior: "smooth" });
    return;
  }

  panel.classList.remove("hidden");
  panel.classList.add("is-loading");
  panel.innerHTML = `<h3>🤖 AI 학습 분석</h3><p class="muted">분석 중… (10~30초)</p>`;

  try {
    const res = await fetch("/api/grading/trend-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ studentKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "분석 실패");
    trendAnalysisCache[studentKey] = data.analysis;
    renderTrendAnalysisPanel(data.analysis);
    const logs = await fetchTrendAnalysisLogs(studentKey, 20);
    renderTrendLogList(logs, "trendLogList");
    showToast("AI 학습 분석을 완료하고 기록에 저장했습니다.");
  } catch (err) {
    panel.classList.remove("is-loading");
    panel.innerHTML = `<h3>🤖 AI 학습 분석</h3><p class="error-inline">${escapeHtml(err.message)}</p>`;
    showToast(err.message || "AI 분석 실패", true);
  }
}

function bindTrendSection(students) {
  const select = document.getElementById("trendStudentSelect");
  if (!select) return;

  const options = students.length
    ? students
        .map((st) => {
          const key = `${st.seat}:${st.name}`;
          return `<option value="${escapeHtml(key)}">${st.seat}번 ${escapeHtml(st.name)}</option>`;
        })
        .join("")
    : `<option value="">학생 없음</option>`;

  select.innerHTML = options;

  if (!trendSelectedStudentKey && students[0]) {
    trendSelectedStudentKey = `${students[0].seat}:${students[0].name}`;
  }
  if (trendSelectedStudentKey && [...select.options].some((o) => o.value === trendSelectedStudentKey)) {
    select.value = trendSelectedStudentKey;
  } else if (students[0]) {
    trendSelectedStudentKey = `${students[0].seat}:${students[0].name}`;
    select.value = trendSelectedStudentKey;
  }

  select.onchange = async () => {
    trendSelectedStudentKey = select.value || null;
    renderTrendCharts(trendSelectedStudentKey);
    const panel = document.getElementById("trendAiPanel");
    if (panel && trendSelectedStudentKey && trendAnalysisCache[trendSelectedStudentKey]) {
      renderTrendAnalysisPanel(trendAnalysisCache[trendSelectedStudentKey]);
    } else if (panel) {
      panel.classList.add("hidden");
    }
    try {
      const logs = await fetchTrendAnalysisLogs(trendSelectedStudentKey, 20);
      renderTrendLogList(logs, "trendLogList");
    } catch (_) {}
  };

  const analyzeBtn = document.getElementById("trendAiAnalyzeBtn");
  if (analyzeBtn) {
    analyzeBtn.onclick = () => {
      if (!trendSelectedStudentKey) {
        showToast("학생을 선택해 주세요.", true);
        return;
      }
      fetchTrendAnalysis(trendSelectedStudentKey);
    };
  }

  renderTrendCharts(trendSelectedStudentKey);
  if (trendSelectedStudentKey && trendAnalysisCache[trendSelectedStudentKey]) {
    renderTrendAnalysisPanel(trendAnalysisCache[trendSelectedStudentKey]);
  }
}

function updateMainNavBadge() {
  const pending = countPendingReviews();
  document.querySelectorAll(".sb-nav-btn[data-view='grades']").forEach((btn) => {
    const old = btn.querySelector(".nav-pending-badge");
    if (old) old.remove();
    if (pending > 0) {
      const b = document.createElement("span");
      b.className = "nav-pending-badge";
      b.textContent = String(pending);
      btn.appendChild(b);
    }
  });
}

function bindMainNav() {
  document.querySelectorAll(".sb-nav-btn[data-view]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === currentView);
    btn.onclick = () => setView(btn.dataset.view);
  });
  updateMainNavBadge();
}

function renderGrades() {
  if (!state || !mainEl) return;
  const preservedTrendStudent = trendSelectedStudentKey;
  const preservedGradesSubject = gradesSubjectId;
  destroyTrendCharts();
  const cls = activeClass();
  const students = getStudentsForGrades();
  const examSubjects = getExamSubjects();
  const gradesSub = getGradesSubject();
  if (gradesSub) gradesSubjectId = gradesSub.id;
  else gradesSubjectId = preservedGradesSubject;

  const units = gradesSub ? getUnitsForSubject(gradesSub.id) : [];
  const subjectTabs = renderGradesSubjectTabsHtml(examSubjects, gradesSub);

  const unitHeaders = units.map((u) => `<th class="col-unit">${escapeHtml(u.name)}</th>`).join("");

  const rows = students.length
    ? students
        .map((st) => {
          const key = `${st.seat}:${st.name}`;
          const avg = calcStudentAverage(key, units);
          const online = !!onlineSeats[st.seat];
          return `
            <tr data-student-key="${escapeHtml(key)}">
              <td class="col-no"><span class="dot ${online ? "on" : "off"}"></span>${st.seat}</td>
              <td class="name">${escapeHtml(st.name)}</td>
              ${units.length ? units.map((u) => `<td class="col-score">${scoreCellHtml(key, u.id)}</td>`).join("") : ""}
              <td class="avg">${avg}</td>
              <td class="col-submit">${formatSubmitted(state.studentScores?.[key]?._submittedAt)}</td>
              <td class="col-actions">
                <div class="row-actions">
                  <button type="button" class="btn-row-view" data-student-result="${escapeHtml(key)}" data-seat="${st.seat}" data-name="${escapeHtml(st.name)}">학생결과보기</button>
                  <button type="button" class="print" data-print="${escapeHtml(key)}" data-seat="${st.seat}" data-name="${escapeHtml(st.name)}">인쇄</button>
                  <button type="button" class="reset" data-reset="${escapeHtml(key)}">초기화</button>
                  <button type="button" class="del" data-del="${escapeHtml(key)}">삭제</button>
                </div>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="${5 + Math.max(units.length, 1)}">${
        examSubjects.length
          ? "칠판 「우리반 학생」에서 명단을 저장하거나, 학생이 시험을 제출하면 표시됩니다."
          : "왼쪽 「+ 새 시험(과목) 추가」로 과목을 만든 뒤 단원을 설정하세요."
      }</td></tr>`;

  mainEl.innerHTML = `
    <div class="view-grades">
      <div class="grades-head">
        <div class="grades-head-left">
          <h1>📊 실시간 성적 현황표</h1>
          <div class="legend legend-block">
            <p><span class="dot on"></span> <strong>온라인</strong> : 정상적으로 시험에 응시 중</p>
            <p><span class="dot off"></span> <strong>오프라인</strong> : 브라우저를 끄거나, 다른 창을 여는 등 시험에 응시중이지 않음</p>
          </div>
        </div>
        <div class="grades-actions">
          <button type="button" class="btn btn-publish ${state.resultsPublished ? "on" : "off"}" id="togglePublish">
            📊 ${state.resultsPublished ? "결과 공개 중 (ON)" : "결과 비공개 (OFF)"}
          </button>
          <button type="button" class="btn btn-excel" id="excelBtn">📥 엑셀 다운로드</button>
          <button type="button" class="btn btn-print" id="bulkPrintBtn">🖨️ 일괄 인쇄</button>
        </div>
      </div>
      ${cls ? `<span class="class-badge">${escapeHtml(cls.name)}</span>` : '<span class="class-badge">우리반</span>'}
      ${
        examSubjects.length
          ? `<div class="grades-subject-bar">
          <span class="grades-subject-label">과목</span>
          <div class="grades-subject-tabs">${subjectTabs}</div>
          ${gradesSub ? `<span class="grades-subject-hint">${escapeHtml(gradesSub.name)} · ${units.length}개 단원</span>` : ""}
        </div>`
          : `<p class="grades-no-subject">시험 관리에서 과목을 먼저 추가해 주세요.</p>`
      }
      <div class="grades-table-wrap">
        <table class="grades-table">
          <thead>
            <tr>
              <th>번호</th>
              <th>이름</th>
              ${unitHeaders}
              <th>평균</th>
              <th>최종 제출</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  trendSelectedStudentKey = preservedTrendStudent;
  if (preservedGradesSubject) gradesSubjectId = preservedGradesSubject;

  bindGradesSubjectTabs();

  document.getElementById("togglePublish")?.addEventListener("click", async () => {
    state.resultsPublished = !state.resultsPublished;
    await saveNow();
    renderGrades();
  });
  document.getElementById("excelBtn")?.addEventListener("click", () => {
    const subLabel = gradesSub?.name || "성적";
    const lines = ["번호,이름," + units.map((u) => u.name).join(",") + ",평균"];
    for (const st of students) {
      const key = `${st.seat}:${st.name}`;
      lines.push([st.seat, st.name, ...units.map((u) => scoreFor(key, u.id))].join(","));
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `${subLabel}_성적.csv`;
    a.click();
  });
  document.getElementById("bulkPrintBtn")?.addEventListener("click", () => {
    document.body.classList.add("grades-print-mode");
    window.print();
    setTimeout(() => document.body.classList.remove("grades-print-mode"), 500);
  });

  if (window._gradesPoll) clearInterval(window._gradesPoll);
  window._gradesPoll = setInterval(async () => {
    if (currentView !== "grades") return;
    try {
      const [onlineRes, gradingRes] = await Promise.all([
        fetch("/api/grading/online", { credentials: "include" }),
        fetch("/api/grading", { credentials: "include" }),
      ]);
      onlineSeats = (await onlineRes.json()).online || {};
      const fresh = normalizeState(await gradingRes.json());
      state.studentScores = fresh.studentScores;
      renderGrades();
    } catch (_) {}
  }, 5000);

  mainEl.querySelectorAll("[data-student-result]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openStudentResult(btn.dataset.studentResult, btn.dataset.seat, btn.dataset.name);
    });
  });

  mainEl.querySelectorAll("[data-print]").forEach((btn) => {
    btn.addEventListener("click", () => {
      printStudentReport(btn.dataset.print, btn.dataset.seat, btn.dataset.name);
    });
  });

  mainEl.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      confirmDialog("초기화", "이 학생의 제출·점수를 모두 초기화할까요?", async () => {
        delete state.studentScores[btn.dataset.reset];
        delete trendAnalysisCache[btn.dataset.reset];
        await saveNow();
        renderGrades();
        showToast("초기화했습니다.");
      });
    });
  });

  mainEl.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      confirmDialog("삭제", "이 학생의 성적 기록을 삭제할까요?", async () => {
        delete state.studentScores[btn.dataset.del];
        delete trendAnalysisCache[btn.dataset.del];
        await saveNow();
        renderGrades();
        showToast("삭제했습니다.");
      });
    });
  });
}

function renderGradesSubjectTabsHtml(examSubjects, gradesSub) {
  if (!examSubjects.length) return "";
  return examSubjects
    .map(
      (s) =>
        `<button type="button" class="grades-subject-tab ${s.id === gradesSub?.id ? "is-active" : ""}" data-grades-subject="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`
    )
    .join("");
}

function bindGradesSubjectTabs() {
  mainEl.querySelectorAll("[data-grades-subject]").forEach((tab) => {
    tab.addEventListener("click", () => {
      gradesSubjectId = tab.dataset.gradesSubject;
      state.activeSubjectId = gradesSubjectId;
      scheduleSave();
      renderSidebar();
      if (currentView === "trend") renderTrend();
      else renderGrades();
    });
  });
}

function renderTrend() {
  if (!state || !mainEl) return;
  const preservedTrendStudent = trendSelectedStudentKey;
  const preservedGradesSubject = gradesSubjectId;
  destroyTrendCharts();

  const cls = activeClass();
  const students = getStudentsForGrades();
  const examSubjects = getExamSubjects();
  const gradesSub = getGradesSubject();
  if (gradesSub) gradesSubjectId = gradesSub.id;
  else gradesSubjectId = preservedGradesSubject;

  const units = gradesSub ? getUnitsForSubject(gradesSub.id) : [];
  const subjectTabs = renderGradesSubjectTabsHtml(examSubjects, gradesSub);

  mainEl.innerHTML = `
    <div class="view-trend">
      <div class="trend-head">
        <h1>📈 성적 변화 추이</h1>
        <p class="trend-section-desc">${gradesSub ? `「${escapeHtml(gradesSub.name)}」` : "선택한 과목의"} 단원별 점수 그래프와 AI 학습 분석입니다.</p>
      </div>
      ${cls ? `<span class="class-badge">${escapeHtml(cls.name)}</span>` : '<span class="class-badge">우리반</span>'}
      ${
        examSubjects.length
          ? `<div class="grades-subject-bar">
          <span class="grades-subject-label">과목</span>
          <div class="grades-subject-tabs">${subjectTabs}</div>
          ${gradesSub ? `<span class="grades-subject-hint">${escapeHtml(gradesSub.name)} · ${units.length}개 단원</span>` : ""}
        </div>`
          : `<p class="grades-no-subject">시험 관리에서 과목을 먼저 추가해 주세요.</p>`
      }
      <div class="trend-toolbar">
        <label>
          학생
          <select id="trendStudentSelect" aria-label="성적 추이 학생 선택"></select>
        </label>
        <button type="button" class="btn btn-ai" id="trendAiAnalyzeBtn">🤖 AI 학습 분석</button>
      </div>
      <div id="trendChartsGrid" class="trend-charts-grid"></div>
      <div id="trendAiPanel" class="trend-ai-panel hidden" aria-live="polite"></div>
      <section class="trend-log-section" aria-label="AI 학습 분석 기록">
        <h2 class="dash-section-title">📋 AI 학습 분석 기록</h2>
        <p class="trend-section-desc">「AI 학습 분석」을 실행할 때마다 결과가 저장됩니다.</p>
        <div id="trendLogList" class="trend-log-list"><p class="muted">불러오는 중…</p></div>
      </section>
    </div>`;

  trendSelectedStudentKey = preservedTrendStudent;
  if (preservedGradesSubject) gradesSubjectId = preservedGradesSubject;

  bindGradesSubjectTabs();
  bindTrendSection(students);
  fetchTrendAnalysisLogs(trendSelectedStudentKey, 20)
    .then((logs) => renderTrendLogList(logs, "trendLogList"))
    .catch(() => {
      const el = document.getElementById("trendLogList");
      if (el) el.innerHTML = `<p class="trend-log-empty">기록을 불러오지 못했습니다.</p>`;
    });
}

let qrPanelOpen = false;

function setQrPanelOpen(open) {
  qrPanelOpen = !!open;
  const panel = document.getElementById("qrPreviewPanel");
  const btn = document.getElementById("qrToggleBtn");
  if (panel) {
    panel.classList.toggle("is-collapsed", !qrPanelOpen);
    panel.setAttribute("aria-hidden", qrPanelOpen ? "false" : "true");
  }
  if (btn) {
    btn.textContent = qrPanelOpen ? "QR접기" : "QR열기";
    btn.setAttribute("aria-expanded", qrPanelOpen ? "true" : "false");
    btn.classList.toggle("is-open", qrPanelOpen);
  }
}

async function loadQrInline() {
  const status = document.getElementById("qrLoadStatus");
  const img = document.getElementById("qrImageInline");
  const urlEl = document.getElementById("qrUrlInline");
  try {
    const res = await fetch("/api/grading/student-url", { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "QR 로드 실패");
    studentUrl = data.examUrl || "";
    qrDataUrl = data.dataUrl || "";
    if (urlEl) {
      urlEl.textContent = studentUrl;
      urlEl.title = studentUrl;
    }
    if (qrDataUrl && img) {
      img.src = qrDataUrl;
      img.hidden = false;
      status?.classList.add("hidden");
    } else if (status) {
      status.textContent = "QR을 만들지 못했습니다.";
      status.classList.remove("hidden");
    }
  } catch (err) {
    if (status) {
      status.textContent = err.message || "QR 불러오기 실패";
      status.classList.remove("hidden");
    }
    showToast(status?.textContent || "QR 불러오기 실패", true);
  }
}

document.getElementById("qrToggleBtn")?.addEventListener("click", async () => {
  const willOpen = !qrPanelOpen;
  setQrPanelOpen(willOpen);
  if (willOpen && !qrDataUrl) await loadQrInline();
});

document.getElementById("qrCopyBtn").addEventListener("click", async () => {
  if (!studentUrl) await loadQrInline();
  try {
    await navigator.clipboard.writeText(studentUrl);
    showToast("주소를 복사했습니다.");
  } catch (_) {
    showToast(studentUrl, false);
  }
});

document.getElementById("qrSaveBtn").addEventListener("click", async () => {
  if (!qrDataUrl) await loadQrInline();
  if (!qrDataUrl) return;
  const a = document.createElement("a");
  a.href = qrDataUrl;
  a.download = "student-exam-qr.png";
  a.click();
});

document.getElementById("addSubjectBtn").addEventListener("click", addSubjectFlow);
document.getElementById("saveApiKeysBtn")?.addEventListener("click", saveApiKeys);
document.getElementById("clearApiKeysBtn")?.addEventListener("click", clearApiKeys);
document.getElementById("aiProviderSelect")?.addEventListener("change", () => {
  updateApiKeyInputPlaceholder(selectedAiProvider());
  saveAiProviderOnly();
});

document.getElementById("addClassBtn").addEventListener("click", () => {
  openDialog({
    title: "학반 추가",
    fields: [
      { name: "name", label: "학반 이름", placeholder: "5-3반" },
      { name: "count", label: "학생 수", type: "number", value: "20", min: 1, max: 40 },
    ],
    onConfirm: async (v) => {
      if (!v.name?.trim()) {
        showToast("학반 이름을 입력하세요.", true);
        return false;
      }
      const id = newId();
      state.classes.push({
        id,
        name: v.name.trim(),
        studentCount: Number(v.count) || 20,
      });
      if (!state.activeClassId) state.activeClassId = id;
      await saveNow();
      renderSidebar();
      showToast("학반이 추가되었습니다.");
      return true;
    },
  });
});

document.getElementById("gradingLogout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
  window.top.location.href = "/login";
});

const gradingSocket = io({ reconnection: true });
gradingSocket.on("connect", () => {
  gradingSocket.emit("teacher:join");
});
gradingSocket.on("grading:scoreUpdate", (p) => {
  if (!state || !p?.studentKey) return;
  delete trendAnalysisCache[p.studentKey];
  if (!state.studentScores[p.studentKey]) state.studentScores[p.studentKey] = {};
  const rec = state.studentScores[p.studentKey];
  rec[p.unitId] = p.score;
  rec._submittedAt = p.submittedAt || Date.now();
  if (p.submission) {
    rec._detail = rec._detail || {};
    rec._detail[p.unitId] = p.submission;
  }
  updateMainNavBadge();
  if (currentView === "grades") renderGrades();
  else if (currentView === "trend") renderTrendCharts(trendSelectedStudentKey);
  const needsReview = p.submission && p.submission.finalized === false;
  if (needsReview) {
    const prov = p.provisionalScore;
    const hint = prov !== null && prov !== undefined ? ` (자동 ${prov}점)` : "";
    showToast(`${p.name || "학생"} 답안 제출${hint} — 서술형 채점 후 확정해 주세요.`);
  } else {
    showToast(`${p.name || "학생"} 답안 제출 (${p.score}점)`);
  }
  if (currentView !== "grades" && currentView !== "trend") setView("grades");
});

loadData();
