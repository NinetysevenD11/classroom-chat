import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BOOKMARKS_FILE = path.join(DATA_DIR, "bookmarks_data.json");

export const UNCATEGORIZED_ID = "uncategorized";

export let bookmarksData = {};

export function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function defaultBookmarksState() {
  return {
    categories: [
      { id: UNCATEGORIZED_ID, name: "미분류", order: 0, builtin: true, createdAt: Date.now() },
    ],
    items: [],
  };
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function normalizeCategory(cat) {
  if (!cat || typeof cat !== "object") return null;
  const id = String(cat.id || uid());
  const name = String(cat.name || "").trim();
  if (!name) return null;
  if (id === UNCATEGORIZED_ID) {
    return {
      id: UNCATEGORIZED_ID,
      name: "미분류",
      order: 0,
      builtin: true,
      createdAt: Number(cat.createdAt) || Date.now(),
    };
  }
  return {
    id,
    name: name.slice(0, 40),
    order: Number(cat.order) || 0,
    builtin: false,
    createdAt: Number(cat.createdAt) || Date.now(),
  };
}

function normalizeItem(item, validCategoryIds) {
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
  let categoryId = String(item.categoryId || UNCATEGORIZED_ID);
  if (!validCategoryIds.has(categoryId)) categoryId = UNCATEGORIZED_ID;
  const out = {
    id: String(item.id || uid()),
    title: title.slice(0, 80),
    description: String(item.description || "").trim().slice(0, 200),
    url: url.slice(0, 500),
    createdAt: Number(item.createdAt) || Date.now(),
    pinned: !!item.pinned,
    categoryId,
  };
  const previewUrl = String(item.previewUrl || "").trim();
  if (previewUrl) {
    try {
      const u = new URL(previewUrl);
      if (["http:", "https:"].includes(u.protocol)) {
        out.previewUrl = previewUrl.slice(0, 500);
      }
    } catch (_) {}
  }
  return out;
}

export function sortBookmarkCategories(categories) {
  const collator = new Intl.Collator("ko-KR", { sensitivity: "base" });
  return [...categories].sort((a, b) => {
    if (a.id === UNCATEGORIZED_ID) return -1;
    if (b.id === UNCATEGORIZED_ID) return 1;
    const byOrder = (a.order || 0) - (b.order || 0);
    if (byOrder !== 0) return byOrder;
    return collator.compare(a.name, b.name);
  });
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

function normalizeState(raw) {
  const base = defaultBookmarksState();
  const incoming = raw && typeof raw === "object" ? raw : {};

  let categories = Array.isArray(incoming.categories)
    ? incoming.categories.map(normalizeCategory).filter(Boolean)
    : [];

  if (!categories.some((c) => c.id === UNCATEGORIZED_ID)) {
    categories.unshift(base.categories[0]);
  }

  const validCategoryIds = new Set(categories.map((c) => c.id));
  const items = (Array.isArray(incoming.items) ? incoming.items : [])
    .map((item) => normalizeItem(item, validCategoryIds))
    .filter(Boolean);

  return {
    categories: sortBookmarkCategories(categories),
    items: sortBookmarkItems(items),
  };
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
  bookmarksData[userId] = normalizeState(bookmarksData[userId]);
  return bookmarksData[userId];
}

export async function saveBookmarksState(userId, incoming) {
  getBookmarksState(userId);
  bookmarksData[userId] = normalizeState(incoming);
  await saveAllBookmarksData();
  return bookmarksData[userId];
}
