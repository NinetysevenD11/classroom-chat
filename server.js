import express from "express";
import session from "express-session";
import { createServer } from "http";
import { Server } from "socket.io";
import qrcode from "qrcode";
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import {
  initStorage,
  users,
  studentProfiles,
  sessionSecret,
  saveUser,
  saveStudentProfilesData,
  getClassRoster,
  saveClassRoster,
  deleteUser,
  isAdminUserId,
  recordLogin,
  getLastLoginByUser,
  getRecentLoginLogs,
  ensureAdminAccount,
} from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const STUDENT_SEATS = 19; // 1~19번은 학생, 20번은 교사
const TEACHER_SEAT = 20;

// 인터넷 어디서든 접속 가능하게 해주는 공개 터널 주소 (cloudflared가 만들어 줌)
let publicUrl = null;

const app = express();
const httpServer = createServer(app);
// 모바일에서 잠깐 끊겨도 쉽게 튕기지 않도록 ping 타임아웃을 넉넉히 둔다.
const io = new Server(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ----- 학생 프로필 (교사별, 번호+이름으로 저장) -----
function profileKey(seat, name) {
  const n = String(name || "").trim();
  if (!n) return null;
  return `${Number(seat)}:${n}`;
}

function getStudentProfile(userId, seat, name) {
  const key = profileKey(seat, name);
  if (!key || !studentProfiles[userId]) return null;
  return studentProfiles[userId][key] || null;
}

function setStudentProfilePhoto(userId, seat, name, photo) {
  const key = profileKey(seat, name);
  if (!key) return;
  if (!studentProfiles[userId]) studentProfiles[userId] = {};
  if (photo) {
    studentProfiles[userId][key] = {
      name: String(name).trim(),
      seat: Number(seat),
      photo,
    };
  } else {
    delete studentProfiles[userId][key];
    if (!Object.keys(studentProfiles[userId]).length) delete studentProfiles[userId];
  }
  saveStudentProfilesData().catch((err) => console.error("[저장] 프로필 저장 실패:", err));
}

function validatePhotoData(photo) {
  if (!photo) return null;
  if (typeof photo !== "string" || !photo.startsWith("data:image/")) {
    return "올바른 이미지 형식이 아니에요.";
  }
  if (photo.length > 800000) {
    return "사진이 너무 커요. 다른 사진을 선택해 주세요.";
  }
  return null;
}

function loadSeatProfilePhoto(userId, seat, name) {
  return getStudentProfile(userId, seat, name)?.photo || null;
}

function applyStudentPhoto(room, userId, seat, photo) {
  const s = room.seats[seat];
  if (!s || !s.name) {
    return { ok: false, error: "참여 중인 학생만 프로필을 설정할 수 있어요." };
  }
  const err = validatePhotoData(photo);
  if (photo && err) return { ok: false, error: err };
  s.photo = photo || null;
  setStudentProfilePhoto(userId, seat, s.name, s.photo);
  notifyTeachers(userId, "seat:update", { seat, data: s });
  const sid = room.seatSocket[seat];
  if (sid) io.to(sid).emit("you:photo", { photo: s.photo });
  return { ok: true, photo: s.photo };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function makeUser(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    salt,
    hash: hashPassword(password, salt),
    plainPassword: password,
  };
}
function verifyPassword(password, user) {
  if (!user) return false;
  const h = Buffer.from(hashPassword(password, user.salt), "hex");
  const stored = Buffer.from(user.hash, "hex");
  return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (req.session?.userId && isAdminUserId(req.session.userId)) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(403).json({ ok: false, error: "관리자 권한이 필요합니다." });
  }
  res.redirect("/login");
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || null;
}

// ----- 교실 (선생님 계정별, 입장 코드 없음) -----
// rooms[userId] = { seats, socketSeat, seatSocket }
const rooms = {};
let activeTeacherId = null; // 현재 접속 중인 선생님 (학생은 여기로 자동 입장)

function getRoomForUser(userId) {
  if (!userId || !users[userId]) return null;
  if (!rooms[userId]) {
    rooms[userId] = { seats: initSeats(), socketSeat: {}, seatSocket: {} };
  }
  return rooms[userId];
}

function teacherChannel(userId) {
  return `teacher:${userId}`;
}

function isTeacherOnline(userId) {
  const ch = io.sockets.adapter.rooms.get(teacherChannel(userId));
  return !!(ch && ch.size > 0);
}

function buildAdminOverview() {
  const lastLogin = getLastLoginByUser();
  const teachers = Object.keys(users)
    .filter((id) => !isAdminUserId(id))
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((id) => {
      const roster = getClassRoster(id);
      const students = [];
      for (let seat = 1; seat <= STUDENT_SEATS; seat++) {
        const name = roster[seat] || roster[String(seat)];
        if (name) students.push({ seat, name });
      }
      students.sort((a, b) => a.seat - b.seat);
      return {
        id,
        password: users[id]?.plainPassword || null,
        lastLoginAt: lastLogin[id] || null,
        teacherOnline: isTeacherOnline(id),
        rosterCount: students.length,
        students,
      };
    });

  return {
    teachers,
    recentLogins: getRecentLoginLogs(100).map((e) => ({
      ...e,
      isAdmin: isAdminUserId(e.userId),
    })),
    activeTeacherId: activeTeacherId && !isAdminUserId(activeTeacherId) ? activeTeacherId : null,
  };
}

function getTeacherUserId(socket) {
  if (socket.data?.role === "teacher" && socket.data?.userId) {
    return socket.data.userId;
  }
  const session = socket.request.session;
  if (!session?.userId) return null;
  return users[session.userId] ? session.userId : null;
}

function findTeacherRoom() {
  // 접속 중인 선생님 채널 찾기 (activeTeacherId만 믿지 않음)
  for (const userId of Object.keys(rooms)) {
    const ch = io.sockets.adapter.rooms.get(teacherChannel(userId));
    if (ch && ch.size > 0) {
      return { userId, room: rooms[userId] };
    }
  }
  if (activeTeacherId && rooms[activeTeacherId]) {
    return { userId: activeTeacherId, room: rooms[activeTeacherId] };
  }
  return null;
}

// Render 등 프록시 뒤에서 https/host를 올바르게 인식
app.set("trust proxy", 1);

const isProd = process.env.NODE_ENV === "production";

await initStorage();
await ensureAdminAccount(makeUser);

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12, secure: isProd, sameSite: "lax" }, // 12시간 유지
});

app.use(express.json());
app.use(sessionMiddleware);
// 같은 세션을 Socket.IO에서도 읽을 수 있게 공유 (교사 소켓이 자기 교실을 식별)
io.engine.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

// 로그인 페이지
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// 회원가입 (아이디 + 비밀번호만)
app.post("/api/signup", async (req, res) => {
  const id = (req.body && req.body.id || "").trim();
  const password = (req.body && req.body.password) || "";
  if (!id || !password) return res.json({ ok: false, error: "아이디와 비밀번호를 입력하세요." });
  if (id.length < 3) return res.json({ ok: false, error: "아이디는 3자 이상이어야 합니다." });
  if (password.length < 4) return res.json({ ok: false, error: "비밀번호는 4자 이상이어야 합니다." });
  if (users[id]) return res.json({ ok: false, error: "이미 존재하는 아이디입니다." });
  const reservedAdmin = (process.env.ADMIN_ID || "").trim();
  if (reservedAdmin && id === reservedAdmin) {
    return res.json({ ok: false, error: "사용할 수 없는 아이디입니다." });
  }
  if (isAdminUserId(id)) return res.json({ ok: false, error: "사용할 수 없는 아이디입니다." });
  const u = makeUser(password);
  try {
    await saveUser(id, u);
    req.session.userId = id;
    await recordLogin(id, { ip: clientIp(req) });
    res.json({ ok: true, isAdmin: false });
  } catch (err) {
    console.error("[저장] 회원가입 저장 실패:", err);
    res.json({ ok: false, error: "회원 정보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

// 로그인
app.post("/api/login", async (req, res) => {
  const id = (req.body && req.body.id || "").trim();
  const password = (req.body && req.body.password) || "";
  if (!verifyPassword(password, users[id])) {
    return res.json({ ok: false, error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  }
  req.session.userId = id;
  try {
    await recordLogin(id, { ip: clientIp(req) });
  } catch (err) {
    console.error("[저장] 로그인 기록 실패:", err);
  }
  res.json({ ok: true, isAdmin: isAdminUserId(id) });
});

// 로그아웃
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// 관리자 대시보드
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/api/admin/overview", requireAdmin, (req, res) => {
  res.json({ ok: true, ...buildAdminOverview() });
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  const userId = (req.body?.userId || "").trim();
  const password = req.body?.password || "";
  if (!userId || !password) {
    return res.json({ ok: false, error: "아이디와 새 비밀번호를 입력하세요." });
  }
  if (password.length < 4) {
    return res.json({ ok: false, error: "비밀번호는 4자 이상이어야 합니다." });
  }
  if (!users[userId]) {
    return res.json({ ok: false, error: "존재하지 않는 계정입니다." });
  }
  if (isAdminUserId(userId) && userId !== req.session.userId) {
    return res.json({ ok: false, error: "다른 관리자 비밀번호는 환경 변수로만 변경할 수 있습니다." });
  }
  try {
    const u = makeUser(password);
    if (users[userId].isAdmin) u.isAdmin = true;
    await saveUser(userId, u);
    res.json({ ok: true, password });
  } catch (err) {
    console.error("[관리자] 비밀번호 변경 실패:", err);
    res.json({ ok: false, error: "비밀번호를 저장하지 못했습니다." });
  }
});

app.post("/api/admin/delete-user", requireAdmin, async (req, res) => {
  const userId = (req.body?.userId || "").trim();
  if (!userId) return res.json({ ok: false, error: "아이디를 입력하세요." });
  if (!users[userId]) return res.json({ ok: false, error: "존재하지 않는 계정입니다." });
  if (isAdminUserId(userId)) {
    return res.json({ ok: false, error: "관리자 계정은 탈퇴할 수 없습니다." });
  }
  try {
    purgeTeacherSession(userId);
    await deleteUser(userId);
    if (activeTeacherId === userId) activeTeacherId = null;
    res.json({ ok: true });
  } catch (err) {
    console.error("[관리자] 탈퇴 처리 실패:", err);
    res.json({ ok: false, error: "탈퇴 처리에 실패했습니다." });
  }
});

function purgeTeacherSession(userId) {
  const room = rooms[userId];
  if (!room) return;
  for (let i = 1; i <= STUDENT_SEATS; i++) {
    const sid = room.seatSocket[i];
    if (sid) {
      io.to(sid).emit("you:kicked");
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
  const ch = io.sockets.adapter.rooms.get(teacherChannel(userId));
  if (ch) {
    for (const sid of ch) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
  delete rooms[userId];
}

// 교사 화면(로그인 필요, 관리자는 관리 페이지로)
app.get("/", requireAuth, (req, res) => {
  if (isAdminUserId(req.session.userId)) {
    return res.redirect("/admin");
  }
  res.sendFile(path.join(__dirname, "views", "teacher.html"));
});

function notifyTeachers(userId, event, data) {
  io.to(teacherChannel(userId)).emit(event, data);
}

function broadcastToStudents(userId, event, data) {
  const room = rooms[userId];
  if (!room) return;
  for (const sid of Object.values(room.seatSocket)) {
    if (sid) io.to(sid).emit(event, data);
  }
}

function resolveStudentContext(socket, clientId) {
  let userId = socket.data.userId;
  let room = userId && rooms[userId];
  if (!room) {
    const found = findTeacherRoom();
    if (found) {
      userId = found.userId;
      room = found.room;
      socket.data.userId = userId;
      socket.data.role = "student";
    }
  }
  if (!room) return { userId: null, room: null, seat: null };

  let seat = room.socketSeat[socket.id];
  if (!seat && clientId) {
    const ownedKey = Object.keys(room.seats).find((i) => room.seats[i].clientId === clientId);
    if (ownedKey) {
      seat = Number(ownedKey);
      const oldSid = room.seatSocket[seat];
      if (oldSid && oldSid !== socket.id) delete room.socketSeat[oldSid];
      room.seats[seat].online = true;
      room.socketSeat[socket.id] = seat;
      room.seatSocket[seat] = socket.id;
      notifyTeachers(userId, "seat:update", { seat, data: room.seats[seat] });
    }
  }
  return { userId, room, seat };
}

// 예전 QR(?room=코드)로 들어온 경우 주소 정리
app.get("/student", (req, res) => {
  if (req.query.room) return res.redirect(302, "/student");
  res.sendFile(path.join(__dirname, "public", "student.html"));
});

// 접속 가능한 로컬 네트워크 IP 찾기
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

// 학생 참여용 QR 코드
app.get("/qr", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (isAdminUserId(userId)) return res.status(403).json({ error: "관리자 계정은 QR을 사용할 수 없습니다." });
  if (!users[userId]) return res.status(401).json({ error: "로그인이 필요합니다." });
  let base;
  if (publicUrl) base = publicUrl;
  else if (process.env.PUBLIC_URL) base = process.env.PUBLIC_URL;
  else base = `${req.protocol}://${req.get("host")}`;
  const url = `${base}/student`;
  try {
    const dataUrl = await qrcode.toDataURL(url, { width: 320, margin: 1 });
    res.json({ url, dataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- 교실별 좌석 상태 -----

function emptySeat() {
  return {
    name: null,
    online: false,
    muted: false,
    clientId: null,
    lastMessage: null,
    messages: [],
    photo: null,
    handRaised: false,
  };
}

function clearOccupant(seatData) {
  Object.assign(seatData, emptySeat());
}

function initSeats() {
  const seats = {};
  for (let i = 1; i <= STUDENT_SEATS; i++) seats[i] = emptySeat();
  return seats;
}

function nextFreeSeat(seats) {
  for (let i = 1; i <= STUDENT_SEATS; i++) {
    if (!seats[i].name) return i;
  }
  return null;
}

function normalizeRoster(raw) {
  const roster = {};
  if (!raw || typeof raw !== "object") return roster;
  for (let i = 1; i <= STUDENT_SEATS; i++) {
    const name = String(raw[i] ?? raw[String(i)] ?? "").trim().slice(0, 12);
    if (name) roster[i] = name;
  }
  return roster;
}

function rosterHasEntries(roster) {
  return Object.keys(roster).some((k) => roster[k]);
}

function validateStudentAgainstRoster(userId, seat, name) {
  const roster = getClassRoster(userId);
  if (!rosterHasEntries(roster)) return null;

  const expected = roster[seat];
  if (!expected) {
    return `${seat}번은 우리반 명단에 없어요. 선생님께 확인해 주세요.`;
  }
  if (expected !== name) {
    return `${seat}번 자리는 '${expected}' 학생이에요. 이름을 확인해 주세요.`;
  }
  return null;
}

io.on("connection", (socket) => {
  socket.on("teacher:join", () => {
    const userId = getTeacherUserId(socket);
    const room = userId && getRoomForUser(userId);
    if (!room) return;
    socket.data.userId = userId;
    socket.data.role = "teacher";
    activeTeacherId = userId;
    socket.join(teacherChannel(userId));
    socket.emit("state", room.seats);
    socket.emit("roster:data", getClassRoster(userId));
    if (room.activeQuestion) socket.emit("question:show", room.activeQuestion);
  });

  socket.on("teacher:getRoster", (cb) => {
    const userId = getTeacherUserId(socket);
    if (!userId) {
      cb && cb({ ok: false, error: "로그인이 필요합니다." });
      return;
    }
    cb && cb({ ok: true, roster: getClassRoster(userId) });
  });

  socket.on("teacher:setRoster", async ({ roster }, cb) => {
    const userId = getTeacherUserId(socket);
    if (!userId) {
      cb && cb({ ok: false, error: "로그인이 필요합니다." });
      return;
    }
    try {
      const normalized = normalizeRoster(roster);
      await saveClassRoster(userId, normalized);
      cb && cb({ ok: true, roster: normalized });
    } catch (err) {
      console.error("[저장] 명단 저장 실패:", err);
      cb && cb({ ok: false, error: "명단을 저장하지 못했습니다." });
    }
  });

  socket.on("student:join", ({ name, seat, clientId }, cb) => {
    const found = findTeacherRoom();
    if (!found) {
      cb && cb({ ok: false, error: "선생님이 아직 접속하지 않았어요. 선생님 화면을 켠 뒤 다시 시도해 주세요." });
      return;
    }
    const { userId, room } = found;
    const { seats, socketSeat, seatSocket } = room;
    socket.data.userId = userId;
    socket.data.role = "student";

    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      cb && cb({ ok: false, error: "이름을 입력해 주세요." });
      return;
    }

    const chosen = Number(seat);
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > STUDENT_SEATS) {
      cb && cb({ ok: false, error: `번호는 1~${STUDENT_SEATS} 사이로 입력해 주세요.` });
      return;
    }
    if (seats[chosen].online) {
      cb && cb({ ok: false, error: `${chosen}번은 이미 사용 중이에요. 다른 번호를 입력해 주세요.` });
      return;
    }

    const rosterError = validateStudentAgainstRoster(userId, chosen, trimmedName);
    if (rosterError) {
      cb && cb({ ok: false, error: rosterError });
      return;
    }

    if (clientId) {
      for (let i = 1; i <= STUDENT_SEATS; i++) {
        if (i !== chosen && seats[i].clientId === clientId) {
          clearOccupant(seats[i]);
          delete seatSocket[i];
          notifyTeachers(userId, "seat:update", { seat: i, data: seats[i] });
        }
      }
    }

    if (!seats[chosen].online) {
      seats[chosen].messages = [];
      seats[chosen].lastMessage = null;
      seats[chosen].handRaised = false;
    }
    seats[chosen].name = trimmedName.slice(0, 12);
    seats[chosen].online = true;
    seats[chosen].muted = false;
    seats[chosen].clientId = clientId || null;
    seats[chosen].photo = loadSeatProfilePhoto(userId, chosen, seats[chosen].name);
    socketSeat[socket.id] = chosen;
    seatSocket[chosen] = socket.id;
    cb &&
      cb({
        ok: true,
        seat: chosen,
        name: seats[chosen].name,
        muted: false,
        photo: seats[chosen].photo,
        handRaised: false,
        question: room.activeQuestion || null,
      });
    notifyTeachers(userId, "seat:update", { seat: chosen, data: seats[chosen] });
  });

  socket.on("student:chat", ({ text, clientId }, cb) => {
    const { userId, room, seat } = resolveStudentContext(socket, clientId);
    if (!room || !text) {
      cb && cb({ ok: false, error: "연결되지 않았어요. 잠시 후 다시 시도해 주세요." });
      return;
    }
    if (!seat) {
      cb && cb({ ok: false, error: "not_joined" });
      return;
    }
    if (room.seats[seat].muted) {
      cb && cb({ ok: false, error: "muted" });
      return;
    }
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: String(text).slice(0, 200),
      at: Date.now(),
    };
    room.seats[seat].messages.push(message);
    room.seats[seat].lastMessage = message;
    notifyTeachers(userId, "seat:chat", { seat, message });
    cb && cb({ ok: true });
  });

  socket.on("teacher:resetChats", () => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room) return;
    for (let i = 1; i <= STUDENT_SEATS; i++) {
      room.seats[i].messages = [];
      room.seats[i].lastMessage = null;
    }
    notifyTeachers(userId, "chats:reset");
  });

  socket.on("teacher:dm", ({ seat, text }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room || !text) return;
    const sid = room.seatSocket[seat];
    if (sid) io.to(sid).emit("teacher:dm", { text: String(text).slice(0, 200) });
  });

  socket.on("teacher:editMsg", ({ seat, id, text }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room || !text) return;
    const s = room.seats[seat];
    if (!s) return;
    const clean = String(text).slice(0, 200);
    const m = s.messages.find((x) => x.id === id);
    if (m) m.text = clean;
    if (s.lastMessage && s.lastMessage.id === id) s.lastMessage.text = clean;
    notifyTeachers(userId, "seat:msgEdited", {
      seat,
      id,
      text: clean,
      lastIsThis: !!(s.lastMessage && s.lastMessage.id === id),
    });
  });

  socket.on("teacher:chat", ({ text }) => {
    const userId = getTeacherUserId(socket);
    if (!userId || !text) return;
    const message = { text: String(text).slice(0, 200), at: Date.now() };
    notifyTeachers(userId, "seat:chat", { seat: TEACHER_SEAT, message });
  });

  socket.on("teacher:question", ({ text }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room || !text) return;
    const q = { text: String(text).slice(0, 300), at: Date.now() };
    room.activeQuestion = q;
    notifyTeachers(userId, "question:show", q);
    broadcastToStudents(userId, "question:show", q);
  });

  socket.on("teacher:clearQuestion", () => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room) return;
    room.activeQuestion = null;
    notifyTeachers(userId, "question:clear");
    broadcastToStudents(userId, "question:clear");
  });

  socket.on("teacher:mute", ({ seat, muted }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room || !room.seats[seat]) return;
    room.seats[seat].muted = !!muted;
    const sid = room.seatSocket[seat];
    if (sid) io.to(sid).emit("you:muted", { muted: !!muted });
    notifyTeachers(userId, "seat:update", { seat, data: room.seats[seat] });
  });

  socket.on("teacher:setPhoto", ({ seat, photo }, cb) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    const s = Number(seat);
    if (!room || s < 1 || s > STUDENT_SEATS || !room.seats[s]) {
      cb && cb({ ok: false, error: "교실에 연결되지 않았어요. 새로고침 후 다시 시도해 주세요." });
      return;
    }
    cb && cb(applyStudentPhoto(room, userId, s, photo || null));
  });

  socket.on("student:setPhoto", ({ photo, clientId }, cb) => {
    const { userId, room, seat } = resolveStudentContext(socket, clientId);
    if (!room) {
      cb && cb({ ok: false, error: "교실에 연결되지 않았어요." });
      return;
    }
    if (!seat) {
      cb && cb({ ok: false, error: "참여 후에 프로필을 설정할 수 있어요." });
      return;
    }
    cb && cb(applyStudentPhoto(room, userId, seat, photo || null));
  });

  socket.on("student:raiseHand", ({ raised, clientId }, cb) => {
    const { userId, room, seat } = resolveStudentContext(socket, clientId);
    if (!room || !seat) {
      cb && cb({ ok: false, error: "참여 후에 손들기를 할 수 있어요." });
      return;
    }
    const next = typeof raised === "boolean" ? raised : !room.seats[seat].handRaised;
    room.seats[seat].handRaised = next;
    notifyTeachers(userId, "seat:update", { seat, data: room.seats[seat] });
    cb && cb({ ok: true, handRaised: next });
  });

  socket.on("teacher:lowerHand", ({ seat }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    const s = Number(seat);
    if (!room || !room.seats[s]) return;
    room.seats[s].handRaised = false;
    const sid = room.seatSocket[s];
    if (sid) io.to(sid).emit("you:handLowered");
    notifyTeachers(userId, "seat:update", { seat: s, data: room.seats[s] });
  });

  socket.on("teacher:kick", ({ seat }) => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room || !room.seats[seat]) return;
    const sid = room.seatSocket[seat];
    if (sid) {
      io.to(sid).emit("you:kicked");
      delete room.socketSeat[sid];
      const s = io.sockets.sockets.get(sid);
      if (s) setTimeout(() => s.disconnect(true), 300);
    }
    clearOccupant(room.seats[seat]);
    delete room.seatSocket[seat];
    notifyTeachers(userId, "seat:update", { seat, data: room.seats[seat] });
  });

  socket.on("teacher:kickAll", () => {
    const userId = getTeacherUserId(socket);
    const room = userId && rooms[userId];
    if (!room) return;
    for (let i = 1; i <= STUDENT_SEATS; i++) {
      const sid = room.seatSocket[i];
      if (sid) {
        io.to(sid).emit("you:kicked");
        delete room.socketSeat[sid];
        const s = io.sockets.sockets.get(sid);
        if (s) setTimeout(() => s.disconnect(true), 300);
      }
      clearOccupant(room.seats[i]);
      delete room.seatSocket[i];
    }
    notifyTeachers(userId, "state", room.seats);
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    const room = userId && rooms[userId];
    if (!room || socket.data.role !== "student") return;
    const seat = room.socketSeat[socket.id];
    if (!seat) return;
    room.seats[seat].online = false;
    delete room.socketSeat[socket.id];
    if (room.seatSocket[seat] === socket.id) delete room.seatSocket[seat];
    notifyTeachers(userId, "seat:update", { seat, data: room.seats[seat] });
  });
});

// cloudflared 실행 파일 경로 (프로젝트 폴더에 둠)
function cloudflaredPath() {
  const local = path.join(__dirname, "cloudflared.exe");
  if (fs.existsSync(local)) return local;
  return "cloudflared"; // PATH에 설치된 경우
}

// 인터넷 어디서든 접속 가능한 공개 터널 시작
function startTunnel() {
  const bin = cloudflaredPath();
  if (bin.endsWith(".exe") && !fs.existsSync(bin)) {
    console.log("[터널] cloudflared.exe 가 없어 공개 주소 없이 LAN 모드로 동작합니다.");
    return;
  }
  console.log("[터널] 인터넷 공개 주소를 만드는 중입니다... (잠시 기다려 주세요)");
  const proc = spawn(bin, ["tunnel", "--url", `http://localhost:${PORT}`], {
    windowsHide: true,
  });

  const onData = (buf) => {
    const text = buf.toString();
    const match = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      console.log("==============================================");
      console.log(" ✅ 인터넷 공개 주소가 준비되었습니다!");
      console.log(` 학생 참여(어디서든) : ${publicUrl}/student`);
      console.log(" 교사 화면에서 'QR 코드' 버튼을 누르면 참여 QR이 나옵니다.");
      console.log("==============================================");
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", (code) => {
    console.log(`[터널] cloudflared 종료됨 (code ${code}). LAN 주소로만 접속 가능합니다.`);
    publicUrl = null;
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIP();
  console.log("==============================================");
  console.log(" 우리반 채팅 서버가 시작되었습니다!");
  console.log(` 교사 화면 : http://localhost:${PORT}`);
  console.log(` 학생 참여(같은 네트워크) : http://${ip}:${PORT}/student`);
  console.log("==============================================");
  if (!isProd) startTunnel();
});
