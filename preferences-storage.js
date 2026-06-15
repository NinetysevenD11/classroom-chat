import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const PREFERENCES_FILE = path.join(DATA_DIR, "preferences_data.json");

export const MAX_BACKGROUND_IMAGE_CHARS = 2_800_000;

export let preferencesData = {};

function defaultPreferences() {
  return {
    backgroundImage: null,
    updatedAt: Date.now(),
  };
}

export function normalizeBackgroundImage(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(s)) return null;
  if (s.length > MAX_BACKGROUND_IMAGE_CHARS) return null;
  return s;
}

function normalizePreferences(raw) {
  const base = defaultPreferences();
  const incoming = raw && typeof raw === "object" ? raw : {};
  const backgroundImage = normalizeBackgroundImage(incoming.backgroundImage);
  return {
    backgroundImage,
    updatedAt: Number(incoming.updatedAt) || Date.now(),
  };
}

function loadFromFile() {
  try {
    preferencesData = JSON.parse(fs.readFileSync(PREFERENCES_FILE, "utf8"));
  } catch (_) {
    preferencesData = {};
  }
}

function saveToFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(preferencesData, null, 2));
  } catch (err) {
    console.error("[환경설정] 파일 저장 실패:", err.message);
  }
}

export async function initPreferencesStorage() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    try {
      const doc = await db.collection("preferences").findOne({ _id: "main" });
      if (doc?.data) preferencesData = doc.data;
    } catch (_) {}
    return;
  }
  loadFromFile();
}

async function saveAllPreferencesData() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    await db.collection("preferences").updateOne(
      { _id: "main" },
      { $set: { data: preferencesData } },
      { upsert: true }
    );
    return;
  }
  saveToFile();
}

export function getUserPreferences(userId) {
  if (!preferencesData[userId]) {
    preferencesData[userId] = defaultPreferences();
  }
  preferencesData[userId] = normalizePreferences(preferencesData[userId]);
  return preferencesData[userId];
}

export async function saveUserPreferences(userId, incoming) {
  const prev = getUserPreferences(userId);
  const nextImage =
    incoming && Object.prototype.hasOwnProperty.call(incoming, "backgroundImage")
      ? normalizeBackgroundImage(incoming.backgroundImage)
      : prev.backgroundImage;

  if (
    incoming &&
    Object.prototype.hasOwnProperty.call(incoming, "backgroundImage") &&
    incoming.backgroundImage &&
    !nextImage
  ) {
    throw new Error("배경 사진 형식이 올바르지 않거나 용량이 너무 큽니다.");
  }

  preferencesData[userId] = {
    backgroundImage: nextImage,
    updatedAt: Date.now(),
  };
  await saveAllPreferencesData();
  return preferencesData[userId];
}
