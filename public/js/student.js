const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 4000,
});

// 화면이 다시 보이거나(잠금 해제/탭 복귀) 인터넷이 돌아오면 즉시 재연결한다.
// (모바일은 백그라운드에서 JS가 멈춰 연결이 끊길 수 있는데, 돌아오면 바로 복구)
function ensureConnected() {
  if (socket.disconnected) socket.connect();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") ensureConnected();
});
window.addEventListener("online", ensureConnected);
window.addEventListener("focus", ensureConnected);
window.addEventListener("pageshow", ensureConnected);

const joinView = document.getElementById("joinView");
const chatView = document.getElementById("chatView");
const nameInput = document.getElementById("nameInput");
const seatInput = document.getElementById("seatInput");
const joinBtn = document.getElementById("joinBtn");
const joinError = document.getElementById("joinError");
const myInfo = document.getElementById("myInfo");
const chatLog = document.getElementById("chatLog");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const raiseHandBtn = document.getElementById("raiseHandBtn");
const joinStatus = document.getElementById("joinStatus");
const muteBanner = document.getElementById("muteBanner");
const kickedOverlay = document.getElementById("kickedOverlay");
const themeBtn = document.getElementById("themeBtn");
const questionOverlay = document.getElementById("questionOverlay");
const questionText = document.getElementById("questionText");
const profilePhotoBtn = document.getElementById("profilePhotoBtn");
const profilePhotoInput = document.getElementById("profilePhotoInput");
const profilePhotoImg = document.getElementById("profilePhotoImg");
const profilePhotoEmoji = document.getElementById("profilePhotoEmoji");

const SEAT_AVATAR = {
  1: "👸", 2: "🧚‍♀️", 3: "🦸‍♀️", 4: "👩‍🚀", 5: "👩‍🍳",
  6: "👨‍🚀", 7: "👩‍🎤", 8: "🧜‍♀️", 9: "🦸‍♂️", 10: "🧙‍♂️",
  11: "🥷", 12: "🧝‍♀️", 13: "🤴", 14: "👩‍🎨", 15: "👩‍⚕️",
  16: "👩‍🚒", 17: "👨‍🍳", 18: "👨‍🎤", 19: "👨‍🚒",
};

let mySeat = null;
let myName = null;
let myPhoto = null;
let isMuted = false;
let isKicked = false;
let active = false; // 한 번이라도 참여에 성공했는지
let joined = false; // 서버에 등록 완료 여부 (채팅 가능)
let handRaised = false;
let pendingChat = null;

// 예전 QR(?room=...) 북마크 정리
if (window.location.search.includes("room=")) {
  history.replaceState({}, "", "/student");
}

// 기기 고유 ID (재연결/새로고침 시 같은 자리를 되찾기 위함)
const clientId = (() => {
  let id = localStorage.getItem("chatClientId");
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("chatClientId", id);
  }
  return id;
})();

// ----- 라이트/다크 모드 -----
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeBtn.textContent = theme === "light" ? "☀️" : "🌙";
  localStorage.setItem("theme", theme);
}
applyTheme(localStorage.getItem("theme") || "dark");
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "light" ? "dark" : "light");
});

function setJoined(on) {
  joined = on;
  chatInput.disabled = !on || isKicked;
  chatSendBtn.disabled = !on || isKicked;
  raiseHandBtn.disabled = !on || isKicked;
  joinStatus.classList.toggle("hidden", on || !active);
  if (on) chatInput.placeholder = "칠판에 쓸 메시지를 입력하세요";
  else if (active) chatInput.placeholder = "연결 중... 잠시만 기다려 주세요";
}

function updateHandBtn(raised) {
  handRaised = !!raised;
  raiseHandBtn.classList.toggle("active", handRaised);
  raiseHandBtn.querySelector(".raise-hand-label").textContent = handRaised ? "손 내리기" : "손들기";
}

function toggleRaiseHand() {
  if (!joined || isKicked) return;
  socket.emit("student:raiseHand", { raised: !handRaised, clientId }, (res) => {
    if (res && res.ok) updateHandBtn(res.handRaised);
    else if (res && res.error) {
      doJoin(myName, mySeat, { auto: true });
    }
  });
}

function showQuestion(q) {
  if (!q || !q.text) return;
  questionText.textContent = q.text;
  questionOverlay.classList.remove("hidden");
}
function hideQuestion() {
  questionOverlay.classList.add("hidden");
  questionText.textContent = "";
}

function appendMyMsg(text) {
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.textContent = text;
  chatLog.appendChild(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat(text) {
  if (!text || isKicked) return;
  if (!joined) {
    pendingChat = text;
    joinStatus.classList.remove("hidden");
    joinStatus.textContent = "교실에 연결하는 중...";
    return;
  }
  socket.emit("student:chat", { text, clientId }, (res) => {
    if (res && res.ok) {
      appendMyMsg(text);
      return;
    }
    if (res && res.error === "muted") {
      appendMyMsg(text);
      return;
    }
    if (res && res.error === "not_joined") {
      pendingChat = text;
      setJoined(false);
      joinStatus.textContent = "다시 연결하는 중...";
      doJoin(myName, mySeat, { auto: true });
      return;
    }
    joinStatus.classList.remove("hidden");
    joinStatus.textContent = "메시지 전송 실패. 다시 시도해 주세요.";
  });
}
function showChatView() {
  myInfo.textContent = `${mySeat}번 · ${myName}`;
  updateMyPhoto(myPhoto);
  joinView.classList.add("hidden");
  chatView.classList.remove("hidden");
  if (!joined) {
    joinStatus.classList.remove("hidden");
    joinStatus.textContent = "교실에 연결하는 중...";
  }
}
function showJoinView() {
  chatView.classList.add("hidden");
  joinView.classList.remove("hidden");
  setJoined(false);
}

function updateMyPhoto(photo) {
  myPhoto = photo || null;
  if (myPhoto) {
    profilePhotoImg.src = myPhoto;
    profilePhotoImg.classList.remove("hidden");
    profilePhotoEmoji.classList.add("hidden");
  } else {
    profilePhotoImg.classList.add("hidden");
    profilePhotoImg.removeAttribute("src");
    profilePhotoEmoji.classList.remove("hidden");
    profilePhotoEmoji.textContent = SEAT_AVATAR[mySeat] || "🙂";
  }
}

function resizeImageFile(file) {
  const maxW = 320;
  const maxH = 320;
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("not image"));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
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

function uploadMyPhoto(photo) {
  updateMyPhoto(photo);
  socket.emit("student:setPhoto", { photo }, (res) => {
    if (!res || !res.ok) {
      alert((res && res.error) || "프로필 사진을 저장하지 못했어요.");
      socket.emit("student:join", { name: myName, seat: mySeat, clientId }, (joinRes) => {
        if (joinRes && joinRes.ok) updateMyPhoto(joinRes.photo);
      });
    }
  });
}

// 실제 참여 요청. opts.auto=true 면 재연결/복원용(실패해도 조용히 참여 화면으로).
function doJoin(name, seatRaw, opts = {}) {
  setJoined(false);
  socket.emit("student:join", { name, seat: seatRaw, clientId }, (res) => {
    if (!opts.auto) joinBtn.disabled = false;
    if (!res || !res.ok) {
      setJoined(false);
      if (opts.auto) {
        active = false;
        localStorage.removeItem("chatSession");
        showJoinView();
      } else {
        joinError.textContent = (res && res.error) || "참여에 실패했습니다.";
      }
      return;
    }
    active = true;
    mySeat = res.seat;
    myName = res.name;
    myPhoto = res.photo || null;
    isMuted = !!res.muted;
    muteBanner.classList.toggle("hidden", !isMuted);
    localStorage.setItem("chatSession", JSON.stringify({ name: myName, seat: mySeat }));
    showChatView();
    setJoined(true);
    updateHandBtn(!!res.handRaised);
    if (res.question) showQuestion(res.question);
    if (!opts.auto) chatInput.focus();
    if (pendingChat) {
      const t = pendingChat;
      pendingChat = null;
      sendChat(t);
    }
  });
}

function join() {
  const name = nameInput.value.trim();
  const seatRaw = seatInput.value.trim();
  if (!name) {
    joinError.textContent = "이름을 입력해 주세요.";
    return;
  }
  if (seatRaw !== "") {
    const n = Number(seatRaw);
    if (!Number.isInteger(n) || n < 1 || n > 19) {
      joinError.textContent = "번호는 1~19 사이로 입력해 주세요.";
      return;
    }
  }
  joinBtn.disabled = true;
  joinError.textContent = "";
  doJoin(name, seatRaw, {});
}

// 새로고침 후 저장된 세션 자동 복원
(function restoreSession() {
  if (isKicked) return;
  try {
    const saved = JSON.parse(localStorage.getItem("chatSession") || "null");
    if (saved && saved.name) {
      active = true;
      myName = saved.name;
      mySeat = saved.seat;
      showChatView();
    }
  } catch (_) {}
})();

// 최초 연결 + 재연결 때마다, 이미 참여한 적이 있으면 같은 자리로 자동 재참여
socket.on("connect", () => {
  if (active && myName && !isKicked) {
    doJoin(myName, mySeat, { auto: true });
  }
});

joinBtn.addEventListener("click", join);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join();
});
seatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") join();
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (isKicked) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  sendChat(text);
  chatInput.focus();
});

// 교사가 보낸 다이렉트 메시지
socket.on("teacher:dm", ({ text }) => {
  const wrap = document.createElement("div");
  wrap.className = "msg-teacher";
  wrap.innerHTML = `<span class="dm-from">👩‍🏫 선생님</span>${escapeHtml(text)}`;
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// 교사가 음소거/해제
socket.on("you:muted", ({ muted }) => {
  isMuted = muted;
  muteBanner.classList.toggle("hidden", !muted);
});

// 프로필 사진 변경 (선생님 또는 본인)
socket.on("you:photo", ({ photo }) => {
  updateMyPhoto(photo);
});

socket.on("question:show", (q) => showQuestion(q));
socket.on("question:clear", () => hideQuestion());

document.getElementById("questionClose").addEventListener("click", hideQuestion);
document.getElementById("questionCloseBtn").addEventListener("click", hideQuestion);

socket.on("you:handLowered", () => updateHandBtn(false));

raiseHandBtn.addEventListener("click", toggleRaiseHand);

profilePhotoBtn.addEventListener("click", () => {
  if (isKicked) return;
  profilePhotoInput.click();
});
profilePhotoInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || isKicked) return;
  try {
    const dataUrl = await resizeImageFile(file);
    uploadMyPhoto(dataUrl);
  } catch (_) {
    alert("사진을 불러오지 못했어요. 다른 사진을 선택해 주세요.");
  }
});

// 교사가 퇴장 → 자동 복귀하지 않도록 세션 정리
socket.on("you:kicked", () => {
  isKicked = true;
  active = false;
  setJoined(false);
  localStorage.removeItem("chatSession");
  kickedOverlay.classList.remove("hidden");
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
});
