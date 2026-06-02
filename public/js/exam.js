/** 학생 시험 응시 — 태블릿 최적화 */

const socket = io({ reconnection: true });
const joinView = document.getElementById("joinView");
const examView = document.getElementById("examView");
const examJoinError = document.getElementById("examJoinError");
const unitPicker = document.getElementById("unitPicker");
const examWorkspace = document.getElementById("examWorkspace");
const examPaper = document.getElementById("examPaper");
const examAnswers = document.getElementById("examAnswers");
const examSubmitBtn = document.getElementById("examSubmitBtn");
const examUnitTitle = document.getElementById("examUnitTitle");

let publicData = { units: [] };
let currentUnit = null;
let unitDetail = null;
const answers = {};
let mySeat = null;
let myName = null;

const PAPER_SCALE_MIN = 0.5;
const PAPER_SCALE_MAX = 3;
const PAPER_SCALE_STEP = 0.25;
let paperScale = 1;
let paperZoomBound = false;

const clientId = localStorage.getItem("examClientId") || newId();
localStorage.setItem("examClientId", clientId);

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadPublicExam() {
  const res = await fetch("/api/exam/public");
  publicData = await res.json();
}

async function loadUnitDetail(unitId) {
  const res = await fetch(`/api/exam/unit/${encodeURIComponent(unitId)}`);
  return res.json();
}

function showExam() {
  joinView.hidden = true;
  examView.hidden = false;
  document.getElementById("examStudentLabel").textContent = `${myName} · ${mySeat}번`;
  renderUnitPicker();
}

function renderUnitPicker() {
  unitPicker.classList.remove("hidden");
  examWorkspace.classList.add("hidden");
  examUnitTitle.textContent = "응시할 시험을 선택하세요";
  unitPicker.innerHTML = "";

  if (!publicData.ok || !publicData.units?.length) {
    unitPicker.innerHTML = `<p class="paper-empty">${escapeHtml(
      publicData.message || "응시 가능한 시험이 없습니다. 선생님이 과목 잠금을 해제해 주세요."
    )}</p>`;
    return;
  }

  for (const unit of publicData.units) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit-card";
    btn.innerHTML = `${escapeHtml(unit.label || unit.name)}<small>${unit.questionCount || 0}문항</small>`;
    btn.addEventListener("click", () => openUnit(unit));
    unitPicker.appendChild(btn);
  }
}

async function openUnit(unit) {
  const detail = await loadUnitDetail(unit.id);
  if (!detail.ok) {
    alert(detail.error || "시험을 불러올 수 없습니다.");
    return;
  }
  currentUnit = { ...unit, ...detail };
  unitDetail = detail;
  Object.keys(answers).forEach((k) => delete answers[k]);

  unitPicker.classList.add("hidden");
  examWorkspace.classList.remove("hidden");
  examUnitTitle.textContent = detail.label || detail.name;

  renderPaper(detail.images || []);
  renderAnswerForm(detail.questions || []);
}

function clampPaperScale(v) {
  return Math.min(PAPER_SCALE_MAX, Math.max(PAPER_SCALE_MIN, Math.round(v * 100) / 100));
}

function getPaperZoomInner() {
  return examPaper.querySelector(".paper-zoom-inner");
}

function applyPaperScale() {
  const inner = getPaperZoomInner();
  const label = document.getElementById("paperZoomLabel");
  if (!inner) return;
  inner.style.transform = `scale(${paperScale})`;
  inner.style.width = paperScale > 0 ? `${100 / paperScale}%` : "100%";
  if (label) label.textContent = `${Math.round(paperScale * 100)}%`;
}

function setPaperScale(next) {
  paperScale = clampPaperScale(next);
  applyPaperScale();
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function bindPaperZoomControls() {
  if (paperZoomBound) return;
  paperZoomBound = true;

  document.getElementById("paperZoomIn")?.addEventListener("click", () => {
    setPaperScale(paperScale + PAPER_SCALE_STEP);
  });
  document.getElementById("paperZoomOut")?.addEventListener("click", () => {
    setPaperScale(paperScale - PAPER_SCALE_STEP);
  });
  document.getElementById("paperZoomReset")?.addEventListener("click", () => {
    setPaperScale(1);
    examPaper.scrollTop = 0;
    examPaper.scrollLeft = 0;
  });

  let pinchStartDist = 0;
  let pinchStartScale = 1;

  examPaper.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDistance(e.touches);
        pinchStartScale = paperScale;
        examPaper.classList.add("is-pinching");
      }
    },
    { passive: true }
  );

  examPaper.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 2 || !pinchStartDist) return;
      e.preventDefault();
      const dist = touchDistance(e.touches);
      setPaperScale(pinchStartScale * (dist / pinchStartDist));
    },
    { passive: false }
  );

  const endPinch = () => {
    pinchStartDist = 0;
    examPaper.classList.remove("is-pinching");
  };
  examPaper.addEventListener("touchend", endPinch);
  examPaper.addEventListener("touchcancel", endPinch);

  examPaper.addEventListener(
    "wheel",
    (e) => {
      if (!getPaperZoomInner()) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -PAPER_SCALE_STEP : PAPER_SCALE_STEP;
      setPaperScale(paperScale + delta);
    },
    { passive: false }
  );
}

function renderPaper(images) {
  bindPaperZoomControls();
  paperScale = 1;
  examPaper.scrollTop = 0;
  examPaper.scrollLeft = 0;

  if (!images.length) {
    examPaper.innerHTML = `<p class="paper-empty">등록된 시험지가 없습니다.<br>선생님께 문의하세요.</p>`;
    return;
  }
  const pages = images
    .map((src) => {
      if (src.startsWith("data:application/pdf")) {
        return `<embed src="${src}" type="application/pdf" />`;
      }
      return `<img src="${src}" alt="시험지" loading="lazy" draggable="false" />`;
    })
    .join("");
  examPaper.innerHTML = `<div class="paper-zoom-inner">${pages}</div>`;
  applyPaperScale();
}

function renderAnswerForm(questions) {
  examAnswers.innerHTML = "";
  const sorted = [...questions].sort((a, b) => a.num - b.num);

  for (const q of sorted) {
    const block = document.createElement("div");
    const type = q.type || "mc";
    block.className = `answer-block is-${type === "mc" ? "mc" : type === "essay" ? "essay" : "short"}`;
    block.dataset.q = q.num;

    const label = document.createElement("div");
    label.className = "q-label";
    label.textContent = `${q.num}번${q.points > 1 ? ` (${q.points}점)` : ""}`;
    block.appendChild(label);

    if (type === "mc") {
      const n = Math.min(10, Math.max(2, Number(q.choices) || 5));
      const grid = document.createElement("div");
      grid.className = "mc-options";
      for (let i = 1; i <= n; i++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mc-option";
        btn.textContent = String(i);
        btn.dataset.value = String(i);
        btn.addEventListener("click", () => {
          grid.querySelectorAll(".mc-option").forEach((b) => b.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          answers[q.num] = String(i);
        });
        grid.appendChild(btn);
      }
      block.appendChild(grid);
    } else if (type === "essay") {
      const ta = document.createElement("textarea");
      ta.placeholder = "서술형 답안을 입력하세요";
      ta.addEventListener("input", () => {
        answers[q.num] = ta.value;
      });
      block.appendChild(ta);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "text";
      inp.placeholder = "단답형 답";
      inp.addEventListener("input", () => {
        answers[q.num] = inp.value;
      });
      block.appendChild(inp);
    }

    examAnswers.appendChild(block);
  }
}

/** 미작성 문항은 빈 문자열로 포함 (서버에서 오답 처리) */
function collectAnswersForSubmit(questions) {
  const out = { ...answers };
  for (const q of questions || []) {
    if (out[q.num] === undefined || out[q.num] === null) out[q.num] = "";
  }
  return out;
}

function countEmptyAnswers(questions) {
  let n = 0;
  for (const q of questions || []) {
    const v = answers[q.num];
    if (v === undefined || String(v).trim() === "") n += 1;
  }
  return n;
}

document.getElementById("examBackBtn").addEventListener("click", () => {
  currentUnit = null;
  unitDetail = null;
  renderUnitPicker();
});

document.getElementById("examJoinBtn").addEventListener("click", () => {
  examJoinError.textContent = "";
  const name = document.getElementById("examName").value.trim();
  const pin = document.getElementById("examPin").value.trim();
  const seat = Number(pin);
  if (!name || !Number.isInteger(seat) || seat < 1 || seat > 19) {
    examJoinError.textContent = "이름과 1~19번 자리 번호를 입력해 주세요.";
    return;
  }
  examSubmitBtn.disabled = true;
  socket.emit("student:join", { name, seat, clientId }, async (res) => {
    examSubmitBtn.disabled = false;
    if (!res?.ok) {
      examJoinError.textContent = res?.error || "입장할 수 없습니다.";
      return;
    }
    mySeat = seat;
    myName = name;
    await loadPublicExam();
    showExam();
  });
});

examSubmitBtn.addEventListener("click", () => {
  if (!currentUnit || !unitDetail) return;
  const questions = unitDetail.questions || [];
  const emptyCount = countEmptyAnswers(questions);
  const payload = collectAnswersForSubmit(questions);

  examSubmitBtn.disabled = true;
  socket.emit("exam:submit", { unitId: currentUnit.id, answers: payload, clientId }, (res) => {
    examSubmitBtn.disabled = false;
    if (res?.ok) {
      let msg =
        "제출이 완료되었습니다.\n선생님이 확인·채점한 뒤, 결과가 공개되면 점수를 확인할 수 있습니다.";
      if (emptyCount > 0) {
        msg += `\n(미작성 ${emptyCount}문항은 오답으로 처리됩니다)`;
      }
      document.getElementById("submitModalText").textContent = msg;
      document.getElementById("submitModal").classList.remove("hidden");
    } else {
      alert(res?.error || "제출에 실패했습니다.");
    }
  });
});

document.getElementById("submitModalOk").addEventListener("click", () => {
  document.getElementById("submitModal").classList.add("hidden");
  currentUnit = null;
  renderUnitPicker();
});

loadPublicExam();
