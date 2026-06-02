import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const GRADING_FILE = path.join(DATA_DIR, "grading_data.json");

export let gradingData = {};

export function uid() {
  return crypto.randomBytes(8).toString("hex");
}

/** 빈 상태 — 샘플 데이터 없음 */
export function defaultGradingState() {
  const examId = uid();
  return {
    exams: [{ id: examId, name: "기본 평가", active: true, subjects: [] }],
    classes: [],
    resultsPublished: false,
    studentScores: {},
    activeExamId: examId,
    activeSubjectId: null,
    activeUnitId: null,
    activeClassId: null,
    settings: {
      geminiApiKey: "",
      openaiApiKey: "",
      aiProvider: "gemini",
    },
  };
}

function ensureSettings(state) {
  if (!state.settings || typeof state.settings !== "object") {
    state.settings = { geminiApiKey: "", openaiApiKey: "", aiProvider: "gemini" };
  }
  if (!state.settings.aiProvider) state.settings.aiProvider = "gemini";
  return state.settings;
}

export function maskApiKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** 클라이언트로 보낼 때 비밀 키 제거 */
export function sanitizeGradingForClient(state) {
  const s = { ...state };
  const settings = ensureSettings(s);
  s.settings = {
    aiProvider: settings.aiProvider || "gemini",
    hasGemini: !!String(settings.geminiApiKey || "").trim(),
    hasOpenai: !!String(settings.openaiApiKey || "").trim(),
    geminiHint: maskApiKey(settings.geminiApiKey),
    openaiHint: maskApiKey(settings.openaiApiKey),
  };
  return s;
}

export function getAiCredentials(userId) {
  const state = getGradingState(userId);
  const settings = ensureSettings(state);
  const userGemini = String(settings.geminiApiKey || "").trim();
  const userOpenai = String(settings.openaiApiKey || "").trim();
  const envGemini = (process.env.GEMINI_API_KEY || "").trim();
  const envOpenai = (process.env.OPENAI_API_KEY || "").trim();
  const provider = settings.aiProvider || "gemini";

  return {
    provider,
    geminiKey: userGemini || envGemini || null,
    openaiKey: userOpenai || envOpenai || null,
    source: {
      gemini: userGemini ? "user" : envGemini ? "env" : null,
      openai: userOpenai ? "user" : envOpenai ? "env" : null,
    },
  };
}

export async function updateUserApiKeys(userId, { geminiApiKey, openaiApiKey, aiProvider, clearGemini, clearOpenai }) {
  const state = getGradingState(userId);
  const settings = ensureSettings(state);
  if (clearGemini) settings.geminiApiKey = "";
  else if (geminiApiKey !== undefined) settings.geminiApiKey = String(geminiApiKey).trim();
  if (clearOpenai) settings.openaiApiKey = "";
  else if (openaiApiKey !== undefined) settings.openaiApiKey = String(openaiApiKey).trim();
  if (aiProvider === "gemini" || aiProvider === "openai" || aiProvider === "auto") {
    settings.aiProvider = aiProvider;
  }
  await saveGradingState(userId, state, { preserveSecrets: false });
  return sanitizeGradingForClient(state).settings;
}

function loadFromFile() {
  try {
    gradingData = JSON.parse(fs.readFileSync(GRADING_FILE, "utf8"));
  } catch (_) {
    gradingData = {};
  }
}

function saveToFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GRADING_FILE, JSON.stringify(gradingData, null, 2));
  } catch (err) {
    console.error("[채점] 파일 저장 실패:", err.message);
  }
}

export async function initGradingStorage() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    const doc = await db.collection("grading").findOne({ _id: "main" });
    gradingData = doc?.data || {};
    if (!Object.keys(gradingData).length) {
      try {
        const fileData = JSON.parse(fs.readFileSync(GRADING_FILE, "utf8"));
        if (Object.keys(fileData).length) {
          gradingData = fileData;
          await saveAllGradingData();
          console.log("[채점] grading_data.json을 MongoDB로 옮겼습니다.");
        }
      } catch (_) {}
    }
    return;
  }
  loadFromFile();
}

async function saveAllGradingData() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    await db.collection("grading").updateOne(
      { _id: "main" },
      { $set: { data: gradingData } },
      { upsert: true }
    );
    return;
  }
  saveToFile();
}

export function getGradingState(userId) {
  if (!gradingData[userId]) {
    gradingData[userId] = defaultGradingState();
  }
  const s = gradingData[userId];
  if (!Array.isArray(s.exams) || !s.exams.length) {
    const fresh = defaultGradingState();
    Object.assign(s, fresh);
  }
  if (!s.activeExamId) s.activeExamId = s.exams[0].id;
  if (!s.activeClassId && s.classes?.length) s.activeClassId = s.classes[0].id;
  ensureSettings(s);
  return s;
}

export async function saveGradingState(userId, state, opts = {}) {
  const preserveSecrets = opts.preserveSecrets !== false;
  const prev = gradingData[userId];
  const prevSettings = prev?.settings;
  ensureSettings(state);
  const incoming = state.settings;
  state.settings = {
    geminiApiKey: String(incoming.geminiApiKey || "").trim(),
    openaiApiKey: String(incoming.openaiApiKey || "").trim(),
    aiProvider: incoming.aiProvider || prevSettings?.aiProvider || "gemini",
  };
  if (preserveSecrets && prevSettings) {
    if (!state.settings.geminiApiKey && prevSettings.geminiApiKey) {
      state.settings.geminiApiKey = prevSettings.geminiApiKey;
    }
    if (!state.settings.openaiApiKey && prevSettings.openaiApiKey) {
      state.settings.openaiApiKey = prevSettings.openaiApiKey;
    }
  }
  gradingData[userId] = state;
  await saveAllGradingData();
}
