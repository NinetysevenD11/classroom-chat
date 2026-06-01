import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildPrompts } from "./lib/prompts.js";
import { generateLookbookImages } from "./lib/generateImages.js";
import { createLookbookVideo } from "./lib/createVideo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.LOOKBOOK_PORT || 4000;
const OUTPUT_DIR = path.join(__dirname, "output");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/** @type {Map<string, { status, progress, message, videoPath?, images?, error? }>} */
const jobs = new Map();

async function cleanupOldJobs() {
  const entries = [...jobs.entries()];
  if (entries.length <= 20) return;
  const toRemove = entries.slice(0, entries.length - 20);
  for (const [id, job] of toRemove) {
    if (job.workDir) await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
    jobs.delete(id);
  }
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
}

async function runJob(jobId, { style, theme, sceneCount }) {
  const workDir = path.join(OUTPUT_DIR, jobId);
  updateJob(jobId, { status: "running", workDir });

  try {
    const prompts = buildPrompts(style, theme, sceneCount);
    updateJob(jobId, { prompts });

    const images = await generateLookbookImages(prompts, workDir, (p) => {
      updateJob(jobId, {
        progress: Math.round((p.current / p.total) * 60),
        message: p.message,
        phase: p.phase,
      });
    });

    const imageUrls = images.map((p) => `/api/jobs/${jobId}/images/${path.basename(p)}`);
    updateJob(jobId, { images: imageUrls });

    const videoPath = await createLookbookVideo(images, workDir, (p) => {
      updateJob(jobId, {
        progress: 60 + Math.round((p.current / p.total) * 40),
        message: p.message,
        phase: p.phase,
      });
    });

    updateJob(jobId, {
      status: "done",
      progress: 100,
      message: "완료! 영상을 다운로드하세요.",
      videoUrl: `/api/jobs/${jobId}/video`,
    });
  } catch (err) {
    updateJob(jobId, {
      status: "error",
      message: err.message || "생성 중 오류가 발생했습니다.",
      error: err.message,
    });
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.post("/api/generate", async (req, res) => {
  const { style = "minimal", theme = "", sceneCount = 4 } = req.body || {};

  if (!["streetwear", "minimal", "luxury", "casual", "sporty"].includes(style)) {
    return res.status(400).json({ error: "유효하지 않은 스타일입니다." });
  }

  const count = Number(sceneCount);
  if (!Number.isInteger(count) || count < 2 || count > 6) {
    return res.status(400).json({ error: "장면 수는 2~6 사이여야 합니다." });
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await cleanupOldJobs();

  const jobId = randomUUID();
  jobs.set(jobId, {
    status: "queued",
    progress: 0,
    message: "작업 대기 중…",
    style,
    theme,
    sceneCount: count,
  });

  runJob(jobId, { style, theme, sceneCount: count });

  res.json({ jobId });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "작업을 찾을 수 없습니다." });

  const { workDir, ...safe } = job;
  res.json(safe);
});

app.get("/api/jobs/:id/video", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.workDir) return res.status(404).send("Not found");

  const videoPath = path.join(job.workDir, "lookbook_reel.mp4");
  try {
    await fs.access(videoPath);
    res.download(videoPath, "lookbook_reel.mp4");
  } catch {
    res.status(404).send("영상이 아직 준비되지 않았습니다.");
  }
});

app.get("/api/jobs/:id/images/:file", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.workDir) return res.status(404).send("Not found");

  const filePath = path.join(job.workDir, req.params.file);
  if (!filePath.startsWith(job.workDir)) return res.status(403).send("Forbidden");

  try {
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).send("Not found");
  }
});

app.listen(PORT, () => {
  console.log(`Lookbook Studio → http://localhost:${PORT}`);
});
