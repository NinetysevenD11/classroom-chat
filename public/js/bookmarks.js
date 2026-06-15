/** 자주 가는 사이트 — 링크 카드 + 카테고리 */

const UNCATEGORIZED_ID = "uncategorized";
const DEFAULT_MAJOR_ID = "major-default";
const DEFAULT_MID_ID = "mid-default";
const LEVEL_MAJOR = 1;
const LEVEL_MID = 2;
const LEVEL_MINOR = 3;
const FILTER_ALL = "__all__";
const FILTER_KEY = "bmActiveCategory";

let categories = [];
let items = [];
let editingId = null;
let editingCategoryId = null;
let activeFilter = localStorage.getItem(FILTER_KEY) || FILTER_ALL;
let searchQuery = "";

const gridEl = document.getElementById("bookmarkGrid");
const emptyEl = document.getElementById("bookmarkEmpty");
const categoryListEl = document.getElementById("categoryList");
const subEl = document.getElementById("bookmarksSub");
const searchInput = document.getElementById("bmSearch");
const searchClearBtn = document.getElementById("bmSearchClear");
const dialogEl = document.getElementById("bookmarkDialog");
const categoryDialogEl = document.getElementById("categoryDialog");
const formEl = document.getElementById("bookmarkForm");
const categoryFormEl = document.getElementById("categoryForm");
const titleInput = document.getElementById("bmTitle");
const urlInput = document.getElementById("bmUrl");
const descInput = document.getElementById("bmDesc");
const categorySelect = document.getElementById("bmCategory");
const dialogTitleEl = document.getElementById("bookmarkDialogTitle");
const categoryDialogTitleEl = document.getElementById("categoryDialogTitle");
const catNameInput = document.getElementById("catName");
const catLevelSelect = document.getElementById("catLevel");
const catParentSelect = document.getElementById("catParent");
const catParentField = document.getElementById("catParentField");
const toastEl = document.getElementById("bookmarkToast");

const titleCollator = new Intl.Collator("ko-KR", { sensitivity: "base" });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(msg, isError) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.toggle("is-error", !!isError);
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2600);
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 사이트 이름·주소를 보고 카드 앞에 붙일 이모지 하나 선택 */
const SITE_EMOJI_RULES = [
  { emoji: "▶️", keys: ["유튜브", "youtube", "youtu.be"] },
  { emoji: "🔍", keys: ["네이버", "naver", "구글", "google", "bing", "검색"] },
  { emoji: "💬", keys: ["카카오", "kakao", "다음", "daum", "디스코드", "discord", "슬랙", "slack", "줌", "zoom", "채팅", "메신저", "teams", "밴드", "band"] },
  { emoji: "🏫", keys: ["클래스룸", "classroom", "에듀", "학교", "교실", "나이스", "neis", "에듀넷", "교육청", "weeclass", "위클래스"] },
  { emoji: "📝", keys: ["노션", "notion", "메모", "시험", "평가", "성적", "채점", "과제", "숙제"] },
  { emoji: "📋", keys: ["구글폼", "google form", "설문", "forms.google", "typeform", "서베이"] },
  { emoji: "🎨", keys: ["캔바", "canva", "미리캔버스", "디자인", "figma", "피그마", "일러스트"] },
  { emoji: "📁", keys: ["드라이브", "drive", "구글문서", "docs.google", "원드라이브", "onedrive", "dropbox", "자료", "파일"] },
  { emoji: "📌", keys: ["padlet", "패들렛", "핀터레스트", "pinterest"] },
  { emoji: "📚", keys: ["위키", "wikipedia", "도서", "도서관", "책", "리디", "교과서", "ebs", "티스토리", "blog", "블로그"] },
  { emoji: "💻", keys: ["깃허", "github", "코딩", "프로그래밍", "코드", "scratch", "스크래치", "repl.it", "replit"] },
  { emoji: "🎮", keys: ["게임", "roblox", "로블록스", "minecraft", "마인크래프트", "steam"] },
  { emoji: "🎵", keys: ["음악", "멜론", "melon", "지니", "genie", "spotify", "스포티파이", "사운드클라우드"] },
  { emoji: "🎬", keys: ["넷플릭스", "netflix", "영상", "동영상", "티빙", "tving", "웨이브", "wavve", "쿠팡플레이", "disney"] },
  { emoji: "📷", keys: ["인스타", "instagram", "사진", "이미지", "unsplash", "픽사베이"] },
  { emoji: "🐦", keys: ["트위터", "twitter", "x.com"] },
  { emoji: "📰", keys: ["뉴스", "news", "연합", "조선", "중앙", "한겨레"] },
  { emoji: "🗺️", keys: ["지도", "map", "maps.google", "카카오맵", "kakaomap"] },
  { emoji: "🌤️", keys: ["날씨", "weather", "기상"] },
  { emoji: "✉️", keys: ["메일", "mail", "gmail", "이메일", "outlook"] },
  { emoji: "🛒", keys: ["쿠팡", "coupang", "쇼핑", "11번가", "gmarket", "지마켓", "옥션", "스마트스토어"] },
  { emoji: "💰", keys: ["은행", "bank", "금융", "카카오페이", "토스", "toss"] },
  { emoji: "🔬", keys: ["과학", "실험", "simulation", "시뮬레이션"] },
  { emoji: "➕", keys: ["수학", "math", "연산", "계산"] },
  { emoji: "🔤", keys: ["영어", "english", "단어", "voca", "어학"] },
  { emoji: "📅", keys: ["캘린더", "calendar", "일정", "스케줄"] },
  { emoji: "❓", keys: ["퀴즈", "quiz", "kahoot", "카훗", "wordwall", "워드월"] },
  { emoji: "🍳", keys: ["요리", "레시피", "음식", "맛집"] },
  { emoji: "✈️", keys: ["여행", "항공", "trip", "booking"] },
  { emoji: "💪", keys: ["운동", "건강", "fitness"] },
  { emoji: "🌐", keys: ["번역", "translate", "papago", "파파고", "deepl"] },
  { emoji: "🎓", keys: ["대학", "univ", "학습", "강의", "수업", "mooc", "coursera"] },
  { emoji: "🖼️", keys: ["갤러리", "gallery", "박물관", "museum"] },
  { emoji: "🐋", keys: ["웨일", "whale", "naver whale"] },
  { emoji: "📺", keys: ["방송", "tv", "아프리카", "afreeca", "치지직", "chzzk"] },
];

function emojiForBookmark(title, url) {
  const titleLower = String(title || "").toLowerCase();
  const host = hostLabel(url).toLowerCase();
  const haystack = `${titleLower} ${host}`;

  for (const rule of SITE_EMOJI_RULES) {
    if (rule.keys.some((k) => haystack.includes(k.toLowerCase()))) {
      return rule.emoji;
    }
  }

  if (/\.(go\.kr|edu|ac\.kr)/.test(host)) return "🏛️";
  if (/\.(shop|store)/.test(host)) return "🛍️";
  return "🔗";
}

function sortItems(list) {
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const byTitle = titleCollator.compare(a.title || "", b.title || "");
    if (byTitle !== 0) return byTitle;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function normalizedSearchQuery() {
  return searchQuery.trim().toLowerCase();
}

function itemMatchesSearch(item, q) {
  if (!q) return true;
  const title = String(item.title || "").toLowerCase();
  const url = String(item.url || "").toLowerCase();
  const host = hostLabel(item.url).toLowerCase();
  return title.includes(q) || url.includes(q) || host.includes(q);
}

function levelLabel(level) {
  if (level === LEVEL_MAJOR) return "대분류";
  if (level === LEVEL_MID) return "중분류";
  return "소분류";
}

function levelShort(level) {
  if (level === LEVEL_MAJOR) return "대";
  if (level === LEVEL_MID) return "중";
  return "소";
}

function getCategory(id) {
  return categories.find((c) => c.id === id);
}

function childrenOf(parentId, level) {
  return categories.filter((c) => c.parentId === parentId && c.level === level);
}

function collectDescendantIds(id) {
  const cat = getCategory(id);
  if (!cat) return [id];
  const ids = [id];
  for (const child of categories.filter((c) => c.parentId === id)) {
    ids.push(...collectDescendantIds(child.id));
  }
  return ids;
}

function descendantLeafIds(catId) {
  const cat = getCategory(catId);
  if (!cat) return catId === UNCATEGORIZED_ID ? [UNCATEGORIZED_ID] : [];
  if (cat.level === LEVEL_MINOR) return [cat.id];
  if (cat.level === LEVEL_MID) {
    return categories.filter((c) => c.level === LEVEL_MINOR && c.parentId === cat.id).map((c) => c.id);
  }
  if (cat.level === LEVEL_MAJOR) {
    const midIds = categories.filter((c) => c.level === LEVEL_MID && c.parentId === cat.id).map((c) => c.id);
    return categories
      .filter((c) => c.level === LEVEL_MINOR && midIds.includes(c.parentId))
      .map((c) => c.id);
  }
  return [];
}

function categoryPath(catId, separator = " › ") {
  if (catId === FILTER_ALL) return "전체";
  const cat = getCategory(catId);
  if (!cat) return "미분류";
  const parts = [cat.name];
  let parentId = cat.parentId;
  while (parentId) {
    const parent = getCategory(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(separator);
}

function itemsInCategory(catId) {
  if (catId === FILTER_ALL) return items;
  const leafIds = new Set(descendantLeafIds(catId));
  if (!leafIds.size) return [];
  return items.filter((x) => leafIds.has(x.categoryId || UNCATEGORIZED_ID));
}

function countInCategory(catId) {
  const q = normalizedSearchQuery();
  const list = itemsInCategory(catId);
  if (!q) return list.length;
  return list.filter((x) => itemMatchesSearch(x, q)).length;
}

function categoryName(catId) {
  return categoryPath(catId);
}

function setActiveFilter(catId) {
  activeFilter = catId;
  localStorage.setItem(FILTER_KEY, catId);
  renderSidebar();
  renderGrid();
}

function setSearchQuery(value) {
  searchQuery = String(value || "");
  if (searchInput && searchInput.value !== searchQuery) searchInput.value = searchQuery;
  searchClearBtn?.classList.toggle("hidden", !searchQuery.trim());
  renderSidebar();
  renderGrid();
}

function filteredItems() {
  const q = normalizedSearchQuery();
  const list = itemsInCategory(activeFilter).filter((x) => itemMatchesSearch(x, q));
  return sortItems(list);
}

function updateSubText() {
  if (!subEl) return;
  const q = normalizedSearchQuery();
  const label = categoryName(activeFilter);
  const count = countInCategory(activeFilter);

  if (q) {
    subEl.textContent =
      activeFilter === FILTER_ALL
        ? `「${searchQuery.trim()}」 검색 · ${count}개`
        : `「${label}」에서 「${searchQuery.trim()}」 검색 · ${count}개`;
    return;
  }

  subEl.textContent =
    activeFilter === FILTER_ALL
      ? "전체 사이트를 가나다순으로 보여 줍니다. 고정한 카드는 맨 위에 표시됩니다."
      : `「${label}」 · ${count}개`;
}

function fillCategorySelect(selectedId) {
  if (!categorySelect) return;
  const leaves = categories
    .filter((c) => c.level === LEVEL_MINOR)
    .sort((a, b) => titleCollator.compare(categoryPath(a.id), categoryPath(b.id)));
  categorySelect.innerHTML = leaves
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(categoryPath(c.id))}</option>`
    )
    .join("");
}

function fillParentSelect(level, selectedId) {
  if (!catParentSelect) return;
  let parents = [];
  if (level === LEVEL_MID) {
    parents = categories.filter((c) => c.level === LEVEL_MAJOR);
  } else if (level === LEVEL_MINOR) {
    parents = categories.filter((c) => c.level === LEVEL_MID);
  }
  catParentSelect.innerHTML = parents
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(c.name)}</option>`
    )
    .join("");
}

function syncCategoryFormFields() {
  const level = Number(catLevelSelect?.value || LEVEL_MINOR);
  if (catParentField) {
    catParentField.classList.toggle("hidden", level === LEVEL_MAJOR);
  }
  if (level !== LEVEL_MAJOR) {
    const currentParent = catParentSelect?.value;
    fillParentSelect(level, currentParent);
    if (!catParentSelect?.value && catParentSelect?.options.length) {
      catParentSelect.selectedIndex = 0;
    }
  }
}

function openDialog(item) {
  editingId = item?.id || null;
  dialogTitleEl.textContent = editingId ? "사이트 수정" : "사이트 추가";
  titleInput.value = item?.title || "";
  urlInput.value = item?.url || "";
  descInput.value = item?.description || "";
  const cat =
    item?.categoryId ||
    (activeFilter !== FILTER_ALL && getCategory(activeFilter)?.level === LEVEL_MINOR
      ? activeFilter
      : UNCATEGORIZED_ID);
  fillCategorySelect(cat);
  dialogEl.classList.remove("hidden");
  titleInput.focus();
}

function closeDialog() {
  dialogEl.classList.add("hidden");
  editingId = null;
  formEl.reset();
}

function openCategoryDialog(cat, defaults = {}) {
  editingCategoryId = cat?.id || null;
  if (cat?.builtin) return;

  const level = cat?.level || defaults.level || LEVEL_MINOR;
  categoryDialogTitleEl.textContent = editingCategoryId
    ? `${levelLabel(level)} 수정`
    : `${levelLabel(level)} 추가`;
  catNameInput.value = cat?.name || "";
  if (catLevelSelect) {
    catLevelSelect.value = String(level);
    catLevelSelect.disabled = !!editingCategoryId;
  }
  fillParentSelect(
    level,
    cat?.parentId || defaults.parentId || (level === LEVEL_MID ? DEFAULT_MAJOR_ID : DEFAULT_MID_ID)
  );
  syncCategoryFormFields();
  categoryDialogEl.classList.remove("hidden");
  catNameInput.focus();
}

function closeCategoryDialog() {
  categoryDialogEl.classList.add("hidden");
  editingCategoryId = null;
  categoryFormEl.reset();
  if (catLevelSelect) catLevelSelect.disabled = false;
}

function renderCategoryRow(cat) {
  const active = activeFilter === cat.id;
  const count = countInCategory(cat.id);
  const canEdit = !cat.builtin;
  const indent =
    cat.level === LEVEL_MAJOR ? 0 : cat.level === LEVEL_MID ? 1 : 2;
  return `
    <div class="bm-cat-row bm-cat-level-${cat.level}${active ? " is-active" : ""}" data-cat-id="${escapeHtml(cat.id)}" style="--bm-cat-depth:${indent}">
      <button type="button" class="bm-cat-btn" data-cat-id="${escapeHtml(cat.id)}">
        <span class="bm-cat-level">${levelShort(cat.level)}</span>
        <span class="bm-cat-name">${escapeHtml(cat.name)}</span>
        <span class="bm-cat-count">${count}</span>
      </button>
      ${
        canEdit
          ? `<div class="bm-cat-actions">
          ${
            cat.level === LEVEL_MAJOR
              ? `<button type="button" class="bm-cat-add-child" data-level="${LEVEL_MID}" data-parent-id="${escapeHtml(cat.id)}" title="중분류 추가" aria-label="중분류 추가">＋</button>`
              : cat.level === LEVEL_MID
                ? `<button type="button" class="bm-cat-add-child" data-level="${LEVEL_MINOR}" data-parent-id="${escapeHtml(cat.id)}" title="소분류 추가" aria-label="소분류 추가">＋</button>`
                : ""
          }
          <button type="button" class="bm-cat-edit" data-cat-id="${escapeHtml(cat.id)}" title="이름 수정" aria-label="이름 수정">✏️</button>
          <button type="button" class="bm-cat-del" data-cat-id="${escapeHtml(cat.id)}" title="삭제" aria-label="삭제">🗑</button>
        </div>`
          : `<div class="bm-cat-actions bm-cat-actions-static">
          ${
            cat.level === LEVEL_MAJOR
              ? `<button type="button" class="bm-cat-add-child" data-level="${LEVEL_MID}" data-parent-id="${escapeHtml(cat.id)}" title="중분류 추가" aria-label="중분류 추가">＋</button>`
              : cat.level === LEVEL_MID
                ? `<button type="button" class="bm-cat-add-child" data-level="${LEVEL_MINOR}" data-parent-id="${escapeHtml(cat.id)}" title="소분류 추가" aria-label="소분류 추가">＋</button>`
                : ""
          }
        </div>`
      }
    </div>`;
}

function renderSidebar() {
  if (!categoryListEl) return;

  const majors = categories.filter((c) => c.level === LEVEL_MAJOR);
  let html = `
    <div class="bm-cat-row bm-cat-all${activeFilter === FILTER_ALL ? " is-active" : ""}" data-cat-id="${FILTER_ALL}">
      <button type="button" class="bm-cat-btn" data-cat-id="${FILTER_ALL}">
        <span class="bm-cat-level bm-cat-level-all">전</span>
        <span class="bm-cat-name">전체 보기</span>
        <span class="bm-cat-count">${countInCategory(FILTER_ALL)}</span>
      </button>
    </div>
    <div class="bm-cat-legend">
      <span>대분류</span><span>중분류</span><span>소분류</span>
    </div>`;

  for (const major of majors) {
    html += renderCategoryRow(major);
    const mids = categories.filter((c) => c.level === LEVEL_MID && c.parentId === major.id);
    for (const mid of mids) {
      html += renderCategoryRow(mid);
      const minors = categories.filter((c) => c.level === LEVEL_MINOR && c.parentId === mid.id);
      for (const minor of minors) {
        html += renderCategoryRow(minor);
      }
    }
  }

  categoryListEl.innerHTML = html;

  categoryListEl.querySelectorAll(".bm-cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveFilter(btn.dataset.catId));
  });

  categoryListEl.querySelectorAll(".bm-cat-add-child").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCategoryDialog(null, {
        level: Number(btn.dataset.level),
        parentId: btn.dataset.parentId,
      });
    });
  });

  categoryListEl.querySelectorAll(".bm-cat-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cat = getCategory(btn.dataset.catId);
      if (cat) openCategoryDialog(cat);
    });
  });

  categoryListEl.querySelectorAll(".bm-cat-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.catId;
      const cat = getCategory(id);
      if (!cat || cat.builtin) return;
      const label = levelLabel(cat.level);
      if (!confirm(`이 ${label}를 삭제할까요?\n하위 분류와 사이트는 「미분류」로 이동합니다.`)) return;
      const removeIds = new Set(collectDescendantIds(id));
      const removedLeafIds = [...removeIds].filter(
        (rid) => getCategory(rid)?.level === LEVEL_MINOR
      );
      categories = categories.filter((c) => !removeIds.has(c.id));
      items = items.map((x) =>
        removedLeafIds.includes(x.categoryId) ? { ...x, categoryId: UNCATEGORIZED_ID } : x
      );
      if (removeIds.has(activeFilter)) setActiveFilter(FILTER_ALL);
      try {
        await saveNow();
        renderSidebar();
        renderGrid();
        showToast(`${label}를 삭제했습니다.`);
      } catch (err) {
        showToast(err.message || "저장하지 못했습니다.", true);
      }
    });
  });

  updateSubText();
}

function renderGrid() {
  if (!gridEl) return;
  const sorted = filteredItems();
  const q = normalizedSearchQuery();
  if (!sorted.length) {
    gridEl.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    if (q) {
      emptyEl.textContent =
        activeFilter === FILTER_ALL
          ? `「${searchQuery.trim()}」에 맞는 사이트가 없습니다.`
          : `「${categoryName(activeFilter)}」에서 「${searchQuery.trim()}」에 맞는 사이트가 없습니다.`;
    } else if (activeFilter === FILTER_ALL) {
      emptyEl.textContent =
        "아직 등록된 사이트가 없습니다. 「+ 사이트 추가」로 링크를 넣어 보세요.";
    } else {
      emptyEl.textContent = `「${categoryName(activeFilter)}」에 사이트가 없습니다.`;
    }
    return;
  }
  emptyEl?.classList.add("hidden");
  gridEl.innerHTML = sorted
    .map((item) => {
      const desc = item.description?.trim();
      const pinned = !!item.pinned;
      const catLabel = categoryPath(item.categoryId || UNCATEGORIZED_ID);
      const siteEmoji = emojiForBookmark(item.title, item.url);
      return `
      <article class="bookmark-card${pinned ? " is-pinned" : ""}" data-id="${escapeHtml(item.id)}">
        <div class="bookmark-card-rail" aria-label="카드 메뉴">
          <button
            type="button"
            class="bm-pin${pinned ? " is-on" : ""}"
            data-id="${escapeHtml(item.id)}"
            title="${pinned ? "고정 해제" : "상단에 고정"}"
            aria-label="${pinned ? "고정 해제" : "상단에 고정"}"
            aria-pressed="${pinned ? "true" : "false"}"
          >📌</button>
          <div class="bookmark-card-actions">
            <button type="button" class="bm-edit" data-id="${escapeHtml(item.id)}" title="수정" aria-label="수정">✏️</button>
            <button type="button" class="bm-del" data-id="${escapeHtml(item.id)}" title="삭제" aria-label="삭제">🗑</button>
          </div>
        </div>
        <div class="bookmark-card-head">
          <h3 class="bookmark-card-title">
            <span class="bm-site-emoji" aria-hidden="true">${siteEmoji}</span>
            <span class="bm-site-name">${escapeHtml(item.title)}</span>
          </h3>
        </div>
        ${
          activeFilter === FILTER_ALL
            ? `<span class="bookmark-card-cat">${escapeHtml(catLabel)}</span>`
            : ""
        }
        <p class="bookmark-card-desc${desc ? "" : " is-empty"}">${desc ? escapeHtml(desc) : "설명 없음"}</p>
        <a class="bookmark-card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(item.url)}">
          ${escapeHtml(hostLabel(item.url))} ↗
        </a>
      </article>`;
    })
    .join("");

  bindCardActions();
  loadVisiblePreviews(sorted);
}

const previewPending = new Set();
let previewSaveTimer = null;
const previewWaiters = [];
let previewActive = 0;
const PREVIEW_CONCURRENCY = 2;

function cssUrlValue(url) {
  return `url("${String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

function applyPreviewToCard(item) {
  if (!item?.previewUrl || !gridEl) return;
  const card = gridEl.querySelector(`.bookmark-card[data-id="${CSS.escape(item.id)}"]`);
  if (!card) return;

  const probe = new Image();
  probe.onload = () => {
    if (!gridEl.contains(card)) return;
    card.classList.add("has-preview");
    card.style.setProperty("--bm-preview-image", cssUrlValue(item.previewUrl));
  };
  probe.onerror = () => {
    card.classList.remove("has-preview");
    card.style.removeProperty("--bm-preview-image");
  };
  probe.src = item.previewUrl;
}

function schedulePreviewSave() {
  clearTimeout(previewSaveTimer);
  previewSaveTimer = setTimeout(async () => {
    try {
      await saveNow();
    } catch (_) {}
  }, 2500);
}

async function fetchPreviewUrl(pageUrl) {
  const res = await fetch(`/api/bookmarks/preview?url=${encodeURIComponent(pageUrl)}`, {
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "미리보기 실패");
  return data.previewUrl || null;
}

function pumpPreviewQueue() {
  while (previewActive < PREVIEW_CONCURRENCY && previewWaiters.length) {
    const job = previewWaiters.shift();
    previewActive += 1;
    job().finally(() => {
      previewActive -= 1;
      pumpPreviewQueue();
    });
  }
}

function queuePreviewLoad(item) {
  if (!item?.url || item.previewUrl || previewPending.has(item.id)) return;
  previewPending.add(item.id);
  previewWaiters.push(async () => {
    try {
      const previewUrl = await fetchPreviewUrl(item.url);
      if (!previewUrl) return;
      const idx = items.findIndex((x) => x.id === item.id);
      if (idx === -1) return;
      items[idx] = { ...items[idx], previewUrl };
      applyPreviewToCard(items[idx]);
      schedulePreviewSave();
    } catch (_) {
    } finally {
      previewPending.delete(item.id);
    }
  });
  pumpPreviewQueue();
}

function loadVisiblePreviews(list) {
  list.forEach((item) => {
    if (item.previewUrl) applyPreviewToCard(item);
    else queuePreviewLoad(item);
  });
}

function bindCardActions() {
  gridEl.querySelectorAll(".bm-pin").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.dataset.id;
      items = items.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x));
      try {
        await saveNow();
        renderSidebar();
        renderGrid();
        const pinned = items.find((x) => x.id === id)?.pinned;
        showToast(pinned ? "상단에 고정했습니다." : "고정을 해제했습니다.");
      } catch (err) {
        showToast(err.message || "저장하지 못했습니다.", true);
      }
    });
  });

  gridEl.querySelectorAll(".bm-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = items.find((x) => x.id === btn.dataset.id);
      if (item) openDialog(item);
    });
  });

  gridEl.querySelectorAll(".bm-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm("이 사이트 카드를 삭제할까요?")) return;
      items = items.filter((x) => x.id !== id);
      try {
        await saveNow();
        renderSidebar();
        renderGrid();
        showToast("삭제했습니다.");
      } catch (err) {
        showToast(err.message || "저장하지 못했습니다.", true);
      }
    });
  });
}

function render() {
  renderSidebar();
  renderGrid();
}

async function load() {
  try {
    const res = await fetch("/api/bookmarks", { credentials: "include" });
    if (res.status === 401) {
      window.top.location.href = "/login";
      return;
    }
    const data = await res.json();
    categories = Array.isArray(data.categories) ? data.categories : [];
    items = Array.isArray(data.items) ? data.items : [];
    if (
      activeFilter !== FILTER_ALL &&
      !categories.some((c) => c.id === activeFilter)
    ) {
      activeFilter = FILTER_ALL;
      localStorage.setItem(FILTER_KEY, FILTER_ALL);
    }
    render();
  } catch (err) {
    showToast("불러오지 못했습니다.", true);
  }
}

async function saveNow() {
  const res = await fetch("/api/bookmarks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ categories, items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "저장 실패");
  categories = Array.isArray(data.categories) ? data.categories : categories;
  items = Array.isArray(data.items) ? data.items : items;
}

document.getElementById("addBookmarkBtn")?.addEventListener("click", () => openDialog(null));
document.getElementById("addMajorBtn")?.addEventListener("click", () =>
  openCategoryDialog(null, { level: LEVEL_MAJOR })
);
document.getElementById("addMidBtn")?.addEventListener("click", () =>
  openCategoryDialog(null, { level: LEVEL_MID, parentId: DEFAULT_MAJOR_ID })
);
document.getElementById("addMinorBtn")?.addEventListener("click", () =>
  openCategoryDialog(null, { level: LEVEL_MINOR, parentId: DEFAULT_MID_ID })
);
document.getElementById("bmCancelBtn")?.addEventListener("click", closeDialog);
document.getElementById("catCancelBtn")?.addEventListener("click", closeCategoryDialog);

catLevelSelect?.addEventListener("change", syncCategoryFormFields);

searchInput?.addEventListener("input", () => setSearchQuery(searchInput.value));
searchInput?.addEventListener("search", () => setSearchQuery(searchInput.value));
searchClearBtn?.addEventListener("click", () => {
  setSearchQuery("");
  searchInput?.focus();
});

dialogEl?.addEventListener("click", (e) => {
  if (e.target === dialogEl) closeDialog();
});
categoryDialogEl?.addEventListener("click", (e) => {
  if (e.target === categoryDialogEl) closeCategoryDialog();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!dialogEl.classList.contains("hidden")) closeDialog();
  if (!categoryDialogEl.classList.contains("hidden")) closeCategoryDialog();
});

formEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const url = normalizeUrl(urlInput.value);
  const description = descInput.value.trim();
  const categoryId = categorySelect.value || UNCATEGORIZED_ID;
  if (!title) {
    showToast("사이트 이름을 입력해 주세요.", true);
    return;
  }
  if (!url) {
    showToast("주소를 입력해 주세요.", true);
    return;
  }
  try {
    new URL(url);
  } catch {
    showToast("올바른 주소 형식이 아닙니다.", true);
    return;
  }

  if (editingId) {
    items = items.map((x) => {
      if (x.id !== editingId) return x;
      const next = { ...x, title, url, description, categoryId };
      if (x.url !== url) delete next.previewUrl;
      return next;
    });
  } else {
    items.push({
      id: crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2),
      title,
      url,
      description,
      categoryId,
      pinned: false,
      createdAt: Date.now(),
    });
  }

  try {
    await saveNow();
    render();
    closeDialog();
    showToast(editingId ? "수정했습니다." : "추가했습니다.");
  } catch (err) {
    showToast(err.message || "저장하지 못했습니다.", true);
  }
});

categoryFormEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = catNameInput.value.trim();
  const level = Number(catLevelSelect?.value || LEVEL_MINOR);
  const parentId =
    level === LEVEL_MAJOR ? null : catParentSelect?.value || null;
  if (!name) {
    showToast("분류 이름을 입력해 주세요.", true);
    return;
  }
  if (level !== LEVEL_MAJOR && !parentId) {
    showToast("상위 분류를 선택해 주세요.", true);
    return;
  }

  if (editingCategoryId) {
    categories = categories.map((c) =>
      c.id === editingCategoryId ? { ...c, name } : c
    );
  } else {
    const id = crypto.randomUUID?.() || uidFallback();
    categories.push({
      id,
      name,
      level,
      parentId,
      order: categories.filter((c) => c.level === level && c.parentId === parentId).length,
      builtin: false,
      createdAt: Date.now(),
    });
    if (level === LEVEL_MINOR) setActiveFilter(id);
  }

  try {
    await saveNow();
    render();
    closeCategoryDialog();
    showToast(editingCategoryId ? "분류를 수정했습니다." : "분류를 추가했습니다.");
  } catch (err) {
    showToast(err.message || "저장하지 못했습니다.", true);
  }
});

function uidFallback() {
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

load();
