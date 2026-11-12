/** 눈치 O/X — 학생 */

const roomCode = (() => {
  const c = new URLSearchParams(window.location.search).get("room");
  return c ? String(c).trim() : "";
})();

const clientId = (() => {
  const key = "oxClientId";
  let id = localStorage.getItem(key);
  if (!id) {
    id =
      (crypto.randomUUID && crypto.randomUUID()) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
})();

const socket = io({ reconnection: true });

const joinView = document.getElementById("joinView");
const playView = document.getElementById("playView");
const nickInput = document.getElementById("nickInput");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");
const meLabel = document.getElementById("meLabel");
const scoreLabel = document.getElementById("scoreLabel");
const phasePill = document.getElementById("phasePill");
const timerPill = document.getElementById("timerPill");
const questionText = document.getElementById("questionText");
const votePanel = document.getElementById("votePanel");
const resultPanel = document.getElementById("resultPanel");
const rankPanel = document.getElementById("rankPanel");
const rankList = document.getElementById("rankList");
const peerList = document.getElementById("peerList");
const guessInput = document.getElementById("guessInput");
const submitBtn = document.getElementById("submitBtn");
const submitStatus = document.getElementById("submitStatus");

const PHASE_KO = {
  lobby: "대기실",
  asking: "질문 시간",
  voting: "투표!",
  reveal: "결과",
  finished: "종료",
};

let state = null;
let me = null;
let selectedAnswer = null;
let timerTick = null;
let joined = false;

if (!roomCode) {
  joinError.textContent = "선생님 QR 코드로 접속해 주세요.";
  joinBtn.disabled = true;
}

function showPlay() {
  joinView.hidden = true;
  playView.hidden = false;
}

function emit(event, payload) {
  return new Promise((resolve) => {
    const done = (res) => resolve(res || { ok: false });
    const t = setTimeout(() => done({ ok: false, error: "서버 응답이 없어요. 다시 시도해 주세요." }), 8000);
    const ack = (res) => {
      clearTimeout(t);
      done(res);
    };
    if (payload === undefined) socket.emit(event, ack);
    else socket.emit(event, payload, ack);
  });
}

function whenConnected() {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once("connect", resolve));
}

document.querySelectorAll(".ox-choice").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedAnswer = btn.dataset.answer;
    document.querySelectorAll(".ox-choice").forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
  });
});

async function doJoin() {
  joinError.textContent = "";
  const nickname = nickInput.value.trim();
  if (!nickname) {
    joinError.textContent = "닉네임을 입력해 주세요.";
    return;
  }
  joinBtn.disabled = true;
  await whenConnected();
  const res = await emit("ox:playerJoin", { room: roomCode, nickname, clientId });
  joinBtn.disabled = false;
  if (!res.ok) {
    joinError.textContent = res.error || "참여 실패";
    return;
  }
  joined = true;
  me = res.me;
  state = res.state;
  meLabel.textContent = me.nickname;
  showPlay();
  render();
}

joinBtn.addEventListener("click", doJoin);
nickInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doJoin();
});

submitBtn.addEventListener("click", async () => {
  submitStatus.textContent = "";
  if (!selectedAnswer) {
    submitStatus.textContent = "O 또는 X를 골라 주세요.";
    submitStatus.classList.add("is-error");
    return;
  }
  const guess = Number(guessInput.value);
  const res = await emit("ox:submit", { answer: selectedAnswer, guess });
  if (!res.ok) {
    submitStatus.textContent = res.error || "제출 실패";
    submitStatus.classList.add("is-error");
    return;
  }
  submitStatus.textContent = "제출 완료! 결과가 열릴 때까지 기다려 주세요.";
  submitStatus.classList.remove("is-error");
  submitBtn.disabled = true;
});

function updateTimer() {
  clearInterval(timerTick);
  const end = state?.phase === "asking" ? state.askEndsAt : state?.phase === "voting" ? state.voteEndsAt : null;
  if (!end) {
    timerPill.hidden = true;
    return;
  }
  timerPill.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    timerPill.textContent = `${left}초`;
  };
  tick();
  timerTick = setInterval(tick, 250);
}

function renderPeers() {
  peerList.innerHTML = "";
  for (const p of state?.players || []) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = p.online ? p.nickname : `${p.nickname} (나감)`;
    const score = document.createElement("strong");
    score.textContent = `${p.score}점`;
    li.appendChild(name);
    li.appendChild(score);
    peerList.appendChild(li);
  }
}

function renderRank() {
  if (!(state?.phase === "finished" || state?.phase === "reveal") || !state.ranking) {
    rankPanel.hidden = true;
    return;
  }
  rankPanel.hidden = false;
  rankList.innerHTML = "";
  for (const r of state.ranking) {
    const li = document.createElement("li");
    li.textContent = `${r.rank}위 ${r.nickname} — ${r.score}점`;
    rankList.appendChild(li);
  }
}

function render() {
  if (!state) return;
  phasePill.textContent = PHASE_KO[state.phase] || state.phase;
  questionText.textContent = state.question || "선생님 질문을 기다려 주세요.";

  const myScore = state.players?.find((p) => p.clientId === clientId)?.score;
  if (myScore != null) scoreLabel.textContent = `${myScore}점`;

  const voting = state.phase === "voting";
  votePanel.hidden = !voting;
  if (voting) {
    const already = state.players?.find((p) => p.clientId === clientId)?.submitted;
    submitBtn.disabled = !!already;
    guessInput.max = String(state.onlineCount || 19);
  } else {
    selectedAnswer = null;
    document.querySelectorAll(".ox-choice").forEach((b) => b.setAttribute("aria-pressed", "false"));
    guessInput.value = "";
    submitBtn.disabled = false;
    submitStatus.textContent = "";
  }

  if (state.phase === "reveal" && state.lastReveal) {
    const r = state.lastReveal;
    if (!resultPanel.dataset.locked) {
      if (!r.complete) {
        resultPanel.hidden = false;
        resultPanel.textContent = r.message || "이번 라운드는 0점";
      }
    }
  }
  if (state.phase === "asking" || state.phase === "lobby") {
    resultPanel.hidden = true;
    delete resultPanel.dataset.locked;
  }

  updateTimer();
  renderPeers();
  renderRank();
}

socket.on("ox:state", (s) => {
  state = s;
  if (joined) render();
});

socket.on("ox:myResult", (r) => {
  resultPanel.hidden = false;
  resultPanel.dataset.locked = "1";
  if (r.oCount == null) {
    resultPanel.textContent = "이번 라운드 0점 · 개별 답은 비밀이에요.";
    return;
  }
  resultPanel.innerHTML = r.correct
    ? `정답! 숨겨진 O는 <b>${r.oCount}</b>명 · <b>+${r.points}</b>점`
    : `아쉬워요. 숨겨진 O는 <b>${r.oCount}</b>명 · 내 예측 ${r.guess} · 0점<br/><span class="muted">내 답(${r.answer})은 공개되지 않아요.</span>`;
});

socket.on("connect", () => {
  if (joined && me) {
    emit("ox:playerJoin", { room: roomCode, nickname: me.nickname, clientId }).then((res) => {
      if (res.ok) {
        state = res.state;
        me = res.me;
        render();
      }
    });
  }
});
