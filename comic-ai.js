/**
 * 사진 → 만화 그림체 변환 (Gemini 이미지 모델)
 */

const STYLE_PROMPTS = {
  anime: `Restyle this photo as a clean Japanese school manga / anime illustration.
Keep the same people, pose, and composition. Soft cel shading, clear outlines,
expressive eyes, bright classroom-friendly colors. No text, no speech bubbles,
no watermark, no border. Output a single square-ish illustration.`,

  watercolor: `Restyle this photo as a soft children's book watercolor painting.
Keep the same people, pose, and composition. Gentle washes, paper texture,
warm pastel tones, friendly and calm. No text, no speech bubbles, no watermark,
no border. Output a single illustration.`,

  crayon: `Restyle this photo as a colorful crayon / oil pastel drawing by a child illustrator.
Keep the same people, pose, and composition. Visible crayon strokes, playful
and warm. No text, no speech bubbles, no watermark, no border.
Output a single illustration.`,

  pixel: `Restyle this photo as cute 16-bit pixel art.
Keep the same people, pose, and composition. Clear pixel blocks, limited bright
palette, nostalgic game look. No text, no speech bubbles, no watermark, no border.
Output a single illustration.`,
};

export const COMIC_STYLES = [
  { id: "anime", label: "학원 만화", desc: "또렷한 만화·애니 그림체" },
  { id: "watercolor", label: "수채화", desc: "부드러운 동화책 느낌" },
  { id: "crayon", label: "크레용", desc: "따뜻하고 장난스러운 터치" },
  { id: "pixel", label: "픽셀 아트", desc: "레트로 게임 도트 그림" },
];

const IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.0-flash-exp-image-generation",
];

function dataUrlParts(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function extractImageFromResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      return `data:${mime};base64,${inline.data}`;
    }
  }
  return null;
}

function isRetryable(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("not found") ||
    s.includes("not supported") ||
    s.includes("unknown model") ||
    s.includes("invalid model") ||
    s.includes("404")
  );
}

async function callImageModel(apiKey, model, prompt, mimeType, data) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.6,
      },
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`Gemini (${model}): ${msg}`);
    err.retryable = isRetryable(msg);
    throw err;
  }

  const out = extractImageFromResponse(json);
  if (!out) {
    const err = new Error(`Gemini (${model}): 이미지 응답이 없습니다.`);
    err.retryable = true;
    throw err;
  }
  return out;
}

export async function stylizePhoto({ dataUrl, styleId, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) {
    throw new Error("Gemini API 키가 필요합니다. 채점도구에서 Gemini 키를 저장해 주세요.");
  }

  const style = STYLE_PROMPTS[styleId] ? styleId : "anime";
  const prompt = STYLE_PROMPTS[style];
  const parsed = dataUrlParts(dataUrl);
  if (!parsed) throw new Error("올바른 이미지 형식이 아닙니다.");

  const errors = [];
  for (const model of IMAGE_MODELS) {
    try {
      const image = await callImageModel(key, model, prompt, parsed.mimeType, parsed.data);
      console.log(`[네컷만화] 스타일화 성공: ${model} / ${style}`);
      return { image, style, model };
    } catch (err) {
      errors.push(err.message);
      console.warn(`[네컷만화] ${model} 실패:`, err.message);
      if (!err.retryable) throw err;
    }
  }

  throw new Error(errors[errors.length - 1] || "이미지 변환에 실패했습니다.");
}
