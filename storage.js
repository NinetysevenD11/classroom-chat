import fs from "fs";
import path from "path";
import crypto from "crypto";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getMongoUri() {
  return (process.env.MONGODB_URI || "").trim();
}

function normalizeMongoUri(uri) {
  if (!uri) return uri;
  let out = uri;
  if (!/\/[a-zA-Z0-9_-]+(\?|$)/.test(out.replace(/\/\/[^/]+@/, "//x@"))) {
    out = out.replace(/\.mongodb\.net(\/?)(\?|$)/, ".mongodb.net/classroom_chat$2");
  }
  if (!/retryWrites=/.test(out)) {
    out += (out.includes("?") ? "&" : "?") + "retryWrites=true&w=majority";
  }
  return out;
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return __dirname;
}

const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PROFILES_FILE = path.join(DATA_DIR, "student_profiles.json");
const ROSTERS_FILE = path.join(DATA_DIR, "class_rosters.json");
const LOGIN_LOGS_FILE = path.join(DATA_DIR, "login_logs.json");
const SECRET_FILE = path.join(DATA_DIR, ".session_secret");
const MAX_LOGIN_LOGS = 500;

let mongoClient = null;
let mongoDb = null;

export let users = {};
export let studentProfiles = {};
export let classRosters = {};
export let loginLogs = [];
export let sessionSecret = "";

export function getAdminIdsFromEnv() {
  return (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdminUserId(userId) {
  if (!userId) return false;
  if (getAdminIdsFromEnv().includes(userId)) return true;
  return users[userId]?.isAdmin === true;
}

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function loadUsersFromFile() {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (_) {
    users = {};
  }
}

function loadProfilesFromFile() {
  try {
    studentProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
  } catch (_) {
    studentProfiles = {};
  }
}

function saveUsersToFile() {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function saveProfilesToFile() {
  ensureDataDir();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(studentProfiles, null, 2));
}

function loadRostersFromFile() {
  try {
    classRosters = JSON.parse(fs.readFileSync(ROSTERS_FILE, "utf8"));
  } catch (_) {
    classRosters = {};
  }
}

function saveRostersToFile() {
  ensureDataDir();
  fs.writeFileSync(ROSTERS_FILE, JSON.stringify(classRosters, null, 2));
}

function loadLoginLogsFromFile() {
  try {
    loginLogs = JSON.parse(fs.readFileSync(LOGIN_LOGS_FILE, "utf8"));
    if (!Array.isArray(loginLogs)) loginLogs = [];
  } catch (_) {
    loginLogs = [];
  }
}

function saveLoginLogsToFile() {
  ensureDataDir();
  fs.writeFileSync(LOGIN_LOGS_FILE, JSON.stringify(loginLogs.slice(-MAX_LOGIN_LOGS), null, 2));
}

async function loadSessionSecret() {
  if (process.env.SESSION_SECRET) {
    sessionSecret = process.env.SESSION_SECRET;
    return;
  }
  if (mongoDb) {
    const doc = await mongoDb.collection("config").findOne({ _id: "session" });
    if (doc?.secret) {
      sessionSecret = doc.secret;
      return;
    }
    sessionSecret = crypto.randomBytes(32).toString("hex");
    await mongoDb.collection("config").updateOne(
      { _id: "session" },
      { $set: { secret: sessionSecret } },
      { upsert: true }
    );
    return;
  }
  try {
    sessionSecret = fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch (_) {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(SECRET_FILE, sessionSecret);
    } catch (_) {}
  }
}

async function importFileDataToMongo() {
  const fileUsers = {};
  const fileProfiles = {};
  const fileRosters = {};
  try {
    Object.assign(fileUsers, JSON.parse(fs.readFileSync(USERS_FILE, "utf8")));
  } catch (_) {}
  try {
    Object.assign(fileProfiles, JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")));
  } catch (_) {}
  try {
    Object.assign(fileRosters, JSON.parse(fs.readFileSync(ROSTERS_FILE, "utf8")));
  } catch (_) {}

  if (!Object.keys(users).length && Object.keys(fileUsers).length) {
    for (const [id, data] of Object.entries(fileUsers)) {
      users[id] = data;
      await mongoDb.collection("users").updateOne(
        { _id: id },
        { $set: { salt: data.salt, hash: data.hash, room: data.room, isAdmin: !!data.isAdmin } },
        { upsert: true }
      );
    }
    console.log(`[저장] 기존 users.json ${Object.keys(fileUsers).length}명을 MongoDB로 옮겼습니다.`);
  }

  if (!Object.keys(studentProfiles).length && Object.keys(fileProfiles).length) {
    studentProfiles = fileProfiles;
    await mongoDb.collection("profiles").updateOne(
      { _id: "main" },
      { $set: { data: studentProfiles } },
      { upsert: true }
    );
    console.log("[저장] 기존 student_profiles.json을 MongoDB로 옮겼습니다.");
  }

  if (!Object.keys(classRosters).length && Object.keys(fileRosters).length) {
    classRosters = fileRosters;
    await mongoDb.collection("rosters").updateOne(
      { _id: "main" },
      { $set: { data: classRosters } },
      { upsert: true }
    );
    console.log("[저장] 기존 class_rosters.json을 MongoDB로 옮겼습니다.");
  }
}

export async function initStorage() {
  ensureDataDir();

  const mongoUri = getMongoUri();
  if (mongoUri) {
    const uri = normalizeMongoUri(mongoUri);
    console.log("[저장] MongoDB 연결 시도 중...");
    try {
      mongoClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
      });
      await mongoClient.connect();
      mongoDb = mongoClient.db(process.env.MONGODB_DB || "classroom_chat");

      users = {};
      const userDocs = await mongoDb.collection("users").find().toArray();
      for (const doc of userDocs) {
        users[doc._id] = {
          salt: doc.salt,
          hash: doc.hash,
          room: doc.room,
          isAdmin: !!doc.isAdmin,
        };
      }

      loginLogs = [];
      const logDocs = await mongoDb
        .collection("login_logs")
        .find()
        .sort({ at: -1 })
        .limit(MAX_LOGIN_LOGS)
        .toArray();
      loginLogs = logDocs.map((d) => ({
        userId: d.userId,
        at: d.at,
        ip: d.ip || null,
      }));

      const profileDoc = await mongoDb.collection("profiles").findOne({ _id: "main" });
      studentProfiles = profileDoc?.data || {};

      const rosterDoc = await mongoDb.collection("rosters").findOne({ _id: "main" });
      classRosters = rosterDoc?.data || {};

      await importFileDataToMongo();
      await loadSessionSecret();
      console.log("[저장] MongoDB 연결됨 — 회원·프로필이 배포 후에도 유지됩니다.");
      return;
    } catch (err) {
      console.error("[저장] MongoDB 연결 실패:", err.message);
      console.error("       Atlas → Network Access에 0.0.0.0/0 이 있는지 확인하세요.");
      throw err;
    }
  }

  loadUsersFromFile();
  loadProfilesFromFile();
  loadRostersFromFile();
  loadLoginLogsFromFile();
  await loadSessionSecret();

  if (process.env.RENDER === "true") {
    console.warn("==============================================");
    console.warn("[경고] Render 무료 플랜은 redeploy마다 파일이 지워집니다.");
    console.warn(" MongoDB Atlas(무료) 연결 문자열을");
    console.warn(" Render 환경 변수 MONGODB_URI 에 추가해 주세요.");
    console.warn("==============================================");
  } else {
    console.log(`[저장] 로컬 파일 (${DATA_DIR})`);
  }
}

export async function saveUser(id, userData) {
  users[id] = userData;
  if (mongoDb) {
    await mongoDb.collection("users").updateOne(
      { _id: id },
      {
        $set: {
          salt: userData.salt,
          hash: userData.hash,
          room: userData.room,
          isAdmin: !!userData.isAdmin,
        },
      },
      { upsert: true }
    );
    return;
  }
  saveUsersToFile();
}

export async function recordLogin(userId, meta = {}) {
  const entry = {
    userId,
    at: Date.now(),
    ip: meta.ip || null,
  };
  loginLogs.push(entry);
  if (loginLogs.length > MAX_LOGIN_LOGS) {
    loginLogs = loginLogs.slice(-MAX_LOGIN_LOGS);
  }
  if (mongoDb) {
    await mongoDb.collection("login_logs").insertOne(entry);
    return;
  }
  saveLoginLogsToFile();
}

export function getLastLoginByUser() {
  const map = {};
  for (let i = loginLogs.length - 1; i >= 0; i--) {
    const e = loginLogs[i];
    if (e?.userId && !map[e.userId]) map[e.userId] = e.at;
  }
  return map;
}

export function getRecentLoginLogs(limit = 80) {
  return [...loginLogs].slice(-limit).reverse();
}

/** Render/로컬 환경 변수 ADMIN_ID, ADMIN_PASSWORD 로 관리자 계정 생성 */
export async function ensureAdminAccount(makeUserFn) {
  const adminId = (process.env.ADMIN_ID || "").trim();
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (!adminId) return null;

  const envAdmins = getAdminIdsFromEnv();
  if (!envAdmins.includes(adminId)) {
    process.env.ADMIN_IDS = envAdmins.length ? `${envAdmins.join(",")},${adminId}` : adminId;
  }

  if (!users[adminId]) {
    if (!adminPassword) {
      console.warn("[관리자] ADMIN_ID만 있고 ADMIN_PASSWORD가 없어 계정을 만들지 않습니다.");
      return null;
    }
    const u = makeUserFn(adminPassword);
    u.isAdmin = true;
    await saveUser(adminId, u);
    console.log(`[관리자] 계정 '${adminId}' 생성됨 (환경 변수)`);
    return adminId;
  }

  if (!users[adminId].isAdmin) {
    users[adminId].isAdmin = true;
    await saveUser(adminId, users[adminId]);
  }
  if (adminPassword) {
    const u = makeUserFn(adminPassword);
    u.isAdmin = true;
    await saveUser(adminId, u);
    console.log(`[관리자] 계정 '${adminId}' 비밀번호·권한 갱신 (환경 변수)`);
  }
  return adminId;
}

export async function saveStudentProfilesData() {
  if (mongoDb) {
    await mongoDb.collection("profiles").updateOne(
      { _id: "main" },
      { $set: { data: studentProfiles } },
      { upsert: true }
    );
    return;
  }
  saveProfilesToFile();
}

export function getClassRoster(userId) {
  return classRosters[userId] || {};
}

export async function saveClassRoster(userId, roster) {
  classRosters[userId] = roster;
  if (mongoDb) {
    await mongoDb.collection("rosters").updateOne(
      { _id: "main" },
      { $set: { data: classRosters } },
      { upsert: true }
    );
    return;
  }
  saveRostersToFile();
}
