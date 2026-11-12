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
const themeTabs = document.getElementById("themeTabs");
const questionBank = document.getElementById("questionBank");
const hostStatus = document.getElementById("hostStatus");

const startBtn = document.getElementById("startBtn");
const askBtn = document.getElementById("askBtn");
const voteBtn = document.getElementById("voteBtn");
const revealBtn = document.getElementById("revealBtn");
const endBtn = document.getElementById("endBtn");
const resetBtn = document.getElementById("resetBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");

let state = null;
let selectedTheme = null;
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
    // payload 없으면 ack만 넘겨야 함 — 빈 객체를 보내면 서버가 그걸 콜백으로 받음
    if (payload === undefined) socket.emit(event, ack);
    else socket.emit(event, payload, ack);
  });
}

function renderThemes() {
  const themes = state?.themes || [];
  themeTabs.innerHTML = "";
  if (!selectedTheme && themes[0]) selectedTheme = themes[0].id;
  for (const t of themes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ox-theme" + (selectedTheme === t.id ? " is-on" : "");
    btn.textContent = `${t.label} (${t.count})`;
    btn.addEventListener("click", () => {
      selectedTheme = t.id;
      renderThemes();
      renderBank();
    });
    themeTabs.appendChild(btn);
  }
  renderBank();
}

function renderBank() {
  questionBank.innerHTML = "";
  const theme = (state?.themes || []).find((t) => t.id === selectedTheme);
  if (!theme) return;
  // themes from server only have count; host asks by index — load labels from buttons via ask with themeId+index
  // We need question texts: fetch from a static mirror in client for UX
  const LOCAL = window.OX_QUESTIONS || null;
  const list = LOCAL?.[selectedTheme] || [];
  if (!list.length) {
    questionBank.innerHTML =
      "<p class='muted'>아래에서 직접 질문을 입력하거나, 테마를 고른 뒤 번호를 눌러 주세요.</p>";
    // numbered pickers
    for (let i = 0; i < theme.count; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${theme.label} · ${i + 1}번 질문 사용`;
      btn.addEventListener("click", () => askFromBank(selectedTheme, i));
      questionBank.appendChild(btn);
    }
    return;
  }
  list.forEach((q, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = q;
    btn.addEventListener("click", () => {
      questionInput.value = q;
      askFromBank(selectedTheme, i, q);
    });
    questionBank.appendChild(btn);
  });
}

async function askFromBank(themeId, questionIndex, text) {
  if (text) questionInput.value = text;
  const res = await emit("ox:ask", { themeId, questionIndex, question: text || questionInput.value });
  if (!res.ok) setStatus(res.error || "질문 시작 실패", true);
  else setStatus("질문 라운드 시작!");
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

function updateActions() {
  const phase = state?.phase || "lobby";
  askBtn.disabled = !(phase === "lobby" || phase === "reveal");
  voteBtn.disabled = phase !== "asking";
  revealBtn.disabled = phase !== "voting";
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
  if (state.themes) renderThemes();
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
  } catch (e) {
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
  setStatus(res.ok ? "질문 시작!" : res.error || "실패", !res.ok);
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

// 질문 은행 전문 (서버 테마와 동일 순서)
window.OX_QUESTIONS = {
  class: [
    "나는 발표할 때 작은 모둠 앞이 더 편하다.",
    "나는 수업에서 직접 만들어 보는 활동이 좋다.",
    "나는 조용히 생각할 시간을 받은 뒤에 대답하는 게 좋다.",
    "나는 모르는 것을 질문하는 것도 용기라고 생각한다.",
    "나는 쉬는 시간에 움직이는 것이 좋다.",
    "나는 학급 규칙을 함께 정하면 더 잘 지키게 된다.",
    "나는 혼자 풀기보다 함께 문제를 푸는 게 좋다.",
    "나는 정답이 여러 개인 질문이 재미있다.",
    "나는 친구에게 설명하면서 더 잘 이해한 적이 있다.",
    "나는 발표보다 글로 의견을 내는 것이 편하다.",
  ],
  friend: [
    "나는 친구와 아무 말 없이 있어도 편할 때가 있다.",
    "나는 친구의 생일을 기억하려고 따로 적어 둔다.",
    "나는 친구를 사귈 때 공통 취미가 도움이 된다.",
    "나는 오랜만에 만난 친구와 금방 편해지는 편이다.",
    "나는 친구에게 조언보다 공감을 받고 싶은 날이 있다.",
    "나는 친구와 함께라면 새로운 활동에 도전하기 쉽다.",
    "나는 친구와 매일 연락하지 않아도 가깝다고 느낀다.",
    "나는 친구가 웃으면 나도 따라 웃게 된다.",
    "나는 친구와 취향이 달라도 친하게 지낼 수 있다.",
    "나는 누군가의 이야기를 끝까지 들어 주는 편이다.",
  ],
  self: [
    "나는 유행하는 것보다 내가 좋아하는 것이 더 중요하다.",
    "나는 혼자만의 시간이 있어야 힘이 난다.",
    "나는 좋아하는 분야라면 시간이 가는 줄 모른다.",
    "나는 남들과 다른 의견을 말할 때 용기가 필요하다.",
    "나는 결과보다 노력한 과정을 알아주면 더 기쁘다.",
    "나는 계획에 없던 하루가 더 기억에 남을 때가 있다.",
    "나는 칭찬을 받으면 어색해도 오래 기억한다.",
    "나는 온라인 별명으로 나의 취향을 표현하는 게 좋다.",
    "나는 처음 보는 음식도 한 입 먹어 보고 싶다.",
    "나는 오늘 새롭게 알게 된 것이 있다.",
  ],
  fun: [
    "나는 비 오는 날 장화를 신고 걷는 게 좋다.",
    "나는 블록으로 아주 높은 탑을 쌓고 싶다.",
    "나는 숨바꼭질에서 숨는 쪽이 더 좋다.",
    "나는 구름을 보며 동물 모양을 찾은 적이 있다.",
    "나는 약속이 취소되면 솔직히 조금 좋다.",
    "나는 새 학기가 시작되면 설레는 편이다.",
    "나는 문자보다 만나서 이야기하는 것이 편하다.",
    "나는 시험이 끝나면 가장 먼저 하고 싶은 일이 있다.",
    "나는 휴대전화 없이 산책해 보고 싶다.",
    "나는 이번 달에 작은 도전 하나를 해 보고 싶다.",
  ],
};
