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
  };
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
  return s;
}

export async function saveGradingState(userId, state) {
  gradingData[userId] = state;
  await saveAllGradingData();
}
