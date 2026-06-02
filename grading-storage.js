import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const GRADING_FILE = path.join(DATA_DIR, "grading_data.json");

export let gradingData = {};

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

export function defaultGradingState() {
  const examId = uid();
  const mathId = uid();
  const u3 = uid();
  const u4 = uid();
  const questions = [];
  for (let i = 1; i <= 20; i++) {
    let type = "mc";
    if (i === 5 || i === 15) type = "short";
    if (i === 14 || i === 19 || i === 20) type = "essay";
    questions.push({
      id: uid(),
      num: i,
      type,
      answer: type === "mc" ? String((i % 5) + 1) : type === "short" ? "답" : "",
      points: "1",
      rubric: "",
    });
  }
  return {
    exams: [
      {
        id: examId,
        name: "1학기 평가",
        active: true,
        subjects: [
          { id: uid(), name: "국어", active: false, units: [] },
          { id: uid(), name: "사회", active: false, units: [] },
          {
            id: mathId,
            name: "수학",
            active: true,
            units: [
              {
                id: u3,
                name: "수학_3단원_대응관계",
                locked: true,
                images: [],
                questions,
              },
              {
                id: u4,
                name: "수학_4단원_약분과통분",
                locked: false,
                images: [],
                questions: questions.map((q) => ({ ...q, id: uid() })),
              },
            ],
          },
        ],
      },
    ],
    classes: [{ id: uid(), name: "5-3반", studentCount: 20, selected: true }],
    resultsPublished: false,
    studentScores: {},
    activeExamId: examId,
    activeSubjectId: mathId,
    activeUnitId: u3,
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
    const state = defaultGradingState();
    if (state.classes[0]) state.activeClassId = state.classes[0].id;
    gradingData[userId] = state;
  }
  const s = gradingData[userId];
  if (!s.activeClassId && s.classes?.length) s.activeClassId = s.classes[0].id;
  return s;
}

export async function saveGradingState(userId, state) {
  gradingData[userId] = state;
  await saveAllGradingData();
}

export { uid };
