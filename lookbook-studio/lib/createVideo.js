import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import ffmpegPath from "ffmpeg-static";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-500) || `ffmpeg exit ${code}`));
    });
    proc.on("error", reject);
  });
}

async function createSceneClip(imagePath, clipPath, durationSec, motion) {
  const frames = durationSec * FPS;
  const zoomStart = motion === "zoom-in" ? 1 : 1.15;
  const zoomEnd = motion === "zoom-in" ? 1.15 : 1;
  const zoomExpr = `if(eq(on,1),${zoomStart},${zoomStart}+(${zoomEnd}-${zoomStart})*(on/${frames}))`;

  const vf = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    "format=yuv420p",
  ].join(",");

  await runFfmpeg([
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-vf",
    vf,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    clipPath,
  ]);
}

async function concatClips(clipPaths, outputPath) {
  const listPath = outputPath.replace(/\.mp4$/, "_list.txt");
  const listContent = clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  await fs.writeFile(listPath, listContent, "utf8");

  await runFfmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ]);

  await fs.unlink(listPath).catch(() => {});
}

export async function createLookbookVideo(imagePaths, workDir, onProgress) {
  const clipPaths = [];
  const sceneDuration = 4;

  for (let i = 0; i < imagePaths.length; i++) {
    onProgress?.({
      phase: "video",
      current: i + 1,
      total: imagePaths.length,
      message: `영상 클립 ${i + 1}/${imagePaths.length} 렌더링 중…`,
    });

    const motion = i % 2 === 0 ? "zoom-in" : "zoom-out";
    const clipPath = path.join(workDir, `clip_${String(i + 1).padStart(2, "0")}.mp4`);
    await createSceneClip(imagePaths[i], clipPath, sceneDuration, motion);
    clipPaths.push(clipPath);
  }

  onProgress?.({
    phase: "video",
    current: imagePaths.length,
    total: imagePaths.length,
    message: "최종 영상 합치는 중…",
  });

  const outputPath = path.join(workDir, "lookbook_reel.mp4");
  await concatClips(clipPaths, outputPath);

  for (const clip of clipPaths) {
    await fs.unlink(clip).catch(() => {});
  }

  return outputPath;
}
