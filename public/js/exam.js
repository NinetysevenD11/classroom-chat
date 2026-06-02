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

function renderPaper(images) {
  if (!images.length) {
    examPaper.innerHTML = `<p class="paper-empty">등록된 시험지가 없습니다.<br>선생님께 문의하세요.</p>`;
    return;
  }
  examPaper.innerHTML = images
    .map((src) => {
      if (src.startsWith("data:application/pdf")) {
        return `<embed src="${src}" type="application/pdf" />`;
      }
      return `<img src="${src}" alt="시험지" loading="lazy" />`;
    })
    .join("");
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
      let msg = res.pendingEssay
        ? `제출 완료! 자동 채점: ${res.score}점 (일부 서술형은 선생님이 채점합니다)`
        : `제출 완료! 점수: ${res.score}점`;
      if (emptyCount > 0) {
        msg += `\n(미작성 ${emptyCount}문항은 오답 처리되었습니다)`;
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
