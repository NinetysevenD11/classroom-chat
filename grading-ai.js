/**
 * 시험지 이미지/PDF → 문항·정답 JSON
 * Gemini / OpenAI — 모델 자동 폴백 (deprecated 모델 대응)
 */

const SCAN_PROMPT = `당신은 초등·중등 시험지 분석 전문가입니다.
첨부된 시험지(이미지 또는 PDF)를 읽고, 보이는 모든 문항을 JSON으로만 답하세요.

규칙:
- 문항 번호(num)는 시험지에 적힌 번호를 사용
- type: "mc"(객관식), "short"(단답형), "essay"(서술형)
- 객관식: answer는 정답 번호(1~5 등), choices는 선택지 개수(보통 4 또는 5)
- 단답형: answer는 정답 텍스트(숫자·단어)
- 서술형: answer는 모범답 요지(짧게), rubric은 채점 포인트(한 줄)
- points는 배점(없으면 1)
- 시험지에 없는 문항은 만들지 마세요

반드시 아래 JSON 형식만 출력(마크다운 없음):
{"questions":[{"num":1,"type":"mc","answer":"3","choices":5,"points":1},...]}`;

/** 우선 시도 순서 (구형 gemini-2.0-flash 제외) */
const GEMINI_MODEL_CANDIDATES = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
];

const OPENAI_MODEL_CANDIDATES = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4.1",
];

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(body.slice(start, end + 1));
}

function normalizeQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((q, i) => {
      const num = Number(q.num) || i + 1;
      let type = String(q.type || "mc").toLowerCase();
      if (!["mc", "short", "essay"].includes(type)) type = "mc";
      const choices = Math.min(10, Math.max(2, Number(q.choices) || 5));
      return {
        num,
        type,
        answer: String(q.answer ?? "").trim(),
        points: String(Number(q.points) || 1),
        rubric: String(q.rubric || "").trim(),
        choices: type === "mc" ? choices : undefined,
      };
    })
    .sort((a, b) => a.num - b.num);
}

function dataUrlParts(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function isRetryableModelError(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("no longer available") ||
    s.includes("not found") ||
    s.includes("not supported") ||
    s.includes("deprecated") ||
    s.includes("invalid model") ||
    s.includes("does not exist") ||
    s.includes("404")
  );
}

function geminiModelList(envOverride) {
  const fromEnv = (envOverride || process.env.GEMINI_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...fromEnv, ...GEMINI_MODEL_CANDIDATES];
  return [...new Set(merged)];
}

function openaiModelList() {
  const fromEnv = (process.env.OPENAI_VISION_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...fromEnv, ...OPENAI_MODEL_CANDIDATES])];
}

/** @returns {Promise<string[]>} */
async function fetchAvailableGeminiModels(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) return [];
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function orderModels(candidates, available) {
  if (!available.length) return candidates;
  const set = new Set(available);
  const hit = candidates.filter((m) => set.has(m));
  const rest = available.filter((m) => !hit.includes(m) && /flash|pro/i.test(m));
  return [...hit, ...rest, ...candidates.filter((m) => !set.has(m))];
}

function buildGeminiParts(files) {
  const parts = [{ text: SCAN_PROMPT }];
  for (const f of files) {
    const parsed = dataUrlParts(f.dataUrl);
    if (!parsed) continue;
    parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
  }
  if (parts.length < 2) throw new Error("분석할 이미지 또는 PDF가 없습니다.");
  return parts;
}

async function callGeminiModel(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`Gemini (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }

  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text.trim()) throw new Error(`Gemini (${model}): 빈 응답`);
  return normalizeQuestions(parseJsonFromText(text).questions);
}

async function scanWithGemini(files, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Gemini API 키가 없습니다. 사이드바 하단에서 키를 입력하세요.");

  const parts = buildGeminiParts(files);
  const available = await fetchAvailableGeminiModels(key);
  const models = orderModels(geminiModelList(), available);
  const errors = [];

  for (const model of models) {
    try {
      const result = await callGeminiModel(key, model, parts);
      console.log(`[채점 AI] Gemini 성공: ${model}`);
      return result;
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) {
        break;
      }
    }
  }

  throw new Error(
    errors.length
      ? `사용 가능한 Gemini 모델을 찾지 못했습니다.\n${errors.slice(0, 3).join("\n")}`
      : "Gemini 분석에 실패했습니다."
  );
}

function buildOpenAIImageParts(files) {
  const imageParts = [];
  for (const f of files) {
    const parsed = dataUrlParts(f.dataUrl);
    if (!parsed) continue;
    if (!parsed.mimeType.startsWith("image/")) continue;
    imageParts.push({
      type: "image_url",
      image_url: { url: f.dataUrl, detail: "high" },
    });
  }
  if (!imageParts.length) {
    throw new Error("OpenAI는 이미지(JPG/PNG)만 분석합니다. PDF는 Gemini 키를 사용하세요.");
  }
  return imageParts;
}

async function callOpenAIModel(apiKey, model, imageParts) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SCAN_PROMPT },
        { role: "user", content: [{ type: "text", text: "시험지를 분석해 주세요." }, ...imageParts] },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || "OpenAI API 오류";
    const err = new Error(`OpenAI (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }

  const parsed = parseJsonFromText(json.choices?.[0]?.message?.content || "");
  return normalizeQuestions(parsed.questions);
}

async function scanWithOpenAI(files, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("OpenAI API 키가 없습니다.");

  const imageParts = buildOpenAIImageParts(files);
  const models = openaiModelList();
  const errors = [];

  for (const model of models) {
    try {
      const result = await callOpenAIModel(key, model, imageParts);
      console.log(`[채점 AI] OpenAI 성공: ${model}`);
      return result;
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }

  throw new Error(
    errors.length
      ? `사용 가능한 OpenAI 모델을 찾지 못했습니다.\n${errors.slice(0, 3).join("\n")}`
      : "OpenAI 분석에 실패했습니다."
  );
}

/**
 * @param {{ dataUrl: string, name?: string }[]} files
 * @param {{ geminiKey?: string|null, openaiKey?: string|null, provider?: string }} creds
 */
export async function scanExamPaper(files, creds = {}) {
  const list = (files || []).filter((f) => f?.dataUrl && f.dataUrl.length < 12_000_000);
  if (!list.length) throw new Error("업로드된 파일이 없습니다.");

  const provider = creds.provider || "auto";
  const geminiKey = creds.geminiKey?.trim() || null;
  const openaiKey = creds.openaiKey?.trim() || null;

  const errors = [];

  const tryGemini = () => {
    if (!geminiKey) return null;
    if (provider === "openai") return null;
    return scanWithGemini(list, geminiKey);
  };

  const tryOpenai = () => {
    if (!openaiKey) return null;
    if (provider === "gemini") return null;
    return scanWithOpenAI(list, openaiKey);
  };

  if (provider === "gemini") {
    if (!geminiKey) throw new Error("Gemini API 키를 사이드바 하단에 저장해 주세요.");
    return scanWithGemini(list, geminiKey);
  }

  if (provider === "openai") {
    if (!openaiKey) throw new Error("OpenAI API 키를 사이드바 하단에 저장해 주세요.");
    return scanWithOpenAI(list, openaiKey);
  }

  // auto: Gemini 여러 모델 시도 → 실패 시 OpenAI
  if (geminiKey) {
    try {
      return await scanWithGemini(list, geminiKey);
    } catch (err) {
      errors.push(err.message);
      if (openaiKey) {
        try {
          return await scanWithOpenAI(list, openaiKey);
        } catch (err2) {
          errors.push(err2.message);
        }
      } else {
        throw err;
      }
    }
  }

  if (openaiKey) {
    return scanWithOpenAI(list, openaiKey);
  }

  throw new Error(
    errors.length
      ? errors.join("\n\n")
      : "AI API 키가 없습니다. 사이드바 하단에서 Gemini 또는 OpenAI 키를 저장해 주세요."
  );
}

export function questionsToStored(aiList, uidFn) {
  return aiList.map((q) => ({
    id: uidFn(),
    num: q.num,
    type: q.type,
    answer: q.answer,
    points: q.points,
    rubric: q.rubric || "",
    choices: q.type === "mc" ? q.choices || 5 : undefined,
  }));
}
