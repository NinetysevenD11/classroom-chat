import fs from "fs";
import path from "path";
import crypto from "crypto";
import { MongoClient } from "mongodb";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGODB_URI = process.env.MONGODB_URI;

function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return __dirname;
}

const DATA_DIR = resolveDataDir();
const USERS_FILE = path.join(DATA_DIR, "users.json");
const PROFILES_FILE = path.join(DATA_DIR, "student_profiles.json");
const SECRET_FILE = path.join(DATA_DIR, ".session_secret");

let mongoClient = null;
let mongoDb = null;

export let users = {};
export let studentProfiles = {};
export let sessionSecret = "";

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
  try {
    Object.assign(fileUsers, JSON.parse(fs.readFileSync(USERS_FILE, "utf8")));
  } catch (_) {}
  try {
    Object.assign(fileProfiles, JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")));
  } catch (_) {}

  if (!Object.keys(users).length && Object.keys(fileUsers).length) {
    for (const [id, data] of Object.entries(fileUsers)) {
      users[id] = data;
      await mongoDb.collection("users").updateOne(
        { _id: id },
        { $set: { salt: data.salt, hash: data.hash, room: data.room } },
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
}

export async function initStorage() {
  ensureDataDir();

  if (MONGODB_URI) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    mongoDb = mongoClient.db(process.env.MONGODB_DB || "classroom_chat");

    users = {};
    const userDocs = await mongoDb.collection("users").find().toArray();
    for (const doc of userDocs) {
      users[doc._id] = { salt: doc.salt, hash: doc.hash, room: doc.room };
    }

    const profileDoc = await mongoDb.collection("profiles").findOne({ _id: "main" });
    studentProfiles = profileDoc?.data || {};

    await importFileDataToMongo();
    await loadSessionSecret();
    console.log("[저장] MongoDB 연결됨 — 회원·프로필이 배포 후에도 유지됩니다.");
    return;
  }

  loadUsersFromFile();
  loadProfilesFromFile();
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
      { $set: { salt: userData.salt, hash: userData.hash, room: userData.room } },
      { upsert: true }
    );
    return;
  }
  saveUsersToFile();
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
