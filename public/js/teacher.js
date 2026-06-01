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
    tile.querySelector(".bubble").classList.remove("show");
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
    // 음소거되면 화면의 말풍선을 숨긴다.
    const bubble = tile.querySelector(".bubble");
    bubble.classList.remove("show");
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

function kickSeat(seat) {
  const tile = tiles[seat];
  const name = tile.querySelector(".name").textContent;
  if (confirm(`${seat}번 (${name}) 학생을 퇴장시킬까요?`)) {
    socket.emit("teacher:kick", { seat });
  }
}

function showBubble(tile, text, pop = true) {
  const bubble = tile.querySelector(".bubble");
  bubble.textContent = text;
  bubble.classList.add("show");
  if (pop) {
    bubble.classList.remove("pop");
    void bubble.offsetWidth; // 리플로우로 애니메이션 재시작
    bubble.classList.add("pop");
  }
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

function speakSeat(seat, tile) {
  if (mutedSeats[seat]) return; // 음소거된 학생은 읽지 않음
  speakText(lastMessages[seat], tile);
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
    if (t) t.querySelector(".bubble").classList.remove("show");
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
  if (!confirm("로그아웃할까요?")) return;
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (_) {}
  window.location.href = "/login";
});

// ----- 전체 강퇴 -----
const kickAllBtn = document.getElementById("kickAllBtn");
kickAllBtn.addEventListener("click", () => {
  if (confirm("모든 학생을 한 번에 내보낼까요?\n(자리는 비워지고, 각 학생 프로필은 저장돼요.)")) {
    socket.emit("teacher:kickAll");
  }
});

// ----- 라이트/다크 모드 -----
const themeBtn = document.getElementById("themeBtn");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = theme === "light" ? "☀️" : "🌙";
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

// ----- 플로팅 창 (Document Picture-in-Picture) -----
// PPT(슬라이드쇼) 위에도 떠 있는 작은 창으로 그리드를 보여준다.
const pipBtn = document.getElementById("pipBtn");

async function openFloating() {
  if (!window.isSecureContext) {
    alert(
      "플로팅 창은 보안 주소에서만 동작합니다.\n교사 화면을 'http://localhost:3000' 으로 열어 주세요.\n(IP 주소(http://10....)로 열면 동작하지 않습니다.)"
    );
    return;
  }
  if (!("documentPictureInPicture" in window)) {
    alert(
      "이 브라우저는 플로팅 창을 지원하지 않습니다.\n크롬 또는 엣지 최신 버전에서 이 페이지를 열어 주세요."
    );
    return;
  }
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }

  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: Math.min(480, window.screen.availWidth - 40),
      height: Math.min(520, window.screen.availHeight - 80),
    });
  } catch (err) {
    alert("플로팅 창을 여는 중 오류가 발생했습니다: " + err.message);
    return;
  }

  // 스타일 복사
  document
    .querySelectorAll('link[rel="stylesheet"], style')
    .forEach((node) => pipWindow.document.head.appendChild(node.cloneNode(true)));
  pipWindow.document.title = "우리반 채팅 (플로팅)";
  pipWindow.document.documentElement.setAttribute(
    "data-theme",
    document.documentElement.getAttribute("data-theme") || "dark"
  );
  pipWindow.document.body.classList.add("pip-mode");

  const listHeader = document.createElement("div");
  listHeader.className = "pip-list-header";
  listHeader.innerHTML =
    '<span class="pip-col-no">번호</span><span class="pip-col-name">이름</span><span class="pip-col-hand"></span><span class="pip-col-msg">메시지</span>';

  // 그리드와 선생님 입력창을 플로팅 창으로 이동
  const grid = document.getElementById("grid");
  const chat = document.getElementById("teacherChatForm");
  pipWindow.document.body.append(listHeader, grid, chat);

  // 창이 닫히면 원래 위치로 되돌린다.
  pipWindow.addEventListener("pagehide", () => {
    const qrModal = document.getElementById("qrModal");
    document.body.insertBefore(grid, qrModal);
    document.body.insertBefore(chat, qrModal);
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
document.getElementById("resetChatsBtn").addEventListener("click", () => {
  if (confirm("교사 화면의 모든 채팅을 지울까요?\n(학생 휴대폰 화면은 그대로 남습니다.)")) {
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
    speak.addEventListener("click", () => speakText(m.text, tiles[panelSeat]));
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
