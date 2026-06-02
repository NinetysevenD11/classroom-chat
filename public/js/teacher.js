const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 4000,
});

// 탭 복귀/인터넷 복구 시 즉시 재연결 (오래 켜두어도 안 끊기게)
function ensureConnected() {
  if (socket.disconnected) socket.connect();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") ensureConnected();
});
window.addEventListener("online", ensureConnected);
window.addEventListener("focus", ensureConnected);

const grid = document.getElementById("grid");
const groupBoard = document.getElementById("groupBoard");
const groupClusters = document.getElementById("groupClusters");
const groupTeacherRow = document.getElementById("groupTeacherRow");
const TOTAL = 20; // 1~19 학생, 20 교사
const TEACHER_SEAT = 20;

// 종이비행기 아이콘 (✈️ 이모지 대신)
const PAPER_PLANE_ICON =
  '<span class="icon-paper-plane" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M3.4 20.4l17.45-7.17c.81-.35.81-1.49 0-1.84L3.4 4.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.89c-.5.07-.87.5-.87 1l.01 3.61c0 .71.73 1.2 1.39.91z"/></svg></span>';

// 좌석별 캐릭터
const SEAT_AVATAR = {
  1: "👸",      // 공주
  2: "🧚‍♀️",   // 요정
  3: "🦸‍♀️",   // 여자 히어로
  4: "👩‍🚀",   // 우주비행사(여)
  5: "👩‍🍳",   // 요리사(여)
  6: "👨‍🚀",   // 우주비행사(남)
  7: "👩‍🎤",   // 가수(여)
  8: "🧜‍♀️",   // 인어공주
  9: "🦸‍♂️",   // 남자 히어로
  10: "🧙‍♂️",  // 마법사
  11: "🥷",     // 닌자
  12: "🧝‍♀️",  // 엘프(여)
  13: "🤴",     // 왕자
  14: "👩‍🎨",  // 화가(여)
  15: "👩‍⚕️",  // 의사(여)
  16: "👩‍🚒",  // 소방관(여)
  17: "👨‍🍳",  // 요리사(남)
  18: "👨‍🎤",  // 가수(남)
  19: "👨‍🚒",  // 소방관(남)
  20: "👩‍🏫",  // 선생님
};

// 좌석별 마지막 메시지 보관 (TTS용)
const lastMessages = {};
// 좌석별 전체 채팅 기록 [{id,text,at}]
const logs = {};
// 좌석별 음소거 상태
const mutedSeats = {};
// 플로팅(PiP) 창 핸들
let pipWindow = null;
let boardGroupModeActive = false;
let teacherUserId = null;

// ----- TTS (Google 한국의만 사용) -----
function googleKoreanVoice() {
  if (!("speechSynthesis" in window)) return null;
  return (
    window.speechSynthesis
      .getVoices()
      .find((v) => /google/i.test(v.name) && /^ko/i.test(v.lang)) || null
  );
}

if ("speechSynthesis" in window) {
  googleKoreanVoice();
  window.speechSynthesis.onvoiceschanged = googleKoreanVoice;
}

// 그리드 생성
const tiles = {};
for (let i = 1; i <= TOTAL; i++) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.seat = i;

  const isTeacher = i === TEACHER_SEAT;
  if (isTeacher) tile.classList.add("teacher");

  tile.innerHTML = `
    <div class="seat-head">
      <span class="seat-no">${i === TEACHER_SEAT ? "교사" : i + "번"}</span>
      <span class="name-row">
        <span class="name">${isTeacher ? "선생님" : "빈 자리"}</span>
        <span class="hand-badge hidden" title="발표 요청 · 클릭하면 내림">🙋</span>
      </span>
    </div>
    <span class="status-dot"></span>
    ${isTeacher ? "" : `<div class="controls">
      <button class="photo-btn" title="프로필 사진">📷</button>
      <button class="settings-btn" title="채팅 기록·수정">⚙️</button>
      <button class="dm-btn" title="다이렉트 메시지">${PAPER_PLANE_ICON}</button>
      <button class="mute-btn" title="음소거">🔇</button>
      <button class="kick-btn" title="퇴장">🚪</button>
    </div>`}
    <div class="video-area">
      <img class="avatar-photo hidden" alt="" />
      <div class="avatar-emoji">${SEAT_AVATAR[i] || "🙂"}</div>
    </div>
    <div class="muted-tag">음소거됨</div>
    <div class="bubble"></div>
  `;

  // 학생·선생님 아바타 모두 클릭하면 마지막 채팅을 TTS로 읽어준다.
  tile.addEventListener("click", () => speakSeat(i, tile));

  if (!isTeacher) {
    tile.querySelector(".photo-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      photoTargetSeat = i;
      panelPhotoInput.click();
    });
    tile.querySelector(".settings-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openPanel(i);
    });
    tile.querySelector(".dm-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openPanel(i, true);
    });
    tile.querySelector(".mute-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMute(i);
    });
    tile.querySelector(".kick-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      kickSeat(i);
    });
    const handBadge = tile.querySelector(".hand-badge");
    if (handBadge) {
      handBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!handBadge.classList.contains("hidden")) {
          socket.emit("teacher:lowerHand", { seat: i });
        }
      });
    }
  }

  grid.appendChild(tile);
  tiles[i] = tile;
}

function updateSeatPhoto(tile, seat, photo) {
  const img = tile.querySelector(".avatar-photo");
  const emoji = tile.querySelector(".avatar-emoji");
  const area = tile.querySelector(".video-area");
  if (!img || !emoji) return;
  if (photo) {
    img.src = photo;
    img.classList.remove("hidden");
    emoji.classList.add("hidden");
    tile.classList.add("has-photo");
    if (area) area.classList.add("has-photo");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
    emoji.classList.remove("hidden");
    emoji.textContent = SEAT_AVATAR[seat] || "🙂";
    tile.classList.remove("has-photo");
    if (area) area.classList.remove("has-photo");
  }
}

function renderSeat(seat, data) {
  const tile = tiles[seat];
  if (!tile) return;
  const nameEl = tile.querySelector(".name");
  if (data.name) {
    tile.classList.add("occupied");
    nameEl.textContent = data.name;
  } else {
    tile.classList.remove("occupied");
    nameEl.textContent = "빈 자리";
    delete lastMessages[seat];
    delete logs[seat];
    clearTileBubble(tile);
  }
  updateSeatPhoto(tile, seat, data.photo || null);
  const photoBtn = tile.querySelector(".photo-btn");
  if (photoBtn) photoBtn.style.visibility = data.name ? "visible" : "hidden";
  const handBadge = tile.querySelector(".hand-badge");
  if (handBadge) handBadge.classList.toggle("hidden", !data.handRaised);
  tile.classList.toggle("hand-raised", !!data.handRaised);
  if (Array.isArray(data.messages)) logs[seat] = data.messages.slice();
  tile.classList.toggle("online", !!data.online);

  // 음소거 상태 반영
  mutedSeats[seat] = !!data.muted;
  tile.classList.toggle("muted", !!data.muted);
  const muteBtn = tile.querySelector(".mute-btn");
  if (muteBtn) {
    muteBtn.textContent = data.muted ? "🔈" : "🔇";
    muteBtn.title = data.muted ? "음소거 해제" : "음소거";
  }
  if (data.muted) {
    clearTileBubble(tile);
  } else if (data.lastMessage) {
    lastMessages[seat] = data.lastMessage.text;
    showBubble(tile, data.lastMessage.text, false);
  }
  if (panelSeat === seat && !studentPanel.classList.contains("hidden")) {
    updatePanelPhotoPreview(seat);
  }
}

function toggleMute(seat) {
  socket.emit("teacher:mute", { seat, muted: !mutedSeats[seat] });
}

// ----- 확인 창 (브라우저 confirm 대체) -----
const confirmModal = document.getElementById("confirmModal");
const confirmMessage = document.getElementById("confirmMessage");
const confirmOk = document.getElementById("confirmOk");
const confirmCancel = document.getElementById("confirmCancel");
let confirmResolve = null;

function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmMessage.textContent = message;
    confirmOk.textContent = options.okText || "확인";
    confirmCancel.textContent = options.cancelText || "취소";
    confirmOk.classList.toggle("danger", !!options.danger);
    confirmModal.classList.remove("hidden");
    confirmOk.focus();
  });
}

function closeConfirm(result) {
  confirmModal.classList.add("hidden");
  confirmOk.classList.remove("danger");
  if (confirmResolve) {
    const fn = confirmResolve;
    confirmResolve = null;
    fn(result);
  }
}

confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirm(false);
});
document.addEventListener("keydown", (e) => {
  if (confirmModal.classList.contains("hidden")) return;
  if (e.key === "Escape") closeConfirm(false);
});

async function kickSeat(seat) {
  const tile = tiles[seat];
  const name = tile.querySelector(".name").textContent;
  if (
    await showConfirm(`${seat}번 (${name}) 학생을 퇴장시킬까요?`, {
      danger: true,
      okText: "퇴장",
    })
  ) {
    socket.emit("teacher:kick", { seat });
  }
}

function showBubble(tile, text, pop = true) {
  const bubble = tile.querySelector(".bubble");
  const msg = String(text || "").trim();
  bubble.textContent = msg;
  bubble.title = msg;
  if (msg) {
    bubble.classList.add("show");
    tile.classList.add("has-chat");
  } else {
    bubble.classList.remove("show");
    tile.classList.remove("has-chat", "has-chat-expanded");
  }
  if (pop && msg) {
    bubble.classList.remove("pop");
    void bubble.offsetWidth; // 리플로우로 애니메이션 재시작
    bubble.classList.add("pop");
  }
}

function clearTileBubble(tile) {
  if (!tile) return;
  const bubble = tile.querySelector(".bubble");
  if (bubble) {
    bubble.textContent = "";
    bubble.title = "";
    bubble.classList.remove("show", "pop");
  }
  tile.classList.remove("has-chat", "has-chat-expanded");
}

// Google 한국의 음성으로 발화 객체 생성
function buildUtterance(text) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ko-KR";
  const voice = googleKoreanVoice();
  if (voice) utter.voice = voice;
  return utter;
}

// 임의의 텍스트를 TTS로 읽기
function speakText(text, tile) {
  if (!text) return;
  if (!("speechSynthesis" in window)) {
    alert("이 브라우저는 음성 합성을 지원하지 않습니다.");
    return;
  }
  window.speechSynthesis.cancel();
  const utter = buildUtterance(text);
  if (tile) {
    tile.classList.add("speaking");
    utter.onend = () => tile.classList.remove("speaking");
    utter.onerror = () => tile.classList.remove("speaking");
  }
  window.speechSynthesis.speak(utter);
}

function lowerHandIfRaised(seat) {
  if (seat === TEACHER_SEAT) return;
  const tile = tiles[seat];
  if (!tile || !tile.classList.contains("hand-raised")) return;
  socket.emit("teacher:lowerHand", { seat });
}

function speakSeat(seat, tile) {
  if (mutedSeats[seat]) return; // 음소거된 학생은 읽지 않음
  const text = lastMessages[seat];
  if (!text) return;
  lowerHandIfRaised(seat);
  speakText(text, tile);
}

// ----- 소켓 이벤트 -----
// 최초 연결 + 재연결(서버 재시작/네트워크 끊김) 때마다 'teachers' 그룹에 다시 합류해
// 실시간 업데이트(퇴장·채팅 반영)가 끊기지 않도록 한다.
socket.on("connect", () => socket.emit("teacher:join"));

socket.on("state", (seats) => {
  Object.entries(seats).forEach(([seat, data]) => renderSeat(Number(seat), data));
});

socket.on("seat:update", ({ seat, data }) => renderSeat(seat, data));

socket.on("seat:chat", ({ seat, message }) => {
  seat = Number(seat);
  if (mutedSeats[seat]) return;
  lastMessages[seat] = message.text;
  if (seat !== TEACHER_SEAT) {
    (logs[seat] = logs[seat] || []).push(message);
    if (panelSeat === seat && !studentPanel.classList.contains("hidden")) renderPanelLog();
  }
  const tile = tiles[seat];
  if (tile) showBubble(tile, message.text, true);
});

// 채팅 초기화 (교사 화면만)
socket.on("chats:reset", () => {
  for (let i = 1; i <= TOTAL; i++) {
    delete lastMessages[i];
    delete logs[i];
    const t = tiles[i];
    if (t) clearTileBubble(t);
  }
  if (!studentPanel.classList.contains("hidden")) renderPanelLog();
});

// 학생 메시지 수정 반영
socket.on("seat:msgEdited", ({ seat, id, text, lastIsThis }) => {
  const arr = logs[seat];
  if (arr) {
    const m = arr.find((x) => x.id === id);
    if (m) m.text = text;
  }
  if (lastIsThis) {
    lastMessages[seat] = text;
    const tile = tiles[seat];
    if (tile && !mutedSeats[seat]) showBubble(tile, text, false);
  }
  if (panelSeat === seat && !studentPanel.classList.contains("hidden")) renderPanelLog();
});

// ----- 선생님 채팅 입력 -----
const teacherChatForm = document.getElementById("teacherChatForm");
const teacherChatInput = document.getElementById("teacherChatInput");
teacherChatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = teacherChatInput.value.trim();
  if (!text) return;
  socket.emit("teacher:chat", { text });
  speakText(text, tiles[TEACHER_SEAT]); // 선생님 메시지는 보내자마자 바로 읽기
  teacherChatInput.value = "";
  teacherChatInput.focus();
});

// ----- 로그아웃 -----
document.getElementById("logoutBtn").addEventListener("click", async () => {
  if (!(await showConfirm("로그아웃할까요?", { okText: "로그아웃" }))) return;
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (_) {}
  window.location.href = "/login";
});

// ----- 전체 강퇴 -----
const kickAllBtn = document.getElementById("kickAllBtn");
kickAllBtn.addEventListener("click", async () => {
  if (
    await showConfirm(
      "모든 학생을 한 번에 내보낼까요?\n(자리는 비워지고, 각 학생 프로필은 저장돼요.)",
      { danger: true, okText: "전체 강퇴" }
    )
  ) {
    socket.emit("teacher:kickAll");
  }
});

// ----- 라이트/다크 모드 -----
const themeBtn = document.getElementById("themeBtn");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = theme === "light" ? "☀️" : "🌙";
  themeBtn.title = theme === "light" ? "밝은 낮 모드 (라이트)" : "밤하늘 모드 (다크)";
  localStorage.setItem("theme", theme);
  if (pipWindow && !pipWindow.closed) {
    pipWindow.document.documentElement.setAttribute("data-theme", theme);
  }
}
applyTheme(localStorage.getItem("theme") || "dark");
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "light" ? "dark" : "light");
});

// ----- 플로팅 창 (PiP 또는 팝업 — iframe·구형 브라우저 대응) -----
const pipBtn = document.getElementById("pipBtn");

function isInIframe() {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

function copyStylesToWindow(targetWin) {
  document.querySelectorAll('link[rel="stylesheet"]').forEach((node) => {
    const href = node.getAttribute("href");
    if (!href) return;
    const link = targetWin.document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(href, document.baseURI).href;
    targetWin.document.head.appendChild(link);
  });
  document.querySelectorAll("style").forEach((node) => {
    targetWin.document.head.appendChild(node.cloneNode(true));
  });
}

function getPipContentRoot() {
  if (boardGroupModeActive && groupBoard) return groupBoard;
  return grid;
}

function restorePipContent() {
  const qrModal = document.getElementById("qrModal");
  const chat = document.getElementById("teacherChatForm");
  const root = getPipContentRoot();
  if (boardGroupModeActive && groupBoard) {
    document.body.insertBefore(groupBoard, qrModal);
    if (groupTeacherRow && tiles[TEACHER_SEAT]) {
      groupTeacherRow.appendChild(tiles[TEACHER_SEAT]);
    }
  } else {
    for (let i = 1; i <= TOTAL; i++) {
      if (tiles[i]) grid.appendChild(tiles[i]);
    }
  }
  document.body.insertBefore(chat, qrModal);
  if (boardGroupModeActive) applyGroupBoardLayout();
}

function mountPipContent(targetWin) {
  copyStylesToWindow(targetWin);
  targetWin.document.title = "우리반 칠판 (플로팅)";
  targetWin.document.documentElement.setAttribute(
    "data-theme",
    document.documentElement.getAttribute("data-theme") || "dark"
  );
  targetWin.document.body.classList.add("pip-mode");

  const listHeader = targetWin.document.createElement("div");
  listHeader.className = "pip-list-header";
  listHeader.innerHTML =
    '<span class="pip-col-no">번호</span><span class="pip-col-name">이름</span><span class="pip-col-hand"></span><span class="pip-col-msg">메시지</span>';

  const chat = document.getElementById("teacherChatForm");
  const root = getPipContentRoot();
  targetWin.document.body.append(listHeader, root, chat);
}

function openFloatingPopup() {
  const w = Math.min(480, window.screen.availWidth - 40);
  const h = Math.min(520, window.screen.availHeight - 80);
  const popup = window.open(
    "about:blank",
    "classroom_pip",
    `popup=yes,width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no,resizable=yes`
  );
  if (!popup) return null;
  return popup;
}

function openFloating() {
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }

  const canDocPip =
    !isInIframe() &&
    window.isSecureContext &&
    "documentPictureInPicture" in window;

  if (!canDocPip && !window.isSecureContext) {
    alert(
      "플로팅 창은 HTTPS 또는 localhost에서만 동작합니다.\n배포 주소(https://...)로 접속해 주세요."
    );
    return;
  }

  let opened = null;
  if (canDocPip) {
    window.documentPictureInPicture
      .requestWindow({
        width: Math.min(480, window.screen.availWidth - 40),
        height: Math.min(520, window.screen.availHeight - 80),
      })
      .then((win) => {
        pipWindow = win;
        mountPipContent(pipWindow);
        pipWindow.addEventListener("pagehide", () => {
          restorePipContent();
          pipWindow = null;
        });
      })
      .catch(() => {
        opened = openFloatingPopup();
        if (!opened) {
          alert(
            "플로팅 창을 열 수 없습니다.\n브라우저에서 팝업을 허용하거나, 크롬·엣지 최신 버전을 사용해 주세요."
          );
          return;
        }
        pipWindow = opened;
        mountPipContent(pipWindow);
        pipWindow.addEventListener("beforeunload", () => {
          restorePipContent();
          pipWindow = null;
        });
      });
    return;
  }

  opened = openFloatingPopup();
  if (!opened) {
    alert(
      "플로팅 창이 차단되었습니다.\n브라우저 주소창 옆에서 팝업을 허용한 뒤 다시 시도해 주세요."
    );
    return;
  }
  pipWindow = opened;
  mountPipContent(pipWindow);
  pipWindow.addEventListener("beforeunload", () => {
    restorePipContent();
    pipWindow = null;
  });
}

pipBtn.addEventListener("click", openFloating);

// ----- QR 모달 -----
const qrModal = document.getElementById("qrModal");
document.getElementById("qrBtn").addEventListener("click", async () => {
  const res = await fetch("/qr");
  const { url, dataUrl } = await res.json();
  document.getElementById("qrImg").src = dataUrl;
  document.getElementById("qrUrl").textContent = url;
  qrModal.classList.remove("hidden");
});
document.getElementById("qrClose").addEventListener("click", () =>
  qrModal.classList.add("hidden")
);
qrModal.addEventListener("click", (e) => {
  if (e.target === qrModal) qrModal.classList.add("hidden");
});

// ----- 사용 설명서 -----
const helpModal = document.getElementById("helpModal");
document.getElementById("helpBtn").addEventListener("click", () => {
  helpModal.classList.remove("hidden");
});
document.getElementById("helpClose").addEventListener("click", () =>
  helpModal.classList.add("hidden")
);
document.getElementById("helpCloseBtn").addEventListener("click", () =>
  helpModal.classList.add("hidden")
);
helpModal.addEventListener("click", (e) => {
  if (e.target === helpModal) helpModal.classList.add("hidden");
});

// ----- 우리반 학생 명단 -----
const rosterModal = document.getElementById("rosterModal");
const rosterList = document.getElementById("rosterList");
const rosterError = document.getElementById("rosterError");
const rosterSaveBtn = document.getElementById("rosterSave");
let savedRoster = {};

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function buildRosterForm(roster = {}) {
  rosterList.innerHTML = "";
  for (let i = 1; i <= 19; i++) {
    const row = document.createElement("div");
    row.className = "roster-row";
    const val = roster[i] || roster[String(i)] || "";
    row.innerHTML = `<span class="roster-no">${i}번</span><input type="text" data-seat="${i}" maxlength="12" placeholder="이름" value="${escapeAttr(val)}" autocomplete="off" />`;
    rosterList.appendChild(row);
  }
}

function openRosterModal() {
  rosterError.textContent = "";
  buildRosterForm(savedRoster);
  rosterModal.classList.remove("hidden");
}

function closeRosterModal() {
  rosterModal.classList.add("hidden");
  rosterError.textContent = "";
}

function collectRosterFromForm() {
  const roster = {};
  rosterList.querySelectorAll("input[data-seat]").forEach((inp) => {
    const v = inp.value.trim();
    if (v) roster[inp.dataset.seat] = v;
  });
  return roster;
}

document.getElementById("rosterBtn").addEventListener("click", () => {
  socket.emit("teacher:getRoster", (res) => {
    if (res && res.ok) savedRoster = res.roster || {};
    openRosterModal();
  });
});

rosterSaveBtn.addEventListener("click", () => {
  rosterError.textContent = "";
  rosterSaveBtn.disabled = true;
  socket.emit("teacher:setRoster", { roster: collectRosterFromForm() }, (res) => {
    rosterSaveBtn.disabled = false;
    if (res && res.ok) {
      savedRoster = res.roster || {};
      closeRosterModal();
      return;
    }
    rosterError.textContent = (res && res.error) || "저장에 실패했습니다.";
  });
});

document.getElementById("rosterClose").addEventListener("click", closeRosterModal);
document.getElementById("rosterCloseBtn").addEventListener("click", closeRosterModal);
rosterModal.addEventListener("click", (e) => {
  if (e.target === rosterModal) closeRosterModal();
});

socket.on("roster:data", (roster) => {
  savedRoster = roster || {};
});

// ===== 전체 질문 (화면 중앙) =====
const questionOverlay = document.getElementById("questionOverlay");
const questionText = document.getElementById("questionText");
const questionInput = document.getElementById("questionInput");

function showQuestion(q) {
  if (!q || !q.text) return;
  questionText.textContent = q.text;
  questionOverlay.classList.remove("hidden");
}
function hideQuestion() {
  questionOverlay.classList.add("hidden");
  questionText.textContent = "";
}

function clearQuestion() {
  socket.emit("teacher:clearQuestion");
  hideQuestion();
  questionInput.value = "";
}

document.getElementById("questionSend").addEventListener("click", () => {
  const text = questionInput.value.trim();
  if (!text) return;
  socket.emit("teacher:question", { text });
  showQuestion({ text });
  questionInput.value = "";
});
questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("questionSend").click();
});
document.getElementById("questionClear").addEventListener("click", clearQuestion);
document.getElementById("questionClose").addEventListener("click", clearQuestion);
document.getElementById("questionCloseBtn").addEventListener("click", clearQuestion);

socket.on("question:show", (q) => showQuestion(q));
socket.on("question:clear", () => hideQuestion());

// ===== 채팅 초기화 =====
document.getElementById("resetChatsBtn").addEventListener("click", async () => {
  if (
    await showConfirm(
      "교사 화면의 모든 채팅을 지울까요?\n(학생 휴대폰 화면은 그대로 남습니다.)",
      { okText: "초기화" }
    )
  ) {
    socket.emit("teacher:resetChats");
  }
});

// ===== 학생 패널 (채팅 기록 / 수정 / DM) =====
const studentPanel = document.getElementById("studentPanel");
const panelTitle = document.getElementById("panelTitle");
const panelLog = document.getElementById("panelLog");
const dmForm = document.getElementById("dmForm");
const dmInput = document.getElementById("dmInput");
let panelSeat = null;

function openPanel(seat, focusDm = false, focusPhoto = false) {
  panelSeat = seat;
  const name = tiles[seat].querySelector(".name").textContent;
  panelTitle.textContent = `${seat}번 · ${name}`;
  updatePanelPhotoPreview(seat);
  renderPanelLog();
  studentPanel.classList.remove("hidden");
  if (focusPhoto) setTimeout(() => panelPhotoPick.click(), 100);
  else if (focusDm) setTimeout(() => dmInput.focus(), 50);
}

function updatePanelPhotoPreview(seat) {
  const tile = tiles[seat];
  if (!tile || !panelPhotoImg || !panelPhotoEmoji) return;
  const imgEl = tile.querySelector(".avatar-photo");
  const hasPhoto = imgEl && !imgEl.classList.contains("hidden") && imgEl.src;
  if (hasPhoto) {
    panelPhotoImg.src = imgEl.src;
    panelPhotoImg.classList.remove("hidden");
    panelPhotoEmoji.classList.add("hidden");
  } else {
    panelPhotoImg.classList.add("hidden");
    panelPhotoImg.removeAttribute("src");
    panelPhotoEmoji.classList.remove("hidden");
    panelPhotoEmoji.textContent = SEAT_AVATAR[seat] || "🙂";
  }
}

function getTilePhotoBounds(seat) {
  const tile = tiles[seat];
  const area = tile?.querySelector(".video-area");
  const rect = area?.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = rect?.width
    ? Math.min(800, Math.max(160, Math.ceil(rect.width * dpr)))
    : 320;
  const height = rect?.height
    ? Math.min(800, Math.max(160, Math.ceil(rect.height * dpr)))
    : 240;
  return { width, height };
}

function resizeImageFile(file, seat) {
  const { width: maxW, height: maxH } = getTilePhotoBounds(seat);
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("not image"));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function applySeatPhoto(seat, photo) {
  const tile = tiles[seat];
  if (!tile) return;
  updateSeatPhoto(tile, seat, photo);
  if (panelSeat === seat && !studentPanel.classList.contains("hidden")) {
    updatePanelPhotoPreview(seat);
  }
}

function uploadSeatPhoto(seat, photo) {
  applySeatPhoto(seat, photo);
  socket.emit("teacher:setPhoto", { seat, photo }, (res) => {
    if (!res || !res.ok) {
      alert((res && res.error) || "프로필 사진을 저장하지 못했어요.");
      socket.emit("teacher:join");
    }
  });
}

function fmtTime(at) {
  try {
    return new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return "";
  }
}

function renderPanelLog() {
  const arr = (panelSeat && logs[panelSeat]) || [];
  panelLog.innerHTML = "";
  if (!arr.length) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "아직 채팅이 없어요.";
    panelLog.appendChild(empty);
    return;
  }
  arr.forEach((m) => {
    const item = document.createElement("div");
    item.className = "log-item";
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = m.text;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtTime(m.at);
    const speak = document.createElement("button");
    speak.textContent = "🔊";
    speak.title = "읽기";
    speak.addEventListener("click", () => {
      lowerHandIfRaised(panelSeat);
      speakText(m.text, tiles[panelSeat]);
    });
    const edit = document.createElement("button");
    edit.textContent = "✏️";
    edit.title = "수정";
    edit.addEventListener("click", () => startEdit(item, m));
    item.append(text, time, speak, edit);
    panelLog.appendChild(item);
  });
  panelLog.scrollTop = panelLog.scrollHeight;
}

function startEdit(item, m) {
  item.innerHTML = "";
  const input = document.createElement("input");
  input.className = "log-edit-input";
  input.value = m.text;
  const save = document.createElement("button");
  save.textContent = "💾";
  save.title = "저장";
  const commit = () => {
    const v = input.value.trim();
    if (v && v !== m.text) {
      socket.emit("teacher:editMsg", { seat: panelSeat, id: m.id, text: v });
      m.text = v;
    }
    renderPanelLog();
  };
  save.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") renderPanelLog();
  });
  item.append(input, save);
  input.focus();
}

dmForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = dmInput.value.trim();
  if (!text || !panelSeat) return;
  socket.emit("teacher:dm", { seat: panelSeat, text });
  dmInput.value = "";
  // 보냈다는 표시
  dmInput.placeholder = "보냈어요! 또 보낼 수 있어요";
  setTimeout(() => (dmInput.placeholder = "이 학생에게만 보낼 메시지"), 1500);
});

document.getElementById("panelClose").addEventListener("click", () =>
  studentPanel.classList.add("hidden")
);
studentPanel.addEventListener("click", (e) => {
  if (e.target === studentPanel) studentPanel.classList.add("hidden");
});

const panelPhotoInput = document.getElementById("panelPhotoInput");
const panelPhotoPick = document.getElementById("panelPhotoPick");
const panelPhotoClear = document.getElementById("panelPhotoClear");
const panelPhotoImg = document.getElementById("panelPhotoImg");
const panelPhotoEmoji = document.getElementById("panelPhotoEmoji");
let photoTargetSeat = null;

panelPhotoPick.addEventListener("click", () => {
  photoTargetSeat = panelSeat;
  panelPhotoInput.click();
});
panelPhotoInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  const seat = photoTargetSeat || panelSeat;
  photoTargetSeat = null;
  if (!file || !seat) return;
  try {
    const dataUrl = await resizeImageFile(file, seat);
    uploadSeatPhoto(seat, dataUrl);
  } catch (_) {
    alert("사진을 불러오지 못했어요. 다른 사진을 선택해 주세요.");
  }
  e.target.value = "";
});
panelPhotoClear.addEventListener("click", () => {
  if (!panelSeat) return;
  uploadSeatPhoto(panelSeat, null);
});

// ===== 타이머 + 종료 알람 =====
const timerMin = document.getElementById("timerMin");
const timerSec = document.getElementById("timerSec");
const timerDisplay = document.getElementById("timerDisplay");
const alarmOverlay = document.getElementById("alarmOverlay");
let timerRemaining = 0;
let timerInterval = null;

function renderTimer() {
  const m = Math.floor(timerRemaining / 60);
  const s = timerRemaining % 60;
  timerDisplay.textContent =
    String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  timerDisplay.classList.toggle("warning", timerRemaining <= 10 && timerRemaining > 0);
}

function startTimer() {
  // 사용자 클릭(제스처) 시점에 오디오를 미리 깨워둬야 종료 알람이 소리난다.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
  if (timerInterval) clearInterval(timerInterval);
  if (timerRemaining <= 0) {
    const m = Math.max(0, parseInt(timerMin.value, 10) || 0);
    const s = Math.max(0, Math.min(59, parseInt(timerSec.value, 10) || 0));
    timerRemaining = m * 60 + s;
  }
  if (timerRemaining <= 0) return;
  renderTimer();
  timerInterval = setInterval(() => {
    timerRemaining--;
    renderTimer();
    if (timerRemaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      fireAlarm();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function resetTimer() {
  stopTimer();
  const m = Math.max(0, parseInt(timerMin.value, 10) || 0);
  const s = Math.max(0, Math.min(59, parseInt(timerSec.value, 10) || 0));
  timerRemaining = m * 60 + s;
  renderTimer();
}

document.getElementById("timerStart").addEventListener("click", startTimer);
document.getElementById("timerStop").addEventListener("click", stopTimer);
document.getElementById("timerReset").addEventListener("click", resetTimer);
timerMin.addEventListener("change", resetTimer);
timerSec.addEventListener("change", resetTimer);
resetTimer();

// --- 아이폰 알람음(마림바 느낌)을 Web Audio로 합성해서 반복 재생 ---
let audioCtx = null;
let alarmTimer = null;

function playMarimbaNote(freq, startTime, duration) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // 마림바 같은 빠른 감쇠 엔벨로프
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.9, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playAlarmPattern() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // 아이폰 'Marimba'풍 짧은 모티프 (E5, B4, E5, B4 ...)
  const notes = [659.25, 493.88, 659.25, 783.99, 659.25, 493.88];
  notes.forEach((f, i) => playMarimbaNote(f, t + i * 0.18, 0.35));
}

function fireAlarm() {
  alarmOverlay.classList.remove("hidden");
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    playAlarmPattern();
    alarmTimer = setInterval(playAlarmPattern, 1300);
  } catch (_) {}
}

function stopAlarm() {
  if (alarmTimer) clearInterval(alarmTimer);
  alarmTimer = null;
  alarmOverlay.classList.add("hidden");
}

document.getElementById("alarmStop").addEventListener("click", stopAlarm);

// ===== 모둠 배치 =====
const groupModal = document.getElementById("groupModal");
const groupPool = document.getElementById("groupPool");
const groupZones = document.getElementById("groupZones");
const groupCountInput = document.getElementById("groupCountInput");

let groupLayoutState = {
  groupCount: 4,
  groups: [],
  activeOnBoard: false,
};

function groupStorageKey() {
  return teacherUserId ? `groupLayout_v1_${teacherUserId}` : "groupLayout_v1_guest";
}

function seatDisplayName(seat) {
  const tile = tiles[seat];
  const fromTile = tile?.querySelector(".name")?.textContent?.trim();
  if (fromTile && fromTile !== "빈 자리") return fromTile;
  return savedRoster[seat] || savedRoster[String(seat)] || `${seat}번`;
}

function defaultGroups(count) {
  const groups = [];
  for (let g = 1; g <= count; g++) {
    groups.push({ id: g, name: `${g}모둠`, seats: [] });
  }
  return groups;
}

function allStudentSeatsInLayout(layout) {
  const set = new Set();
  for (const g of layout.groups) {
    for (const s of g.seats) set.add(Number(s));
  }
  return set;
}

function normalizeGroupLayout(raw) {
  const count = Math.min(6, Math.max(2, parseInt(raw?.groupCount, 10) || 4));
  let groups = Array.isArray(raw?.groups) ? raw.groups : defaultGroups(count);
  while (groups.length < count) {
    groups.push({ id: groups.length + 1, name: `${groups.length + 1}모둠`, seats: [] });
  }
  groups = groups.slice(0, count).map((g, i) => ({
    id: i + 1,
    name: (g.name || `${i + 1}모둠`).trim(),
    seats: [...new Set((g.seats || []).map(Number).filter((s) => s >= 1 && s <= 19))],
  }));
  return { groupCount: count, groups, activeOnBoard: !!raw?.activeOnBoard };
}

function saveGroupLayoutToStorage() {
  try {
    localStorage.setItem(groupStorageKey(), JSON.stringify(groupLayoutState));
  } catch (_) {}
}

function loadGroupLayoutFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(groupStorageKey()) || "null");
    if (raw) groupLayoutState = normalizeGroupLayout(raw);
  } catch (_) {}
}

function createGroupChip(seat) {
  const chip = document.createElement("div");
  chip.className = "group-chip";
  chip.draggable = true;
  chip.dataset.seat = String(seat);
  const emoji = document.createElement("span");
  emoji.className = "group-chip-emoji";
  emoji.textContent = SEAT_AVATAR[seat] || "🙂";
  const name = document.createElement("span");
  name.className = "group-chip-name";
  name.textContent = `${seat}번 ${seatDisplayName(seat)}`;
  chip.append(emoji, name);
  chip.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/seat", String(seat));
    e.dataTransfer.effectAllowed = "move";
    chip.classList.add("dragging");
  });
  chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  return chip;
}

function setupDropZone(zoneEl, onDropSeat) {
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    zoneEl.classList.add("drag-over");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("drag-over"));
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.classList.remove("drag-over");
    const seat = Number(e.dataTransfer.getData("text/seat"));
    if (!seat || seat < 1 || seat > 19) return;
    onDropSeat(seat);
    renderGroupEditor();
  });
}

function renderGroupEditor() {
  const count = Math.min(6, Math.max(2, parseInt(groupCountInput.value, 10) || 4));
  groupCountInput.value = count;
  groupLayoutState.groupCount = count;
  while (groupLayoutState.groups.length < count) {
    groupLayoutState.groups.push({
      id: groupLayoutState.groups.length + 1,
      name: `${groupLayoutState.groups.length + 1}모둠`,
      seats: [],
    });
  }
  groupLayoutState.groups = groupLayoutState.groups.slice(0, count);

  groupZones.innerHTML = "";
  const assigned = allStudentSeatsInLayout(groupLayoutState);

  for (const group of groupLayoutState.groups) {
    const zone = document.createElement("div");
    zone.className = "group-zone";
    zone.innerHTML = `<div class="group-zone-head"><span class="group-zone-title">${escapeAttr(group.name)}</span><span class="group-zone-count">${group.seats.length}명</span></div>`;
    const desk = document.createElement("div");
    desk.className = "group-desk";
    for (const seat of group.seats) {
      desk.appendChild(createGroupChip(seat));
      assigned.add(seat);
    }
    setupDropZone(desk, (seat) => {
      for (const g of groupLayoutState.groups) {
        g.seats = g.seats.filter((s) => s !== seat);
      }
      if (!group.seats.includes(seat)) group.seats.push(seat);
    });
    zone.appendChild(desk);
    groupZones.appendChild(zone);
  }

  groupPool.innerHTML = "";
  const poolDesk = document.createElement("div");
  poolDesk.className = "group-desk group-desk-pool";
  for (let seat = 1; seat <= 19; seat++) {
    if (assigned.has(seat)) continue;
    poolDesk.appendChild(createGroupChip(seat));
  }
  setupDropZone(poolDesk, (seat) => {
    for (const g of groupLayoutState.groups) {
      g.seats = g.seats.filter((s) => s !== seat);
    }
  });
  groupPool.appendChild(poolDesk);
}

function openGroupModal() {
  groupCountInput.value = groupLayoutState.groupCount;
  renderGroupEditor();
  groupModal.classList.remove("hidden");
}

function closeGroupModal() {
  groupModal.classList.add("hidden");
}

function autoDistributeGroups() {
  const count = Math.min(6, Math.max(2, parseInt(groupCountInput.value, 10) || 4));
  groupLayoutState.groupCount = count;
  groupLayoutState.groups = defaultGroups(count);
  const seats = [];
  for (let i = 1; i <= 19; i++) seats.push(i);
  seats.forEach((seat, idx) => {
    groupLayoutState.groups[idx % count].seats.push(seat);
  });
  renderGroupEditor();
}

function resetGroupEditor() {
  groupLayoutState.groups = defaultGroups(groupLayoutState.groupCount);
  renderGroupEditor();
}

function restoreGridTiles() {
  for (let i = 1; i <= TOTAL; i++) {
    if (tiles[i]) grid.appendChild(tiles[i]);
  }
}

function applyGroupBoardLayout() {
  if (!groupClusters || !groupBoard) return;
  groupClusters.innerHTML = "";
  for (const group of groupLayoutState.groups) {
    const cluster = document.createElement("div");
    cluster.className = "group-cluster";
    cluster.innerHTML = `<div class="group-cluster-head"><span class="group-cluster-name">${escapeAttr(group.name)}</span><span class="group-cluster-meta">${group.seats.length}명</span></div>`;
    const table = document.createElement("div");
    table.className = "group-table";
    for (const seat of group.seats) {
      if (tiles[seat]) table.appendChild(tiles[seat]);
    }
    cluster.appendChild(table);
    groupClusters.appendChild(cluster);
  }
  if (groupTeacherRow && tiles[TEACHER_SEAT]) {
    groupTeacherRow.innerHTML = "";
    const label = document.createElement("div");
    label.className = "group-teacher-label";
    label.textContent = "👩‍🏫 선생님";
    groupTeacherRow.append(label, tiles[TEACHER_SEAT]);
  }
}

function enableGroupBoardMode() {
  boardGroupModeActive = true;
  groupLayoutState.activeOnBoard = true;
  document.body.classList.add("board-group-mode");
  groupBoard.classList.remove("hidden");
  groupBoard.setAttribute("aria-hidden", "false");
  applyGroupBoardLayout();
  saveGroupLayoutToStorage();
}

function disableGroupBoardMode() {
  boardGroupModeActive = false;
  groupLayoutState.activeOnBoard = false;
  document.body.classList.remove("board-group-mode");
  groupBoard.classList.add("hidden");
  groupBoard.setAttribute("aria-hidden", "true");
  restoreGridTiles();
  saveGroupLayoutToStorage();
}

fetch("/api/auth/me", { credentials: "include" })
  .then((r) => r.json())
  .then((data) => {
    if (data.ok) teacherUserId = data.userId;
    loadGroupLayoutFromStorage();
    if (groupLayoutState.activeOnBoard) enableGroupBoardMode();
  })
  .catch(() => {
    loadGroupLayoutFromStorage();
    if (groupLayoutState.activeOnBoard) enableGroupBoardMode();
  });

document.getElementById("groupBtn").addEventListener("click", openGroupModal);
document.getElementById("groupModalClose").addEventListener("click", closeGroupModal);
document.getElementById("groupModalCloseBtn").addEventListener("click", closeGroupModal);
groupModal.addEventListener("click", (e) => {
  if (e.target === groupModal) closeGroupModal();
});
document.getElementById("groupAutoBtn").addEventListener("click", autoDistributeGroups);
document.getElementById("groupResetBtn").addEventListener("click", resetGroupEditor);
groupCountInput.addEventListener("change", renderGroupEditor);
document.getElementById("groupSaveBtn").addEventListener("click", () => {
  saveGroupLayoutToStorage();
  closeGroupModal();
});
document.getElementById("groupShowBtn").addEventListener("click", () => {
  const count = Math.min(6, Math.max(2, parseInt(groupCountInput.value, 10) || 4));
  groupLayoutState.groupCount = count;
  saveGroupLayoutToStorage();
  enableGroupBoardMode();
  closeGroupModal();
});
document.getElementById("groupHideBtn").addEventListener("click", () => {
  disableGroupBoardMode();
  closeGroupModal();
});
