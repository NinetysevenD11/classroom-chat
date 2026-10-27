/** 네컷 만화 — 업로드 · AI 그림체 · 말풍선 · PNG 저장 */

const W = 2360;
const H = 1840;
const MARGIN = 48;
const GAP = 28;
const PANEL_W = (W - MARGIN * 2 - GAP) / 2;
const PANEL_H = (H - MARGIN * 2 - GAP) / 2;

const STYLES = [
  { id: "anime", label: "학원 만화", desc: "또렷한 만화·애니 그림체" },
  { id: "watercolor", label: "수채화", desc: "부드러운 동화책 느낌" },
  { id: "crayon", label: "크레용", desc: "따뜻하고 장난스러운 터치" },
  { id: "pixel", label: "픽셀 아트", desc: "레트로 게임 도트 그림" },
];

const photos = [null, null, null, null];
const stylized = [null, null, null, null];
let selectedStyle = "anime";
let bubbles = [];
let bubbleSeq = 1;
let pendingBubblePos = null;

const canvas = document.getElementById("comicCanvas");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("comicStage");
const bubbleLayer = document.getElementById("bubbleLayer");
const statusEl = document.getElementById("comicStatus");
const makeBtn = document.getElementById("makeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const addBubbleBtn = document.getElementById("addBubbleBtn");
const clearBubblesBtn = document.getElementById("clearBubblesBtn");
const bubbleDialog = document.getElementById("bubbleDialog");
const bubbleText = document.getElementById("bubbleText");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("is-error", !!isError);
}

function panelRect(i) {
  const col = i % 2;
  const row = Math.floor(i / 2);
  return {
    x: MARGIN + col * (PANEL_W + GAP),
    y: MARGIN + row * (PANEL_H + GAP),
    w: PANEL_W,
    h: PANEL_H,
  };
}

function drawCover(img, x, y, w, h) {
  const ir = img.width / img.height;
  const br = w / h;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (ir > br) {
    sw = img.height * br;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / br;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function redrawCanvas() {
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#f7f4ee";
  ctx.fillRect(18, 18, W - 36, H - 36);

  for (let i = 0; i < 4; i++) {
    const r = panelRect(i);
    ctx.fillStyle = "#ddd8d0";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 8;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    const src = stylized[i] || photos[i];
    if (!src) {
      ctx.fillStyle = "#8a847a";
      ctx.font = "700 64px Nunito, 'Noto Sans KR', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${i + 1}`, r.x + r.w / 2, r.y + r.h / 2);
      continue;
    }
    try {
      const img = await loadImage(src);
      drawCover(img, r.x, r.y, r.w, r.h);
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 8;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } catch (_) {
      /* ignore */
    }
  }
}

function resizeImageFile(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderSlots() {
  const root = document.getElementById("photoSlots");
  root.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const slot = document.createElement("div");
    slot.className = "comic-slot" + (photos[i] ? " has-photo" : "");
    slot.innerHTML = `<span class="slot-num">${i + 1}</span>`;
    if (photos[i]) {
      const img = document.createElement("img");
      img.src = photos[i];
      img.alt = `${i + 1}번 사진`;
      slot.appendChild(img);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "slot-clear";
      clear.setAttribute("aria-label", "사진 지우기");
      clear.textContent = "×";
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        photos[i] = null;
        stylized[i] = null;
        renderSlots();
        redrawCanvas();
        updateActionState();
      });
      slot.appendChild(clear);
    } else {
      const label = document.createElement("span");
      label.className = "slot-label";
      label.textContent = "사진 올리기";
      slot.appendChild(label);
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        photos[i] = await resizeImageFile(file);
        stylized[i] = null;
        setStatus("");
        renderSlots();
        await redrawCanvas();
        updateActionState();
      } catch (_) {
        setStatus("사진을 불러오지 못했어요.", true);
      }
    });
    slot.appendChild(input);
    root.appendChild(slot);
  }
}

function renderStyles() {
  const root = document.getElementById("styleList");
  root.innerHTML = "";
  for (const s of STYLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comic-style" + (selectedStyle === s.id ? " is-selected" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", selectedStyle === s.id ? "true" : "false");
    btn.innerHTML = `<strong>${s.label}</strong><span>${s.desc}</span>`;
    btn.addEventListener("click", () => {
      selectedStyle = s.id;
      renderStyles();
    });
    root.appendChild(btn);
  }
}

function updateActionState() {
  const ready = photos.every(Boolean);
  makeBtn.disabled = !ready;
  const hasArt = stylized.some(Boolean) || photos.some(Boolean);
  downloadBtn.disabled = !hasArt;
  addBubbleBtn.disabled = !hasArt;
  clearBubblesBtn.disabled = bubbles.length === 0;
}

function clientToPercent(clientX, clientY) {
  const rect = stage.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * 100,
    y: ((clientY - rect.top) / rect.height) * 100,
  };
}

function renderBubbles() {
  bubbleLayer.innerHTML = "";
  for (const b of bubbles) {
    const el = document.createElement("div");
    el.className = "speech-bubble";
    el.style.left = `${b.x}%`;
    el.style.top = `${b.y}%`;
    el.dataset.id = b.id;

    const text = document.createElement("span");
    text.className = "bubble-text";
    text.textContent = b.text;
    text.title = "클릭해서 수정";
    text.addEventListener("click", (e) => {
      e.stopPropagation();
      editBubble(b.id);
    });
    el.appendChild(text);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "bubble-del";
    del.setAttribute("aria-label", "말풍선 삭제");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      bubbles = bubbles.filter((x) => x.id !== b.id);
      renderBubbles();
      updateActionState();
    });
    el.appendChild(del);

    let dragging = false;
    let start = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.target === del || e.target === text) return;
      dragging = true;
      el.classList.add("is-dragging");
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, bx: b.x, by: b.y };
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging || !start) return;
      const rect = stage.getBoundingClientRect();
      const dx = ((e.clientX - start.x) / rect.width) * 100;
      const dy = ((e.clientY - start.y) / rect.height) * 100;
      b.x = Math.min(92, Math.max(8, start.bx + dx));
      b.y = Math.min(92, Math.max(8, start.by + dy));
      el.style.left = `${b.x}%`;
      el.style.top = `${b.y}%`;
    });
    el.addEventListener("pointerup", () => {
      dragging = false;
      el.classList.remove("is-dragging");
      start = null;
    });

    bubbleLayer.appendChild(el);
  }
  updateActionState();
}

function openBubbleDialog(initial = "") {
  bubbleText.value = initial;
  if (typeof bubbleDialog.showModal === "function") bubbleDialog.showModal();
  else bubbleDialog.setAttribute("open", "");
  setTimeout(() => bubbleText.focus(), 30);
}

function editBubble(id) {
  const b = bubbles.find((x) => x.id === id);
  if (!b) return;
  pendingBubblePos = { editId: id };
  openBubbleDialog(b.text);
}

addBubbleBtn.addEventListener("click", () => {
  setStatus("프레임 위를 클릭해서 말풍선 위치를 정하세요.");
  stage.style.cursor = "crosshair";
  const onClick = (e) => {
    stage.style.cursor = "";
    stage.removeEventListener("click", onClick);
    pendingBubblePos = clientToPercent(e.clientX, e.clientY);
    openBubbleDialog("");
  };
  stage.addEventListener("click", onClick, { once: true });
});

clearBubblesBtn.addEventListener("click", () => {
  bubbles = [];
  renderBubbles();
});

document.getElementById("bubbleForm").addEventListener("submit", (e) => {
  const submitter = e.submitter;
  const value = submitter?.value || "ok";
  if (value === "cancel") {
    pendingBubblePos = null;
    return;
  }
  e.preventDefault();
  const text = bubbleText.value.trim();
  if (!text) {
    setStatus("말풍선 글을 입력해 주세요.", true);
    return;
  }
  if (pendingBubblePos?.editId) {
    const b = bubbles.find((x) => x.id === pendingBubblePos.editId);
    if (b) b.text = text.slice(0, 80);
  } else {
    const pos = pendingBubblePos || { x: 50, y: 30 };
    bubbles.push({
      id: `b${bubbleSeq++}`,
      text: text.slice(0, 80),
      x: pos.x ?? 50,
      y: pos.y ?? 30,
    });
  }
  pendingBubblePos = null;
  bubbleDialog.close();
  renderBubbles();
  setStatus("");
});

async function stylizeOne(index, style) {
  const res = await fetch("/api/comic/stylize", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl: photos[index], style }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `${index + 1}번 사진 변환 실패`);
  }
  stylized[index] = data.image;
}

makeBtn.addEventListener("click", async () => {
  if (!photos.every(Boolean)) {
    setStatus("사진 4장을 모두 올려 주세요.", true);
    return;
  }
  makeBtn.disabled = true;
  downloadBtn.disabled = true;
  try {
    for (let i = 0; i < 4; i++) {
      setStatus(`AI 그림체 변환 중… (${i + 1}/4)`);
      await stylizeOne(i, selectedStyle);
      await redrawCanvas();
    }
    setStatus("완성! 말풍선을 넣고 PNG로 저장하세요.");
  } catch (err) {
    setStatus(err.message || "변환에 실패했습니다.", true);
  } finally {
    updateActionState();
  }
});

function wrapText(context, text, maxWidth) {
  const chars = String(text || "").split("");
  const lines = [];
  let line = "";
  for (const ch of chars) {
    const test = line + ch;
    if (context.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawBubblesOnCtx(targetCtx, width, height) {
  for (const b of bubbles) {
    const cx = (b.x / 100) * width;
    const cy = (b.y / 100) * height;
    const fontSize = Math.max(28, Math.round(width * 0.018));
    targetCtx.font = `700 ${fontSize}px Nunito, "Noto Sans KR", sans-serif`;
    const lines = wrapText(targetCtx, b.text, width * 0.28);
    const lineH = fontSize * 1.35;
    const padX = fontSize * 0.9;
    const padY = fontSize * 0.7;
    const textW = Math.max(...lines.map((l) => targetCtx.measureText(l).width), 40);
    const boxW = textW + padX * 2;
    const boxH = lines.length * lineH + padY * 2;
    const left = cx - boxW / 2;
    const top = cy - boxH / 2;

    targetCtx.fillStyle = "#fff";
    targetCtx.strokeStyle = "#111";
    targetCtx.lineWidth = Math.max(4, width * 0.0025);
    roundRect(targetCtx, left, top, boxW, boxH, fontSize * 0.7);
    targetCtx.fill();
    targetCtx.stroke();

    const tail = fontSize * 0.55;
    targetCtx.beginPath();
    targetCtx.moveTo(cx - tail, top + boxH - 2);
    targetCtx.lineTo(cx, top + boxH + tail * 1.4);
    targetCtx.lineTo(cx + tail, top + boxH - 2);
    targetCtx.closePath();
    targetCtx.fill();
    targetCtx.stroke();
    targetCtx.fillStyle = "#fff";
    targetCtx.fillRect(cx - tail + 2, top + boxH - targetCtx.lineWidth * 2, tail * 2 - 4, targetCtx.lineWidth * 3);

    targetCtx.fillStyle = "#111";
    targetCtx.textAlign = "center";
    targetCtx.textBaseline = "top";
    lines.forEach((line, i) => {
      targetCtx.fillText(line, cx, top + padY + i * lineH);
    });
  }
}

function roundRect(c, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

downloadBtn.addEventListener("click", async () => {
  await redrawCanvas();
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = W;
  exportCanvas.height = H;
  const ectx = exportCanvas.getContext("2d");
  ectx.drawImage(canvas, 0, 0);
  drawBubblesOnCtx(ectx, W, H);
  const a = document.createElement("a");
  a.href = exportCanvas.toDataURL("image/png");
  a.download = `네컷만화-${Date.now()}.png`;
  a.click();
});

renderSlots();
renderStyles();
redrawCanvas();
updateActionState();
