/**
 * Original kawaii animal doodle avatars for 눈치 O/X.
 * Not derived from any copyrighted character collage or game art.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "public", "ox-avatars");
fs.mkdirSync(dir, { recursive: true });

const kinds = [
  "bunny", "bunny", "bunny", "bunny",
  "cat", "cat", "cat", "cat",
  "frog", "frog", "frog", "frog",
  "hedgehog", "hedgehog", "hedgehog", "hedgehog",
  "dog", "dog", "dog", "dog",
  "bunny", "cat", "frog", "hedgehog",
  "dog", "bunny", "cat", "frog",
  "hedgehog", "dog", "bunny", "cat",
];

const fills = {
  bunny: ["#FFF8F0", "#FFE8F0", "#FFF5E6", "#F0F7FF"],
  cat: ["#F7B267", "#E8A87C", "#FFD6A5", "#D4A373"],
  frog: ["#8FCB8F", "#A8E6A1", "#7BC47F", "#B5E48C"],
  hedgehog: ["#C4A484", "#A67C52", "#D2B48C", "#B08968"],
  dog: ["#F5E6C8", "#E6D5B8", "#FFEFD5", "#DECBAA"],
};

function eyes() {
  return `<circle cx="40" cy="48" r="2.2" fill="#1a1a1a"/><circle cx="60" cy="48" r="2.2" fill="#1a1a1a"/>`;
}

function blush() {
  return `<ellipse cx="32" cy="56" rx="4" ry="2.5" fill="#FFB4C0" opacity="0.7"/><ellipse cx="68" cy="56" rx="4" ry="2.5" fill="#FFB4C0" opacity="0.7"/>`;
}

function mouth(i) {
  const m = i % 3;
  if (m === 0) return `<path d="M46 58 Q50 62 54 58" fill="none" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round"/>`;
  if (m === 1) return `<circle cx="50" cy="59" r="1.4" fill="#1a1a1a"/>`;
  return `<path d="M47 59 Q50 57 53 59" fill="none" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round"/>`;
}

function shadow() {
  return `<ellipse cx="50" cy="90" rx="22" ry="4" fill="#000" opacity="0.08"/>`;
}

function bunny(fill, i) {
  return `${shadow()}
  <ellipse cx="36" cy="28" rx="9" ry="16" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <ellipse cx="64" cy="28" rx="9" ry="16" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <ellipse cx="36" cy="30" rx="4" ry="10" fill="#FFD6E0"/>
  <ellipse cx="64" cy="30" rx="4" ry="10" fill="#FFD6E0"/>
  <ellipse cx="50" cy="58" rx="28" ry="26" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  ${blush()}${eyes()}${mouth(i)}`;
}

function cat(fill, i) {
  return `${shadow()}
  <path d="M28 42 L34 22 L44 40" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M56 40 L66 22 L72 42" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8" stroke-linejoin="round"/>
  <ellipse cx="50" cy="58" rx="28" ry="26" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <path d="M38 44 Q42 48 38 52" fill="none" stroke="#C47A3A" stroke-width="1.4"/>
  <path d="M62 44 Q58 48 62 52" fill="none" stroke="#C47A3A" stroke-width="1.4"/>
  ${blush()}${eyes()}${mouth(i)}
  <path d="M50 54 L48 58 L52 58 Z" fill="#FF9AA2" stroke="#1a1a1a" stroke-width="1"/>`;
}

function frog(fill, i) {
  return `${shadow()}
  <ellipse cx="50" cy="60" rx="30" ry="24" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <circle cx="36" cy="42" r="10" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <circle cx="64" cy="42" r="10" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <circle cx="36" cy="42" r="3.5" fill="#1a1a1a"/>
  <circle cx="64" cy="42" r="3.5" fill="#1a1a1a"/>
  <circle cx="37.5" cy="40.5" r="1.2" fill="#fff"/>
  <circle cx="65.5" cy="40.5" r="1.2" fill="#fff"/>
  <path d="M30 62 Q50 55 70 62 L70 72 Q50 78 30 72 Z" fill="#7EB6D9" stroke="#1a1a1a" stroke-width="1.6"/>
  ${mouth(i)}`;
}

function hedgehog(fill, i) {
  return `${shadow()}
  <path d="M22 58 Q30 28 50 24 Q70 28 78 58 Q70 78 50 80 Q30 78 22 58 Z" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <path d="M30 40 L26 28 M40 32 L38 20 M50 28 L50 16 M60 32 L62 20 M70 40 L74 28" stroke="#6B4F3A" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="50" cy="62" rx="18" ry="14" fill="#F8E8D0" stroke="#1a1a1a" stroke-width="1.5"/>
  ${blush()}${eyes()}${mouth(i)}`;
}

function dog(fill, i) {
  const hat = i % 2 === 0
    ? `<ellipse cx="50" cy="30" rx="22" ry="8" fill="#E8C07A" stroke="#1a1a1a" stroke-width="1.6"/><rect x="38" y="30" width="24" height="6" rx="2" fill="#E8C07A" stroke="#1a1a1a" stroke-width="1.2"/>`
    : "";
  return `${shadow()}
  ${hat}
  <ellipse cx="28" cy="52" rx="10" ry="14" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <ellipse cx="72" cy="52" rx="10" ry="14" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <ellipse cx="50" cy="58" rx="28" ry="26" fill="${fill}" stroke="#1a1a1a" stroke-width="1.8"/>
  <ellipse cx="50" cy="62" rx="8" ry="6" fill="#F5D0C0" stroke="#1a1a1a" stroke-width="1.3"/>
  ${blush()}${eyes()}${mouth(i)}`;
}

function draw(id) {
  const kind = kinds[id % kinds.length];
  const palette = fills[kind];
  const fill = palette[id % palette.length];
  let body = "";
  if (kind === "bunny") body = bunny(fill, id);
  else if (kind === "cat") body = cat(fill, id);
  else if (kind === "frog") body = frog(fill, id);
  else if (kind === "hedgehog") body = hedgehog(fill, id);
  else body = dog(fill, id);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
${body}
</svg>
`;
}

for (let i = 0; i < 32; i++) {
  fs.writeFileSync(path.join(dir, `${i}.svg`), draw(i));
}
fs.writeFileSync(
  path.join(dir, "README.txt"),
  "Original kawaii animal doodles for OX lobby. Not copied from Claw Master or any IP collage.\n"
);
console.log("wrote 32 animal doodle avatars");
