import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getMongoClient } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BOOKMARKS_FILE = path.join(DATA_DIR, "bookmarks_data.json");

export const UNCATEGORIZED_ID = "uncategorized";
export const DEFAULT_MAJOR_ID = "major-default";
export const DEFAULT_MID_ID = "mid-default";
export const LEVEL_MAJOR = 1;
export const LEVEL_MID = 2;
export const LEVEL_MINOR = 3;

export let bookmarksData = {};

export function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function defaultBookmarksState() {
  return {
    categories: defaultCategoryTree(),
    items: [],
  };
}

function defaultCategoryTree() {
  const now = Date.now();
  return [
    {
      id: DEFAULT_MAJOR_ID,
      name: "일반",
      level: LEVEL_MAJOR,
      parentId: null,
      order: 0,
      builtin: true,
      createdAt: now,
    },
    {
      id: DEFAULT_MID_ID,
      name: "기본",
      level: LEVEL_MID,
      parentId: DEFAULT_MAJOR_ID,
      order: 0,
      builtin: true,
      createdAt: now,
    },
    {
      id: UNCATEGORIZED_ID,
      name: "미분류",
      level: LEVEL_MINOR,
      parentId: DEFAULT_MID_ID,
      order: 0,
      builtin: true,
      createdAt: now,
    },
  ];
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
      level: LEVEL_MINOR,
      parentId: DEFAULT_MID_ID,
      order: 0,
      builtin: true,
      createdAt: Number(cat.createdAt) || Date.now(),
    };
  }

  if (id === DEFAULT_MAJOR_ID) {
    return {
      id: DEFAULT_MAJOR_ID,
      name: "일반",
      level: LEVEL_MAJOR,
      parentId: null,
      order: 0,
      builtin: true,
      createdAt: Number(cat.createdAt) || Date.now(),
    };
  }

  if (id === DEFAULT_MID_ID) {
    return {
      id: DEFAULT_MID_ID,
      name: "기본",
      level: LEVEL_MID,
      parentId: DEFAULT_MAJOR_ID,
      order: 0,
      builtin: true,
      createdAt: Number(cat.createdAt) || Date.now(),
    };
  }

  let level = Number(cat.level);
  if (![LEVEL_MAJOR, LEVEL_MID, LEVEL_MINOR].includes(level)) level = LEVEL_MINOR;

  let parentId = cat.parentId != null && cat.parentId !== "" ? String(cat.parentId) : null;
  if (level === LEVEL_MAJOR) parentId = null;

  return {
    id,
    name: name.slice(0, 40),
    level,
    parentId,
    order: Number(cat.order) || 0,
    builtin: false,
    createdAt: Number(cat.createdAt) || Date.now(),
  };
}

function migrateFlatCategories(categories) {
  return categories.map((cat) => {
    if (!cat || cat.builtin) return cat;
    if (!cat.level) {
      return { ...cat, level: LEVEL_MINOR, parentId: cat.parentId || DEFAULT_MID_ID };
    }
    if (cat.level === LEVEL_MID && !cat.parentId) {
      return { ...cat, parentId: DEFAULT_MAJOR_ID };
    }
    if (cat.level === LEVEL_MINOR && !cat.parentId) {
      return { ...cat, parentId: DEFAULT_MID_ID };
    }
    return cat;
  });
}

function ensureDefaultHierarchy(categories) {
  const map = new Map();
  for (const raw of categories) {
    const cat = normalizeCategory(raw);
    if (cat) map.set(cat.id, cat);
  }

  for (const def of defaultCategoryTree()) {
    if (!map.has(def.id)) map.set(def.id, def);
  }

  let cats = [...map.values()];
  cats = migrateFlatCategories(cats);

  const byId = new Map(cats.map((c) => [c.id, c]));

  for (const cat of cats) {
    if (cat.level === LEVEL_MAJOR) cat.parentId = null;
    if (cat.level === LEVEL_MID) {
      const parent = cat.parentId && byId.get(cat.parentId);
      if (!parent || parent.level !== LEVEL_MAJOR) cat.parentId = DEFAULT_MAJOR_ID;
    }
    if (cat.level === LEVEL_MINOR) {
      const parent = cat.parentId && byId.get(cat.parentId);
      if (!parent || parent.level !== LEVEL_MID) cat.parentId = DEFAULT_MID_ID;
    }
  }

  return cats;
}

export function sortBookmarkCategories(categories) {
  const collator = new Intl.Collator("ko-KR", { sensitivity: "base" });
  const majors = categories
    .filter((c) => c.level === LEVEL_MAJOR)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || collator.compare(a.name, b.name));

  const result = [];
  for (const major of majors) {
    result.push(major);
    const mids = categories
      .filter((c) => c.level === LEVEL_MID && c.parentId === major.id)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || collator.compare(a.name, b.name));
    for (const mid of mids) {
      result.push(mid);
      const minors = categories
        .filter((c) => c.level === LEVEL_MINOR && c.parentId === mid.id)
        .sort((a, b) => {
          if (a.id === UNCATEGORIZED_ID) return -1;
          if (b.id === UNCATEGORIZED_ID) return 1;
          return (a.order || 0) - (b.order || 0) || collator.compare(a.name, b.name);
        });
      result.push(...minors);
    }
  }

  const included = new Set(result.map((c) => c.id));
  for (const cat of categories) {
    if (!included.has(cat.id)) result.push(cat);
  }
  return result;
}

function leafCategoryIds(categories) {
  return new Set(
    categories.filter((c) => c.level === LEVEL_MINOR).map((c) => c.id)
  );
}

function normalizeItem(item, leafIds) {
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
  if (!leafIds.has(categoryId)) categoryId = UNCATEGORIZED_ID;
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
  const incoming = raw && typeof raw === "object" ? raw : {};
  let categories = Array.isArray(incoming.categories)
    ? incoming.categories.map(normalizeCategory).filter(Boolean)
    : [];
  categories = ensureDefaultHierarchy(categories);
  categories = sortBookmarkCategories(categories);

  const leafIds = leafCategoryIds(categories);
  const items = (Array.isArray(incoming.items) ? incoming.items : [])
    .map((item) => normalizeItem(item, leafIds))
    .filter(Boolean);

  return {
    categories,
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
