const STYLE_BASE = {
  streetwear:
    "professional fashion lookbook photo, streetwear outfit, urban city backdrop, editorial photography, 8k, sharp focus",
  minimal:
    "professional fashion lookbook photo, minimalist outfit, clean white studio background, high fashion editorial, 8k",
  luxury:
    "professional fashion lookbook photo, luxury designer outfit, elegant sophisticated pose, magazine cover quality, 8k",
  casual:
    "professional fashion lookbook photo, casual lifestyle outfit, natural soft lighting, outdoor cafe aesthetic, 8k",
  sporty:
    "professional fashion lookbook photo, athletic sportswear outfit, dynamic energy, modern gym or track backdrop, 8k",
};

const POSES = [
  "full body front facing standing pose",
  "full body walking toward camera",
  "three quarter angle fashion pose",
  "full body side profile elegant stance",
  "dynamic mid-step movement pose",
  "seated fashion editorial pose",
];

export function buildPrompts(style, theme, sceneCount) {
  const base = STYLE_BASE[style] || STYLE_BASE.minimal;
  const themeText = theme.trim() ? `, wearing ${theme.trim()}` : "";
  const count = Math.min(Math.max(sceneCount, 2), 6);

  return Array.from({ length: count }, (_, i) => {
    const pose = POSES[i % POSES.length];
    return `${base}${themeText}, ${pose}, single model, no text, no watermark, no logo, vertical composition for instagram reels`;
  });
}
