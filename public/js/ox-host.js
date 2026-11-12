/** 눈치 O/X — 교사 호스트 */

const socket = io({ reconnection: true });

const phaseLabel = document.getElementById("phaseLabel");
const roundLabel = document.getElementById("roundLabel");
const onlineLabel = document.getElementById("onlineLabel");
const submittedLabel = document.getElementById("submittedLabel");
const timerLabel = document.getElementById("timerLabel");
const joinUrlEl = document.getElementById("joinUrl");
const qrImg = document.getElementById("qrImg");
const questionInput = document.getElementById("questionInput");
const currentQuestion = document.getElementById("currentQuestion");
const revealBox = document.getElementById("revealBox");
const playerList = document.getElementById("playerList");
const hostStatus = document.getElementById("hostStatus");

const startBtn = document.getElementById("startBtn");
const askBtn = document.getElementById("askBtn");
const voteBtn = document.getElementById("voteBtn");
const revealBtn = document.getElementById("revealBtn");
const endBtn = document.getElementById("endBtn");
const resetBtn = document.getElementById("resetBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");

let state = null;
let timerTick = null;
let joinUrl = "";

const PHASE_KO = {
  lobby: "대기실",
  asking: "질문 시간",
  voting: "투표 중",
  reveal: "결과",
  finished: "종료",
};

function setStatus(msg, isError = false) {
  hostStatus.textContent = msg || "";
  hostStatus.classList.toggle("is-error", !!isError);
}

function emit(event, payload) {
  return new Promise((resolve) => {
    const done = (res) => resolve(res || { ok: false });
    const t = setTimeout(() => done({ ok: false, error: "서버 응답이 없어요. 새로고침 후 다시 시도해 주세요." }), 8000);
    const ack = (res) => {
      clearTimeout(t);
      done(res);
    };
    if (payload === undefined) socket.emit(event, ack);
    else socket.emit(event, payload, ack);
  });
}

function renderPlayers() {
  playerList.innerHTML = "";
  const players = state?.players || [];
  if (!players.length) {
    const empty = document.createElement("p");
    empty.className = "ox-lobby-empty";
    empty.textContent = "QR을 비추면 캐릭터가 여기 모여요.";
    playerList.appendChild(empty);
    return;
  }
  for (const p of players) {
    playerList.appendChild(window.oxPlayerTile(p));
  }
}

function renderReveal() {
  const r = state?.lastReveal;
  if (!r) {
    revealBox.textContent = "라운드 결과가 여기 표시됩니다.";
    return;
  }
  if (!r.complete) {
    revealBox.textContent = r.message || "미완료 라운드";
    return;
  }
  const correct =
    r.correct?.length > 0
      ? r.correct.map((c) => `${c.nickname}(+${c.points})`).join(", ")
      : "없음";
  revealBox.innerHTML = `<strong>숨겨진 O · ${r.oCount} / ${r.total}</strong><br/>정답자: ${correct}<br/><span class="muted">개인 O/X는 공개하지 않습니다.</span>`;
}

function updateAskLabel() {
  const round = Number(state?.round) || 0;
  const phase = state?.phase || "lobby";
  // 라운드 시작 전이거나 종료·초기화 후 로비(round 0)면 첫 질문 문구
  const freshStart = round <= 0 && (phase === "lobby" || phase === "finished");
  askBtn.textContent = freshStart ? "이 질문으로 시작" : "다음 질문";
}

function updateActions() {
  const phase = state?.phase || "lobby";
  askBtn.disabled = !(phase === "lobby" || phase === "reveal");
  voteBtn.disabled = phase !== "asking";
  revealBtn.disabled = phase !== "voting";
  updateAskLabel();
}

function updateTimer() {
  clearInterval(timerTick);
  timerLabel.hidden = true;
  const end = state?.phase === "asking" ? state.askEndsAt : state?.phase === "voting" ? state.voteEndsAt : null;
  if (!end) return;
  timerLabel.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    timerLabel.textContent = `${left}초`;
  };
  tick();
  timerTick = setInterval(tick, 250);
}

function render() {
  if (!state) return;
  phaseLabel.textContent = PHASE_KO[state.phase] || state.phase;
  roundLabel.textContent = String(state.round || 0);
  onlineLabel.textContent = String(state.onlineCount || 0);
  submittedLabel.textContent = String(state.submittedCount || 0);
  currentQuestion.textContent = state.question || "아직 질문이 없어요.";
  renderPlayers();
  renderReveal();
  updateActions();
  updateTimer();
}

async function loadQr() {
  try {
    const res = await fetch("/api/ox/student-url", { credentials: "include" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "QR 실패");
    joinUrl = data.url;
    joinUrlEl.textContent = data.url;
    if (data.dataUrl) {
      qrImg.src = data.dataUrl;
      qrImg.hidden = false;
    }
  } catch {
    joinUrlEl.textContent = "QR을 불러오지 못했어요.";
  }
}

copyLinkBtn.addEventListener("click", async () => {
  if (!joinUrl) return;
  try {
    await navigator.clipboard.writeText(joinUrl);
    setStatus("참여 링크를 복사했어요.");
  } catch {
    setStatus("복사에 실패했어요. 주소를 직접 선택해 주세요.", true);
  }
});

startBtn.addEventListener("click", async () => {
  const res = await emit("ox:start");
  setStatus(res.ok ? "점수 초기화 · 대기실" : res.error || "실패", !res.ok);
});

askBtn.addEventListener("click", async () => {
  const res = await emit("ox:ask", { question: questionInput.value });
  if (!res.ok) {
    setStatus(res.error || "실패", true);
    return;
  }
  questionInput.value = "";
  setStatus("질문 시작!");
});

voteBtn.addEventListener("click", async () => {
  const res = await emit("ox:beginVote");
  setStatus(res.ok ? "투표 시작!" : res.error || "실패", !res.ok);
});

revealBtn.addEventListener("click", async () => {
  const res = await emit("ox:revealNow");
  setStatus(res.ok ? "결과 공개" : res.error || "실패", !res.ok);
});

endBtn.addEventListener("click", async () => {
  if (!window.confirm("지금 게임을 종료할까요? 최종 순위가 공개됩니다.")) return;
  const res = await emit("ox:end");
  setStatus(res.ok ? "게임 종료 · 최종 순위" : res.error || "실패", !res.ok);
});

resetBtn.addEventListener("click", async () => {
  const res = await emit("ox:resetLobby");
  setStatus(res.ok ? "로비로 돌아왔어요." : res.error || "실패", !res.ok);
});

socket.on("ox:state", (s) => {
  state = s;
  render();
});

socket.on("connect", () => {
  socket.emit("ox:hostJoin", (res) => {
    if (!res?.ok) {
      setStatus(res?.error || "호스트 연결 실패", true);
      return;
    }
    state = res.state;
    render();
    loadQr();
  });
});
