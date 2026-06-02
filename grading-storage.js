import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const GRADING_FILE = path.join(DATA_DIR, "grading_data.json");

export const AI_PROVIDERS = ["openai", "gemini", "claude", "grok"];

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
    settings: defaultSettings(),
    trendAnalysisLogs: [],
    onboarding: { tourCompleted: false, completedSteps: {} },
  };
}

export function ensureOnboarding(state) {
  if (!state.onboarding || typeof state.onboarding !== "object") {
    state.onboarding = { tourCompleted: false, completedSteps: {} };
  }
  if (!state.onboarding.completedSteps || typeof state.onboarding.completedSteps !== "object") {
    state.onboarding.completedSteps = {};
  }
  return state.onboarding;
}

const MAX_TREND_LOGS = 300;

function ensureTrendLogs(state) {
  if (!Array.isArray(state.trendAnalysisLogs)) state.trendAnalysisLogs = [];
  return state.trendAnalysisLogs;
}

/** AI 학습 분석 실행마다 기록 (최신순, 상한 300건) */
export async function appendTrendAnalysisLog(userId, entry) {
  const state = getGradingState(userId);
  const logs = ensureTrendLogs(state);
  const record = {
    id: uid(),
    createdAt: Date.now(),
    ...entry,
  };
  logs.unshift(record);
  if (logs.length > MAX_TREND_LOGS) state.trendAnalysisLogs = logs.slice(0, MAX_TREND_LOGS);
  await saveGradingState(userId, state, { preserveSecrets: false });
  return record;
}

export function getTrendAnalysisLogs(userId, opts = {}) {
  const state = getGradingState(userId);
  let logs = ensureTrendLogs(state).slice();
  const { studentKey, limit = 50 } = opts;
  if (studentKey) logs = logs.filter((l) => l.studentKey === studentKey);
  return logs.slice(0, Math.min(limit, 100));
}

export function defaultSettings() {
  return {
    aiProvider: "gemini",
    apiKeys: { openai: "", gemini: "", claude: "", grok: "" },
  };
}

function migrateLegacySettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  if (!s.apiKeys || typeof s.apiKeys !== "object") {
    s.apiKeys = { openai: "", gemini: "", claude: "", grok: "" };
  }
  for (const p of AI_PROVIDERS) {
    if (s.apiKeys[p] === undefined) s.apiKeys[p] = "";
  }
  if (s.geminiApiKey && !s.apiKeys.gemini) s.apiKeys.gemini = String(s.geminiApiKey).trim();
  if (s.openaiApiKey && !s.apiKeys.openai) s.apiKeys.openai = String(s.openaiApiKey).trim();
  delete s.geminiApiKey;
  delete s.openaiApiKey;
  if (!AI_PROVIDERS.includes(s.aiProvider)) {
    s.aiProvider = s.aiProvider === "auto" ? "gemini" : "gemini";
  }
  return s;
}

function ensureSettings(state) {
  if (!state.settings || typeof state.settings !== "object") {
    state.settings = defaultSettings();
  }
  state.settings = migrateLegacySettings(state.settings);
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
  const provider = settings.aiProvider || "gemini";
  const keyForProvider = String(settings.apiKeys[provider] || "").trim();
  s.settings = {
    aiProvider: provider,
    hasApiKey: !!keyForProvider,
    apiKeyHint: maskApiKey(keyForProvider),
    keysRegistered: Object.fromEntries(
      AI_PROVIDERS.map((p) => [p, !!String(settings.apiKeys[p] || "").trim()])
    ),
  };
  return s;
}

function envKeyForProvider(provider) {
  const map = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
    grok: process.env.XAI_API_KEY,
  };
  return (map[provider] || "").trim() || null;
}

export function getAiCredentials(userId) {
  const state = getGradingState(userId);
  const settings = ensureSettings(state);
  const provider = AI_PROVIDERS.includes(settings.aiProvider) ? settings.aiProvider : "gemini";
  const userKey = String(settings.apiKeys[provider] || "").trim();
  const envKey = envKeyForProvider(provider);

  return {
    provider,
    apiKey: userKey || envKey || null,
    source: userKey ? "user" : envKey ? "env" : null,
  };
}

export async function updateUserApiKeys(userId, { apiKey, aiProvider, clearApiKey, clearAll }) {
  const state = getGradingState(userId);
  const settings = ensureSettings(state);

  if (clearAll) {
    for (const p of AI_PROVIDERS) settings.apiKeys[p] = "";
  } else if (clearApiKey) {
    const p = AI_PROVIDERS.includes(aiProvider) ? aiProvider : settings.aiProvider;
    settings.apiKeys[p] = "";
  } else {
    if (AI_PROVIDERS.includes(aiProvider)) settings.aiProvider = aiProvider;
    const p = settings.aiProvider;
    if (apiKey !== undefined) settings.apiKeys[p] = String(apiKey).trim();
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
    try {
      const doc = await db.collection("grading").findOne({ _id: "main" });
      if (doc?.data) gradingData = doc.data;
    } catch (_) {}
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
  ensureTrendLogs(s);
  ensureOnboarding(s);
  return s;
}

export async function saveGradingState(userId, state, opts = {}) {
  const preserveSecrets = opts.preserveSecrets !== false;
  const prev = gradingData[userId];
  const prevSettings = prev?.settings ? migrateLegacySettings({ ...prev.settings }) : null;

  if (prev?.studentScores && state.studentScores) {
    state.studentScores = mergeStudentScores(prev.studentScores, state.studentScores);
  }

  ensureSettings(state);
  const incoming = migrateLegacySettings(state.settings);

  if (preserveSecrets && prevSettings?.apiKeys) {
    for (const p of AI_PROVIDERS) {
      if (!String(incoming.apiKeys[p] || "").trim() && prevSettings.apiKeys[p]) {
        incoming.apiKeys[p] = prevSettings.apiKeys[p];
      }
    }
  }

  state.settings = incoming;
  if (prev?.trendAnalysisLogs) {
    state.trendAnalysisLogs = prev.trendAnalysisLogs;
  } else {
    ensureTrendLogs(state);
  }
  if (prev?.onboarding) {
    const inc = ensureOnboarding(state);
    const prevOb = ensureOnboarding(prev);
    inc.tourCompleted = inc.tourCompleted || prevOb.tourCompleted;
    inc.completedSteps = { ...prevOb.completedSteps, ...inc.completedSteps };
  } else {
    ensureOnboarding(state);
  }
  gradingData[userId] = state;
  await saveAllGradingData();
}

/** 클라이언트 저장 시 서버에만 있는 제출·채점 상세가 지워지지 않도록 병합 */
function mergeStudentScores(prevScores, incomingScores) {
  if (!prevScores || typeof prevScores !== "object") return incomingScores;
  if (!incomingScores || typeof incomingScores !== "object") return prevScores;
  const merged = { ...incomingScores };
  for (const key of Object.keys(prevScores)) {
    const prevRec = prevScores[key];
    const incRec = merged[key];
    if (!incRec) {
      merged[key] = prevRec;
      continue;
    }
    if (prevRec._detail) {
      incRec._detail = { ...prevRec._detail, ...(incRec._detail || {}) };
      for (const unitId of Object.keys(prevRec._detail)) {
        const prevUnit = prevRec._detail[unitId];
        const incUnit = incRec._detail[unitId];
        if (!incUnit) {
          incRec._detail[unitId] = prevUnit;
        } else if (prevUnit?.detail && !incUnit.detail) {
          incRec._detail[unitId] = {
            ...prevUnit,
            ...incUnit,
            detail: prevUnit.detail,
            answers: prevUnit.answers ?? incUnit.answers,
          };
        }
      }
    }
    if (prevRec._submittedAt && !incRec._submittedAt) {
      incRec._submittedAt = prevRec._submittedAt;
    }
    for (const uid of Object.keys(prevRec)) {
      if (uid.startsWith("_")) continue;
      if (incRec[uid] === undefined && prevRec[uid] !== undefined) {
        incRec[uid] = prevRec[uid];
      }
    }
  }
  return merged;
}
