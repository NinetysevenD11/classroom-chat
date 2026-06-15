import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BOOKMARKS_FILE = path.join(DATA_DIR, "bookmarks_data.json");

export let bookmarksData = {};

export function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function defaultBookmarksState() {
  return { items: [] };
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const title = String(item.title || "").trim();
  const url = normalizeUrl(item.url);
  if (!title || !url) return null;
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return null;
  } catch {
    return null;
  }
  return {
    id: String(item.id || uid()),
    title: title.slice(0, 80),
    description: String(item.description || "").trim().slice(0, 200),
    url: url.slice(0, 500),
    createdAt: Number(item.createdAt) || Date.now(),
    pinned: !!item.pinned,
  };
}

/** 고정 → 이름 가나다순 */
export function sortBookmarkItems(items) {
  const collator = new Intl.Collator("ko-KR", { sensitivity: "base" });
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byTitle = collator.compare(a.title, b.title);
    if (byTitle !== 0) return byTitle;
    return a.createdAt - b.createdAt;
  });
}

function loadFromFile() {
  try {
    bookmarksData = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, "utf8"));
  } catch (_) {
    bookmarksData = {};
  }
}

function saveToFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarksData, null, 2));
  } catch (err) {
    console.error("[북마크] 파일 저장 실패:", err.message);
  }
}

export async function initBookmarksStorage() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    try {
      const doc = await db.collection("bookmarks").findOne({ _id: "main" });
      if (doc?.data) bookmarksData = doc.data;
    } catch (_) {}
    return;
  }
  loadFromFile();
}

async function saveAllBookmarksData() {
  const mongo = getMongoClient();
  if (mongo) {
    const db = mongo.db(process.env.MONGODB_DB || "classroom_chat");
    await db.collection("bookmarks").updateOne(
      { _id: "main" },
      { $set: { data: bookmarksData } },
      { upsert: true }
    );
    return;
  }
  saveToFile();
}

export function getBookmarksState(userId) {
  if (!bookmarksData[userId]) {
    bookmarksData[userId] = defaultBookmarksState();
  }
  if (!Array.isArray(bookmarksData[userId].items)) {
    bookmarksData[userId].items = [];
  }
  bookmarksData[userId].items = sortBookmarkItems(
    bookmarksData[userId].items.map(normalizeItem).filter(Boolean)
  );
  return bookmarksData[userId];
}

export async function saveBookmarksState(userId, incoming) {
  const prev = getBookmarksState(userId);
  const items = Array.isArray(incoming?.items) ? incoming.items : [];
  const normalized = items.map(normalizeItem).filter(Boolean);
  bookmarksData[userId] = { items: sortBookmarkItems(normalized) };
  await saveAllBookmarksData();
  return bookmarksData[userId];
}
