import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "public", "ox-avatars");
fs.mkdirSync(dir, { recursive: true });

const bodies = [
  "#FFB4A2", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF",
  "#FFADAD", "#FFE066", "#98D8C8", "#F7A072", "#E0BBE4", "#B5EAD7", "#FFDAC1", "#C7CEEA",
  "#FF9AA2", "#B5EAD7", "#E2F0CB", "#FFB7B2", "#A2D2FF", "#CDB4DB", "#FFC8DD", "#BDE0FE",
  "#A8E6CF", "#FFD3B6", "#DCEDC1", "#FFAAA5", "#D4A5A5", "#A8DADC", "#F1FAEE", "#E9C46A",
];
const accents = [
  "#2A1C16", "#5C3A21", "#1D3557", "#E76F51", "#2A9D8F", "#E9C46A", "#264653", "#F4A261", "#9B2226", "#005F73",
];
const hats = ["none", "beanie", "earCat", "earBunny", "sprout", "bow", "antenna", "cap", "flower", "star"];

function hatSvg(hat, body, accent) {
  switch (hat) {
    case "beanie":
      return `<ellipse cx="50" cy="28" rx="28" ry="14" fill="${accent}" stroke="#1a120e" stroke-width="3"/><rect x="22" y="28" width="56" height="10" rx="3" fill="${accent}" stroke="#1a120e" stroke-width="3"/>`;
    case "earCat":
      return `<path d="M28 40 L34 18 L44 38" fill="${body}" stroke="#1a120e" stroke-width="3" stroke-linejoin="round"/><path d="M56 38 L66 18 L72 40" fill="${body}" stroke="#1a120e" stroke-width="3" stroke-linejoin="round"/>`;
    case "earBunny":
      return `<ellipse cx="36" cy="18" rx="7" ry="16" fill="${body}" stroke="#1a120e" stroke-width="3"/><ellipse cx="64" cy="18" rx="7" ry="16" fill="${body}" stroke="#1a120e" stroke-width="3"/><ellipse cx="36" cy="18" rx="3" ry="9" fill="#FFC6FF"/><ellipse cx="64" cy="18" rx="3" ry="9" fill="#FFC6FF"/>`;
    case "sprout":
      return `<path d="M50 34 C50 20 62 16 66 24" fill="none" stroke="#2F8F45" stroke-width="3" stroke-linecap="round"/><ellipse cx="68" cy="22" rx="8" ry="5" fill="#57C46A" stroke="#1a120e" stroke-width="2"/>`;
    case "bow":
      return `<circle cx="50" cy="30" r="5" fill="#E85A5A" stroke="#1a120e" stroke-width="2"/><path d="M50 30 L30 22 L32 38 Z" fill="#E85A5A" stroke="#1a120e" stroke-width="2"/><path d="M50 30 L70 22 L68 38 Z" fill="#E85A5A" stroke="#1a120e" stroke-width="2"/>`;
    case "antenna":
      return `<line x1="50" y1="34" x2="50" y2="14" stroke="#1a120e" stroke-width="3"/><circle cx="50" cy="12" r="6" fill="${accent}" stroke="#1a120e" stroke-width="3"/>`;
    case "cap":
      return `<path d="M22 40 Q50 18 78 40" fill="${accent}" stroke="#1a120e" stroke-width="3"/><rect x="48" y="34" width="30" height="8" rx="3" fill="${accent}" stroke="#1a120e" stroke-width="2"/>`;
    case "flower":
      return `<circle cx="62" cy="24" r="5" fill="#FFD23A" stroke="#1a120e" stroke-width="2"/><circle cx="70" cy="28" r="5" fill="#FF8FAB" stroke="#1a120e" stroke-width="2"/><circle cx="58" cy="30" r="5" fill="#9BF6FF" stroke="#1a120e" stroke-width="2"/><circle cx="64" cy="30" r="3" fill="#FFE066"/>`;
    case "star":
      return `<polygon points="50,10 54,22 66,22 56,30 60,42 50,34 40,42 44,30 34,22 46,22" fill="#FFD23A" stroke="#1a120e" stroke-width="2"/>`;
    default:
      return "";
  }
}

function mouthSvg(id) {
  const m = id % 4;
  if (m === 0) return `<path d="M44 68 Q50 74 56 68" fill="none" stroke="#1a120e" stroke-width="3" stroke-linecap="round"/>`;
  if (m === 1) return `<ellipse cx="50" cy="70" rx="5" ry="3" fill="#1a120e"/>`;
  if (m === 2) return `<path d="M45 69 Q50 66 55 69" fill="none" stroke="#1a120e" stroke-width="3" stroke-linecap="round"/>`;
  return `<circle cx="50" cy="69" r="2.5" fill="#1a120e"/>`;
}

function svg(id) {
  const body = bodies[id % bodies.length];
  const accent = accents[id % accents.length];
  const hat = hats[id % hats.length];
  const eyeY = 52;
  const speck = id % 3 === 0 ? `<circle cx="70" cy="60" r="3" fill="${accent}" opacity="0.5"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <ellipse cx="50" cy="92" rx="28" ry="5" fill="#000" opacity="0.15"/>
  ${hatSvg(hat, body, accent)}
  <ellipse cx="50" cy="58" rx="32" ry="34" fill="${body}" stroke="#1a120e" stroke-width="3.5"/>
  <ellipse cx="34" cy="60" rx="6" ry="4" fill="#FF8FAB" opacity="0.85"/>
  <ellipse cx="66" cy="60" rx="6" ry="4" fill="#FF8FAB" opacity="0.85"/>
  <ellipse cx="38" cy="${eyeY}" rx="5" ry="6" fill="#1a120e"/>
  <ellipse cx="62" cy="${eyeY}" rx="5" ry="6" fill="#1a120e"/>
  <circle cx="39.5" cy="${eyeY - 2}" r="1.6" fill="#fff"/>
  <circle cx="63.5" cy="${eyeY - 2}" r="1.6" fill="#fff"/>
  ${mouthSvg(id)}
  ${speck}
</svg>
`;
}

for (let i = 0; i < 32; i++) {
  fs.writeFileSync(path.join(dir, `${i}.svg`), svg(i));
}
fs.writeFileSync(
  path.join(dir, "README.txt"),
  "Original classroom doodle avatars for OX game. Not derived from any copyrighted character collage.\n"
);
console.log("wrote 32 avatars to", dir);
