import fs from "fs/promises";
import path from "path";

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

function buildImageUrl(prompt, seed) {
  const params = new URLSearchParams({
    width: "1080",
    height: "1920",
    seed: String(seed),
    nologo: "true",
    model: "flux",
    enhance: "true",
  });
  return `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params}`;
}

async function downloadImage(url, destPath, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1000) throw new Error("이미지 데이터가 너무 작습니다");
      await fs.writeFile(destPath, buffer);
      return destPath;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function generateLookbookImages(prompts, workDir, onProgress) {
  await fs.mkdir(workDir, { recursive: true });
  const imagePaths = [];

  for (let i = 0; i < prompts.length; i++) {
    onProgress?.({
      phase: "images",
      current: i + 1,
      total: prompts.length,
      message: `룩북 이미지 ${i + 1}/${prompts.length} 생성 중…`,
    });

    const seed = Math.floor(Math.random() * 999_999);
    const url = buildImageUrl(prompts[i], seed);
    const dest = path.join(workDir, `scene_${String(i + 1).padStart(2, "0")}.jpg`);
    await downloadImage(url, dest);
    imagePaths.push(dest);
  }

  return imagePaths;
}
