/**
 * 눈치 O/X 게임 — hiddenO 스타일 (교실용)
 * 개인 답은 비공개, O 총인원·맞힌 사람만 공개
 */

export const ASK_SECONDS = 90;
export const VOTE_SECONDS = 60;
export const MAX_PLAYERS = 19;
export const MIN_PLAYERS = 2;
export const MAX_SCORE = 1000;
export const AVATAR_COUNT = 32;

export const QUESTION_THEMES = [
  {
    id: "class",
    label: "학급·학교생활",
    questions: [
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
  },
  {
    id: "friend",
    label: "친구·우정",
    questions: [
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
  },
  {
    id: "self",
    label: "나·취향",
    questions: [
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
  },
  {
    id: "fun",
    label: "가벼운 눈치",
    questions: [
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
  },
];

/** teacherUserId → game */
const games = new Map();

function emptyPlayer(nickname, clientId, avatarId) {
  return {
    nickname,
    clientId,
    avatarId,
    socketId: null,
    score: 0,
    online: false,
    answer: null,
    guess: null,
    submittedAt: null,
    lastRoundPoints: 0,
  };
}

function pickAvatarId(game) {
  const used = new Set(
    [...game.players.values()].map((p) => p.avatarId).filter((id) => id != null)
  );
  const free = [];
  for (let i = 0; i < AVATAR_COUNT; i++) {
    if (!used.has(i)) free.push(i);
  }
  const pool = free.length ? free : [...Array(AVATAR_COUNT).keys()];
  return pool[Math.floor(Math.random() * pool.length)];
}

function makeGame(teacherUserId, roomCode) {
  return {
    teacherUserId,
    roomCode,
    hostSocketId: null,
    phase: "lobby", // lobby | asking | voting | reveal | finished
    round: 0,
    question: null,
    themeId: null,
    players: new Map(), // clientId → player
    askEndsAt: null,
    voteEndsAt: null,
    voteStartedAt: null,
    lastReveal: null,
    timer: null,
    hostOfflineTimer: null,
    createdAt: Date.now(),
  };
}

export function getOxGame(teacherUserId) {
  return games.get(teacherUserId) || null;
}

export function getOrCreateOxGame(teacherUserId, roomCode) {
  let g = games.get(teacherUserId);
  if (!g) {
    g = makeGame(teacherUserId, roomCode);
    games.set(teacherUserId, g);
  } else if (roomCode) {
    g.roomCode = roomCode;
  }
  return g;
}

export function findOxGameByRoomCode(roomCode, findUserIdByRoomCode) {
  const userId = findUserIdByRoomCode(roomCode);
  if (!userId) return null;
  return getOrCreateOxGame(userId, roomCode);
}

function clearTimer(game) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}

function playerList(game) {
  return [...game.players.values()]
    .filter((p) => p.online || p.score > 0 || game.phase !== "lobby")
    .map((p) => ({
      clientId: p.clientId,
      nickname: p.nickname,
      avatarId: p.avatarId ?? 0,
      score: p.score,
      online: p.online,
      submitted: !!(p.answer && p.guess !== null),
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko"));
}

function ranking(game) {
  const list = [...game.players.values()].sort(
    (a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname, "ko")
  );
  let rank = 0;
  let prev = null;
  return list.map((p, i) => {
    if (prev === null || p.score < prev) rank = i + 1;
    prev = p.score;
    return {
      nickname: p.nickname,
      score: p.score,
      rank,
      clientId: p.clientId,
      avatarId: p.avatarId ?? 0,
    };
  });
}

export function publicOxState(game) {
  const submitted = [...game.players.values()].filter((p) => p.online && p.answer).length;
  const online = [...game.players.values()].filter((p) => p.online).length;
  return {
    phase: game.phase,
    round: game.round,
    question: game.question,
    themeId: game.themeId,
    roomCode: game.roomCode,
    players: playerList(game),
    onlineCount: online,
    submittedCount: submitted,
    askEndsAt: game.askEndsAt,
    voteEndsAt: game.voteEndsAt,
    voteStartedAt: game.voteStartedAt,
    askSeconds: ASK_SECONDS,
    voteSeconds: VOTE_SECONDS,
    lastReveal: game.lastReveal,
    ranking: game.phase === "finished" || game.phase === "reveal" ? ranking(game) : null,
    themes: QUESTION_THEMES.map((t) => ({ id: t.id, label: t.label, count: t.questions.length })),
    avatarCount: AVATAR_COUNT,
  };
}

function resetRoundAnswers(game) {
  for (const p of game.players.values()) {
    p.answer = null;
    p.guess = null;
    p.submittedAt = null;
    p.lastRoundPoints = 0;
  }
}

function scoreGuess(guess, oCount, submittedAt, voteStartedAt) {
  if (Number(guess) !== Number(oCount)) return 0;
  const elapsed = Math.max(0, (submittedAt || Date.now()) - (voteStartedAt || Date.now()));
  const ratio = Math.min(1, elapsed / (VOTE_SECONDS * 1000));
  const factor = Math.max(0.25, 1 - ratio * 0.75);
  return Math.round(MAX_SCORE * factor);
}

function computeReveal(game) {
  const voters = [...game.players.values()].filter((p) => p.online);
  const answered = voters.filter((p) => p.answer === "O" || p.answer === "X");
  if (answered.length < voters.length || answered.length === 0) {
    // incomplete → everyone 0 this round
    for (const p of voters) p.lastRoundPoints = 0;
    return {
      complete: false,
      oCount: null,
      total: voters.length,
      submitted: answered.length,
      correct: [],
      message: "시간 안에 모두 제출하지 않아 이번 라운드는 0점이에요. 개별 답은 공개하지 않아요.",
    };
  }

  const oCount = answered.filter((p) => p.answer === "O").length;
  const correct = [];
  for (const p of answered) {
    const pts = scoreGuess(p.guess, oCount, p.submittedAt, game.voteStartedAt);
    p.lastRoundPoints = pts;
    p.score += pts;
    if (pts > 0) {
      correct.push({ nickname: p.nickname, points: pts, clientId: p.clientId });
    }
  }
  correct.sort((a, b) => b.points - a.points);

  return {
    complete: true,
    oCount,
    total: answered.length,
    submitted: answered.length,
    correct,
    message: null,
  };
}

function emitAll(io, game, event, data) {
  io.to(`ox:${game.teacherUserId}`).emit(event, data);
}

/** Socket.IO: (cb) 또는 (payload, cb) 둘 다 받기 */
function takeAck(a, b) {
  if (typeof a === "function") return { payload: {}, cb: a };
  return { payload: a && typeof a === "object" ? a : {}, cb: typeof b === "function" ? b : null };
}

function reply(cb, data) {
  if (typeof cb === "function") cb(data);
}

function broadcastState(io, game) {
  emitAll(io, game, "ox:state", publicOxState(game));
}

function schedulePhase(io, game, ms, fn) {
  clearTimer(game);
  game.timer = setTimeout(() => {
    game.timer = null;
    fn();
  }, ms);
}

function beginAsking(io, game, question, themeId) {
  game.round += 1;
  game.question = String(question || "").trim().slice(0, 120);
  game.themeId = themeId || null;
  game.lastReveal = null;
  game.askEndsAt = null;
  // 질문과 투표를 동시에 — 대기 단계 없이 바로 투표 UI
  game.phase = "asking";
  beginVoting(io, game);
}

function beginVoting(io, game) {
  if (game.phase !== "asking" && game.phase !== "lobby" && game.phase !== "reveal") return;
  if (!game.question) return;
  game.phase = "voting";
  resetRoundAnswers(game);
  game.voteStartedAt = Date.now();
  game.voteEndsAt = Date.now() + VOTE_SECONDS * 1000;
  game.askEndsAt = null;
  broadcastState(io, game);
  schedulePhase(io, game, VOTE_SECONDS * 1000, () => revealRound(io, game));
}

function revealRound(io, game) {
  if (game.phase !== "voting") return;
  clearTimer(game);
  const reveal = computeReveal(game);
  game.phase = "reveal";
  game.lastReveal = reveal;
  game.voteEndsAt = null;
  broadcastState(io, game);
  // private per-player feedback
  for (const p of game.players.values()) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit("ox:myResult", {
      answer: p.answer,
      guess: p.guess,
      points: p.lastRoundPoints,
      oCount: reveal.complete ? reveal.oCount : null,
      correct: reveal.complete && Number(p.guess) === Number(reveal.oCount),
    });
  }
}

function maybeAutoReveal(io, game) {
  if (game.phase !== "voting") return;
  const online = [...game.players.values()].filter((p) => p.online);
  if (!online.length) return;
  if (online.every((p) => p.answer && p.guess !== null && p.guess !== undefined)) {
    revealRound(io, game);
  }
}

/**
 * @param {import('socket.io').Server} io
 * @param {{ getTeacherUserId: Function, findUserIdByRoomCode: Function, ensureUserRoomCode: Function }} deps
 */
export function registerOxGame(io, deps) {
  const { getTeacherUserId, findUserIdByRoomCode, ensureUserRoomCode } = deps;

  io.on("connection", (socket) => {
    socket.on("ox:hostJoin", async (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      if (!userId) {
        reply(cb, { ok: false, error: "로그인이 필요합니다." });
        return;
      }
      const roomCode = await ensureUserRoomCode(userId);
      const game = getOrCreateOxGame(userId, roomCode);
      if (game.hostOfflineTimer) {
        clearTimeout(game.hostOfflineTimer);
        game.hostOfflineTimer = null;
      }
      game.hostSocketId = socket.id;
      socket.data.oxRole = "host";
      socket.data.oxTeacherId = userId;
      socket.join(`ox:${userId}`);
      reply(cb, { ok: true, state: publicOxState(game), roomCode });
      broadcastState(io, game);
    });

    socket.on("ox:playerJoin", (a, b) => {
      const { payload, cb } = takeAck(a, b);
      const code = String(payload.room || "").trim();
      const name = String(payload.nickname || "").trim().slice(0, 12);
      const cid = String(payload.clientId || "").trim().slice(0, 64);
      if (!code || !name || !cid) {
        reply(cb, { ok: false, error: "방 코드와 닉네임을 입력해 주세요." });
        return;
      }
      const teacherId = findUserIdByRoomCode(code);
      if (!teacherId) {
        reply(cb, { ok: false, error: "유효하지 않은 참여 코드예요." });
        return;
      }
      const game = getOrCreateOxGame(teacherId, code);
      if (!game.hostSocketId) {
        reply(cb, { ok: false, error: "선생님이 아직 눈치 게임 화면을 켜지 않았어요." });
        return;
      }
      if (game.phase !== "lobby" && !game.players.has(cid)) {
        reply(cb, { ok: false, error: "이미 게임이 시작됐어요. 다음 게임에 참여해 주세요." });
        return;
      }

      let player = game.players.get(cid);
      if (!player) {
        const onlineCount = [...game.players.values()].filter((p) => p.online).length;
        if (onlineCount >= MAX_PLAYERS) {
          reply(cb, { ok: false, error: `최대 ${MAX_PLAYERS}명까지 참여할 수 있어요.` });
          return;
        }
        const taken = [...game.players.values()].some(
          (p) => p.online && p.nickname === name && p.clientId !== cid
        );
        if (taken) {
          reply(cb, { ok: false, error: "같은 닉네임이 이미 있어요." });
          return;
        }
        player = emptyPlayer(name, cid, pickAvatarId(game));
        game.players.set(cid, player);
      } else {
        player.nickname = name;
        if (player.avatarId == null) player.avatarId = pickAvatarId(game);
      }
      player.socketId = socket.id;
      player.online = true;
      socket.data.oxRole = "player";
      socket.data.oxTeacherId = teacherId;
      socket.data.oxClientId = cid;
      socket.join(`ox:${teacherId}`);

      reply(cb, {
        ok: true,
        state: publicOxState(game),
        me: {
          clientId: cid,
          nickname: name,
          score: player.score,
          avatarId: player.avatarId ?? 0,
        },
      });
      broadcastState(io, game);
    });

    socket.on("ox:start", (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 시작할 수 있어요." });
        return;
      }
      const online = [...game.players.values()].filter((p) => p.online).length;
      if (online < MIN_PLAYERS) {
        reply(cb, { ok: false, error: `최소 ${MIN_PLAYERS}명이 모이면 시작할 수 있어요.` });
        return;
      }
      game.phase = "lobby";
      game.round = 0;
      game.question = null;
      game.lastReveal = null;
      for (const p of game.players.values()) {
        p.score = 0;
        p.answer = null;
        p.guess = null;
      }
      clearTimer(game);
      reply(cb, { ok: true });
      broadcastState(io, game);
    });

    socket.on("ox:ask", (a, b) => {
      const { payload, cb } = takeAck(a, b);
      const { question, themeId, questionIndex } = payload;
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 질문을 시작할 수 있어요." });
        return;
      }
      if (game.phase !== "lobby" && game.phase !== "reveal") {
        reply(cb, { ok: false, error: "지금은 질문을 시작할 수 없어요." });
        return;
      }
      const onlineAsk = [...game.players.values()].filter((p) => p.online).length;
      if (onlineAsk < MIN_PLAYERS) {
        reply(cb, { ok: false, error: `최소 ${MIN_PLAYERS}명이 모이면 질문을 시작할 수 있어요.` });
        return;
      }
      let text = String(question || "").trim();
      if (!text && themeId != null) {
        const theme = QUESTION_THEMES.find((t) => t.id === themeId);
        const idx = Number(questionIndex);
        if (theme && Number.isInteger(idx) && theme.questions[idx]) {
          text = theme.questions[idx];
        }
      }
      if (!text) {
        reply(cb, { ok: false, error: "질문을 입력하거나 골라 주세요." });
        return;
      }
      beginAsking(io, game, text, themeId || null);
      reply(cb, { ok: true });
    });

    socket.on("ox:beginVote", (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 투표를 시작할 수 있어요." });
        return;
      }
      if (game.phase !== "asking") {
        reply(cb, { ok: false, error: "질문 단계에서만 투표를 열 수 있어요." });
        return;
      }
      beginVoting(io, game);
      reply(cb, { ok: true });
    });

    socket.on("ox:submit", (a, b) => {
      const { payload, cb } = takeAck(a, b);
      const { answer, guess } = payload;
      const teacherId = socket.data.oxTeacherId;
      const cid = socket.data.oxClientId;
      const game = teacherId && getOxGame(teacherId);
      if (!game || socket.data.oxRole !== "player" || !cid) {
        reply(cb, { ok: false, error: "먼저 참여해 주세요." });
        return;
      }
      if (game.phase !== "voting") {
        reply(cb, { ok: false, error: "지금은 투표 시간이 아니에요." });
        return;
      }
      const player = game.players.get(cid);
      if (!player || !player.online) {
        reply(cb, { ok: false, error: "참여 정보가 없어요." });
        return;
      }
      const ans = String(answer || "").toUpperCase();
      if (ans !== "O" && ans !== "X") {
        reply(cb, { ok: false, error: "O 또는 X로 답해 주세요." });
        return;
      }
      const g = Number(guess);
      const online = [...game.players.values()].filter((p) => p.online).length;
      if (!Number.isInteger(g) || g < 0 || g > online) {
        reply(cb, { ok: false, error: `예측은 0~${online} 사이 숫자예요.` });
        return;
      }
      player.answer = ans;
      player.guess = g;
      player.submittedAt = Date.now();
      reply(cb, { ok: true });
      broadcastState(io, game);
      maybeAutoReveal(io, game);
    });

    socket.on("ox:revealNow", (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 결과를 열 수 있어요." });
        return;
      }
      if (game.phase !== "voting") {
        reply(cb, { ok: false, error: "투표 중이 아니에요." });
        return;
      }
      revealRound(io, game);
      reply(cb, { ok: true });
    });

    socket.on("ox:end", (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 게임을 종료할 수 있어요." });
        return;
      }
      // 대기·투표·결과 중 언제든 종료 가능
      clearTimer(game);
      game.phase = "finished";
      game.question = null;
      game.askEndsAt = null;
      game.voteEndsAt = null;
      game.voteStartedAt = null;
      resetRoundAnswers(game);
      reply(cb, { ok: true, ranking: ranking(game) });
      broadcastState(io, game);
    });

    socket.on("ox:resetLobby", (a, b) => {
      const { cb } = takeAck(a, b);
      const userId = getTeacherUserId(socket);
      const game = userId && getOxGame(userId);
      if (!game || game.hostSocketId !== socket.id || socket.data.oxRole !== "host") {
        reply(cb, { ok: false, error: "선생님만 초기화할 수 있어요." });
        return;
      }
      clearTimer(game);
      game.phase = "lobby";
      game.round = 0;
      game.question = null;
      game.lastReveal = null;
      game.askEndsAt = null;
      game.voteEndsAt = null;
      for (const p of game.players.values()) {
        p.score = 0;
        p.answer = null;
        p.guess = null;
      }
      reply(cb, { ok: true });
      broadcastState(io, game);
    });

    socket.on("disconnect", () => {
      const teacherId = socket.data.oxTeacherId;
      if (!teacherId) return;
      const game = getOxGame(teacherId);
      if (!game) return;

      if (game.hostSocketId === socket.id) {
        // 새로고침/재연결 동안 타이머·라운드는 유지 (clearTimer 하지 않음)
        game.hostSocketId = null;
        if (game.hostOfflineTimer) clearTimeout(game.hostOfflineTimer);
        game.hostOfflineTimer = setTimeout(() => {
          game.hostOfflineTimer = null;
          broadcastState(io, game);
        }, 12000);
        broadcastState(io, game);
        return;
      }
      const cid = socket.data.oxClientId;
      const player = cid && game.players.get(cid);
      if (player && player.socketId === socket.id) {
        player.online = false;
        player.socketId = null;
        broadcastState(io, game);
      }
    });
  });
}
