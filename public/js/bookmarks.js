/** 자주 가는 사이트 — 링크 카드 + 카테고리 */

const UNCATEGORIZED_ID = "uncategorized";
const FILTER_ALL = "__all__";
const FILTER_KEY = "bmActiveCategory";

let categories = [];
let items = [];
let editingId = null;
let editingCategoryId = null;
let activeFilter = localStorage.getItem(FILTER_KEY) || FILTER_ALL;

const gridEl = document.getElementById("bookmarkGrid");
const emptyEl = document.getElementById("bookmarkEmpty");
const categoryListEl = document.getElementById("categoryList");
const subEl = document.getElementById("bookmarksSub");
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

function sortItems(list) {
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const byTitle = titleCollator.compare(a.title || "", b.title || "");
    if (byTitle !== 0) return byTitle;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function countInCategory(catId) {
  if (catId === FILTER_ALL) return items.length;
  return items.filter((x) => (x.categoryId || UNCATEGORIZED_ID) === catId).length;
}

function categoryName(catId) {
  if (catId === FILTER_ALL) return "전체";
  return categories.find((c) => c.id === catId)?.name || "미분류";
}

function setActiveFilter(catId) {
  activeFilter = catId;
  localStorage.setItem(FILTER_KEY, catId);
  renderSidebar();
  renderGrid();
}

function filteredItems() {
  const list =
    activeFilter === FILTER_ALL
      ? items
      : items.filter((x) => (x.categoryId || UNCATEGORIZED_ID) === activeFilter);
  return sortItems(list);
}

function fillCategorySelect(selectedId) {
  if (!categorySelect) return;
  categorySelect.innerHTML = categories
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(c.name)}</option>`
    )
    .join("");
}

function openDialog(item) {
  editingId = item?.id || null;
  dialogTitleEl.textContent = editingId ? "사이트 수정" : "사이트 추가";
  titleInput.value = item?.title || "";
  urlInput.value = item?.url || "";
  descInput.value = item?.description || "";
  const cat =
    item?.categoryId ||
    (activeFilter !== FILTER_ALL ? activeFilter : UNCATEGORIZED_ID);
  fillCategorySelect(cat);
  dialogEl.classList.remove("hidden");
  titleInput.focus();
}

function closeDialog() {
  dialogEl.classList.add("hidden");
  editingId = null;
  formEl.reset();
}

function openCategoryDialog(cat) {
  editingCategoryId = cat?.id || null;
  if (cat?.builtin) return;
  categoryDialogTitleEl.textContent = editingCategoryId ? "카테고리 수정" : "카테고리 추가";
  catNameInput.value = cat?.name || "";
  categoryDialogEl.classList.remove("hidden");
  catNameInput.focus();
}

function closeCategoryDialog() {
  categoryDialogEl.classList.add("hidden");
  editingCategoryId = null;
  categoryFormEl.reset();
}

function renderSidebar() {
  if (!categoryListEl) return;
  const rows = [
    { id: FILTER_ALL, name: "전체", builtin: true },
    ...categories,
  ];

  categoryListEl.innerHTML = rows
    .map((cat) => {
      const active = activeFilter === cat.id;
      const count = countInCategory(cat.id);
      const canEdit = !cat.builtin && cat.id !== FILTER_ALL;
      return `
      <div class="bm-cat-row${active ? " is-active" : ""}" data-cat-id="${escapeHtml(cat.id)}">
        <button type="button" class="bm-cat-btn" data-cat-id="${escapeHtml(cat.id)}">
          <span class="bm-cat-name">${escapeHtml(cat.name)}</span>
          <span class="bm-cat-count">${count}</span>
        </button>
        ${
          canEdit
            ? `<div class="bm-cat-actions">
            <button type="button" class="bm-cat-edit" data-cat-id="${escapeHtml(cat.id)}" title="이름 수정" aria-label="이름 수정">✏️</button>
            <button type="button" class="bm-cat-del" data-cat-id="${escapeHtml(cat.id)}" title="삭제" aria-label="삭제">🗑</button>
          </div>`
            : ""
        }
      </div>`;
    })
    .join("");

  categoryListEl.querySelectorAll(".bm-cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => setActiveFilter(btn.dataset.catId));
  });

  categoryListEl.querySelectorAll(".bm-cat-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cat = categories.find((c) => c.id === btn.dataset.catId);
      if (cat) openCategoryDialog(cat);
    });
  });

  categoryListEl.querySelectorAll(".bm-cat-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.catId;
      if (!confirm("이 카테고리를 삭제할까요? 사이트는 「미분류」로 이동합니다.")) return;
      categories = categories.filter((c) => c.id !== id);
      items = items.map((x) =>
        x.categoryId === id ? { ...x, categoryId: UNCATEGORIZED_ID } : x
      );
      if (activeFilter === id) setActiveFilter(FILTER_ALL);
      try {
        await saveNow();
        renderSidebar();
        renderGrid();
        showToast("카테고리를 삭제했습니다.");
      } catch (err) {
        showToast(err.message || "저장하지 못했습니다.", true);
      }
    });
  });

  if (subEl) {
    const label = categoryName(activeFilter);
    subEl.textContent =
      activeFilter === FILTER_ALL
        ? "전체 사이트를 가나다순으로 보여 줍니다. 고정한 카드는 맨 위에 표시됩니다."
        : `「${label}」 카테고리 · ${countInCategory(activeFilter)}개`;
  }
}

function renderGrid() {
  if (!gridEl) return;
  const sorted = filteredItems();
  if (!sorted.length) {
    gridEl.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    emptyEl.textContent =
      activeFilter === FILTER_ALL
        ? "아직 등록된 사이트가 없습니다. 「+ 사이트 추가」로 링크를 넣어 보세요."
        : `「${categoryName(activeFilter)}」에 사이트가 없습니다.`;
    return;
  }
  emptyEl?.classList.add("hidden");
  gridEl.innerHTML = sorted
    .map((item) => {
      const desc = item.description?.trim();
      const pinned = !!item.pinned;
      const catLabel = categoryName(item.categoryId || UNCATEGORIZED_ID);
      return `
      <article class="bookmark-card${pinned ? " is-pinned" : ""}" data-id="${escapeHtml(item.id)}">
        <button
          type="button"
          class="bm-pin${pinned ? " is-on" : ""}"
          data-id="${escapeHtml(item.id)}"
          title="${pinned ? "고정 해제" : "상단에 고정"}"
          aria-label="${pinned ? "고정 해제" : "상단에 고정"}"
          aria-pressed="${pinned ? "true" : "false"}"
        >📌</button>
        <div class="bookmark-card-head">
          <h3 class="bookmark-card-title">${escapeHtml(item.title)}</h3>
          <div class="bookmark-card-actions">
            <button type="button" class="bm-edit" data-id="${escapeHtml(item.id)}" title="수정" aria-label="수정">✏️</button>
            <button type="button" class="bm-del" data-id="${escapeHtml(item.id)}" title="삭제" aria-label="삭제">🗑</button>
          </div>
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
document.getElementById("addCategoryBtn")?.addEventListener("click", () => openCategoryDialog(null));
document.getElementById("bmCancelBtn")?.addEventListener("click", closeDialog);
document.getElementById("catCancelBtn")?.addEventListener("click", closeCategoryDialog);

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
    items = items.map((x) =>
      x.id === editingId ? { ...x, title, url, description, categoryId } : x
    );
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
  if (!name) {
    showToast("카테고리 이름을 입력해 주세요.", true);
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
      order: categories.length,
      builtin: false,
      createdAt: Date.now(),
    });
    setActiveFilter(id);
  }

  try {
    await saveNow();
    render();
    closeCategoryDialog();
    showToast(editingCategoryId ? "카테고리를 수정했습니다." : "카테고리를 추가했습니다.");
  } catch (err) {
    showToast(err.message || "저장하지 못했습니다.", true);
  }
});

function uidFallback() {
  return String(Date.now()) + Math.random().toString(16).slice(2);
}

load();
