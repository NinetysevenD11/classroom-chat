/** 학생 시험 응시 화면 */

const socket = io({ reconnection: true });
const joinView = document.getElementById("joinView");
const examView = document.getElementById("examView");
const examJoinError = document.getElementById("examJoinError");
const examUnitList = document.getElementById("examUnitList");
const examPaper = document.getElementById("examPaper");
const examAnswers = document.getElementById("examAnswers");
const examSubmitBtn = document.getElementById("examSubmitBtn");

let publicData = { units: [] };
let currentUnit = null;
let mySeat = null;
let myName = null;
const clientId = localStorage.getItem("examClientId") || crypto.randomUUID();

localStorage.setItem("examClientId", clientId);

async function loadPublicExam() {
  const res = await fetch("/api/exam/public");
  publicData = await res.json();
}

function showExam() {
  joinView.hidden = true;
  examView.hidden = false;
  document.getElementById("examStudentLabel").textContent = `${myName} (${mySeat}번)`;
  renderUnits();
}

function renderUnits() {
  examUnitList.innerHTML = "";
  examPaper.classList.add("hidden");
  examAnswers.classList.add("hidden");
  examSubmitBtn.classList.add("hidden");

  if (!publicData.ok || !publicData.units?.length) {
    examUnitList.innerHTML = `<p style="padding:16px;color:#64748b">${escapeHtml(publicData.message || "응시 가능한 시험이 없습니다. 선생님이 과목 잠금을 해제해 주세요.")}</p>`;
    return;
  }

  for (const unit of publicData.units) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit-card";
    btn.textContent = `${unit.name} (${unit.questionCount}문항)`;
    btn.addEventListener("click", () => openUnit(unit));
    examUnitList.appendChild(btn);
  }
}

function openUnit(unit) {
  currentUnit = unit;
  examUnitList.classList.add("hidden");
  examPaper.classList.remove("hidden");
  examAnswers.classList.remove("hidden");
  examSubmitBtn.classList.remove("hidden");

  examPaper.innerHTML = (unit.images || [])
    .map((src) => `<img src="${src}" alt="시험지" />`)
    .join("") || "<p style='padding:12px;color:#94a3b8'>등록된 시험지 이미지가 없습니다.</p>";

  examAnswers.innerHTML = "";
  for (let i = 1; i <= unit.questionCount; i++) {
    const row = document.createElement("div");
    row.className = "answer-row";
    row.innerHTML = `<label>${i}번</label><input type="text" data-q="${i}" placeholder="답 입력" autocomplete="off" />`;
    examAnswers.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

document.getElementById("examJoinBtn").addEventListener("click", () => {
  examJoinError.textContent = "";
  const name = document.getElementById("examName").value.trim();
  const pin = document.getElementById("examPin").value.trim();
  const seat = Number(pin);
  if (!name || !seat || seat < 1 || seat > 19) {
    examJoinError.textContent = "이름과 1~19 사이 번호(4자리)를 입력해 주세요.";
    return;
  }
  socket.emit("student:join", { name, seat, clientId }, async (res) => {
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
  if (!currentUnit) return;
  const answers = {};
  examAnswers.querySelectorAll("input[data-q]").forEach((inp) => {
    answers[inp.dataset.q] = inp.value.trim();
  });
  socket.emit("exam:submit", { unitId: currentUnit.id, answers, clientId }, (res) => {
    if (res?.ok) {
      alert("제출되었습니다!");
      examUnitList.classList.remove("hidden");
      examPaper.classList.add("hidden");
      examAnswers.classList.add("hidden");
      examSubmitBtn.classList.add("hidden");
      currentUnit = null;
    } else {
      alert(res?.error || "제출에 실패했습니다.");
    }
  });
});

document.getElementById("examLogoutBtn").addEventListener("click", () => {
  location.reload();
});

loadPublicExam();
