/** 자주 가는 사이트 — 링크 카드 */

let items = [];
let editingId = null;

const gridEl = document.getElementById("bookmarkGrid");
const emptyEl = document.getElementById("bookmarkEmpty");
const dialogEl = document.getElementById("bookmarkDialog");
const formEl = document.getElementById("bookmarkForm");
const titleInput = document.getElementById("bmTitle");
const urlInput = document.getElementById("bmUrl");
const descInput = document.getElementById("bmDesc");
const dialogTitleEl = document.getElementById("bookmarkDialogTitle");
const toastEl = document.getElementById("bookmarkToast");

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

function openDialog(item) {
  editingId = item?.id || null;
  dialogTitleEl.textContent = editingId ? "사이트 수정" : "사이트 추가";
  titleInput.value = item?.title || "";
  urlInput.value = item?.url || "";
  descInput.value = item?.description || "";
  dialogEl.classList.remove("hidden");
  titleInput.focus();
}

function closeDialog() {
  dialogEl.classList.add("hidden");
  editingId = null;
  formEl.reset();
}

function render() {
  if (!gridEl) return;
  if (!items.length) {
    gridEl.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");
  gridEl.innerHTML = items
    .map((item) => {
      const desc = item.description?.trim();
      return `
      <article class="bookmark-card" data-id="${escapeHtml(item.id)}">
        <div class="bookmark-card-head">
          <h3 class="bookmark-card-title">${escapeHtml(item.title)}</h3>
          <div class="bookmark-card-actions">
            <button type="button" class="bm-edit" data-id="${escapeHtml(item.id)}" title="수정" aria-label="수정">✏️</button>
            <button type="button" class="bm-del" data-id="${escapeHtml(item.id)}" title="삭제" aria-label="삭제">🗑</button>
          </div>
        </div>
        <p class="bookmark-card-desc${desc ? "" : " is-empty"}">${desc ? escapeHtml(desc) : "설명 없음"}</p>
        <a class="bookmark-card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(item.url)}">
          ${escapeHtml(hostLabel(item.url))} ↗
        </a>
      </article>`;
    })
    .join("");

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
      await saveNow();
      render();
      showToast("삭제했습니다.");
    });
  });
}

async function load() {
  try {
    const res = await fetch("/api/bookmarks", { credentials: "include" });
    if (res.status === 401) {
      window.top.location.href = "/login";
      return;
    }
    const data = await res.json();
    items = Array.isArray(data.items) ? data.items : [];
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
    body: JSON.stringify({ items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "저장 실패");
  items = Array.isArray(data.items) ? data.items : items;
}

document.getElementById("addBookmarkBtn")?.addEventListener("click", () => openDialog(null));

document.getElementById("bmCancelBtn")?.addEventListener("click", closeDialog);

dialogEl?.addEventListener("click", (e) => {
  if (e.target === dialogEl) closeDialog();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dialogEl.classList.contains("hidden")) closeDialog();
});

formEl?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  const url = normalizeUrl(urlInput.value);
  const description = descInput.value.trim();
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
      x.id === editingId ? { ...x, title, url, description } : x
    );
  } else {
    items.push({
      id: crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2),
      title,
      url,
      description,
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

load();
