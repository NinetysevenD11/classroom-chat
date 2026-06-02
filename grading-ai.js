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

const CLAUDE_MODEL_CANDIDATES = [
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307",
];

const GROK_MODEL_CANDIDATES = [
  "grok-2-vision-1212",
  "grok-2-vision-latest",
  "grok-vision-beta",
];

const PROVIDER_LABELS = {
  openai: "OpenAI",
  gemini: "Gemini",
  claude: "Claude",
  grok: "Grok",
};

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

function buildClaudeImageBlocks(files) {
  const blocks = [];
  for (const f of files) {
    const parsed = dataUrlParts(f.dataUrl);
    if (!parsed) continue;
    if (parsed.mimeType === "application/pdf") {
      throw new Error("Claude는 PDF를 지원하지 않습니다. AI 선택에서 Gemini를 쓰거나 이미지로 올려 주세요.");
    }
    if (!parsed.mimeType.startsWith("image/")) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: parsed.mimeType, data: parsed.data },
    });
  }
  if (!blocks.length) {
    throw new Error("Claude는 이미지(JPG/PNG)만 분석합니다.");
  }
  return blocks;
}

async function callClaudeModel(apiKey, model, imageBlocks) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: SCAN_PROMPT }, ...imageBlocks, { type: "text", text: "시험지를 분석해 주세요." }],
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`Claude (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }
  const text = (json.content || []).filter((p) => p.type === "text").map((p) => p.text).join("");
  if (!text.trim()) throw new Error(`Claude (${model}): 빈 응답`);
  return normalizeQuestions(parseJsonFromText(text).questions);
}

async function scanWithClaude(files, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Claude API 키가 없습니다.");
  const imageBlocks = buildClaudeImageBlocks(files);
  const errors = [];
  for (const model of CLAUDE_MODEL_CANDIDATES) {
    try {
      const result = await callClaudeModel(key, model, imageBlocks);
      console.log(`[채점 AI] Claude 성공: ${model}`);
      return result;
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || "Claude 분석에 실패했습니다.");
}

async function callOpenAICompatibleVision(apiKey, baseUrl, models, imageParts, label) {
  const errors = [];
  for (const model of models) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
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
        const msg = json?.error?.message || `${label} API 오류`;
        const err = new Error(`${label} (${model}): ${msg}`);
        err.retryable = isRetryableModelError(msg);
        throw err;
      }
      const parsed = parseJsonFromText(json.choices?.[0]?.message?.content || "");
      console.log(`[채점 AI] ${label} 성공: ${model}`);
      return normalizeQuestions(parsed.questions);
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || `${label} 분석에 실패했습니다.`);
}

async function scanWithGrok(files, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Grok API 키가 없습니다.");
  const imageParts = buildOpenAIImageParts(files);
  return callOpenAICompatibleVision(key, "https://api.x.ai/v1", GROK_MODEL_CANDIDATES, imageParts, "Grok");
}

/**
 * @param {{ dataUrl: string, name?: string }[]} files
 * @param {{ provider?: string, apiKey?: string|null }} creds
 */
export async function scanExamPaper(files, creds = {}) {
  const list = (files || []).filter((f) => f?.dataUrl && f.dataUrl.length < 12_000_000);
  if (!list.length) throw new Error("업로드된 파일이 없습니다.");

  const provider = creds.provider || "gemini";
  const apiKey = creds.apiKey?.trim() || null;
  const label = PROVIDER_LABELS[provider] || provider;

  if (!apiKey) {
    throw new Error(`${label} API 키를 사이드바 하단에 저장해 주세요.`);
  }

  switch (provider) {
    case "gemini":
      return scanWithGemini(list, apiKey);
    case "openai":
      return scanWithOpenAI(list, apiKey);
    case "claude":
      return scanWithClaude(list, apiKey);
    case "grok":
      return scanWithGrok(list, apiKey);
    default:
      throw new Error(`지원하지 않는 AI: ${provider}`);
  }
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

const TREND_ANALYSIS_PROMPT = `당신은 초등·중등 학습 코치입니다. 학생의 과목별 시험 점수 추이와 오답 정보를 바탕으로 분석합니다.

반드시 아래 JSON만 출력(마크다운 없음):
{
  "trendSummary": "성적 변화에 대한 2~4문장 요약",
  "strengths": ["강점 1", "강점 2"],
  "weaknesses": ["약점 1", "약점 2"],
  "recommendations": ["보완·학습 제안 1", "보완·학습 제안 2", "보완·학습 제안 3"]
}

규칙:
- 한국어, 교사가 학부모·학생에게 전달하기 쉬운 톤
- 데이터에 없는 과목·단원은 언급하지 않음
- 점수가 1개뿐이면 '추이 판단은 어렵다'고 하고 현재 수준 위주로 분석
- recommendations는 구체적 행동(복습 단원, 연습 유형 등)`;

async function callGeminiText(apiKey, model, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: TREND_ANALYSIS_PROMPT }, { text: userText }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`Gemini (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
}

async function callOpenAIText(apiKey, model, userText) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 2048,
      messages: [
        { role: "system", content: TREND_ANALYSIS_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`OpenAI (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }
  return json.choices?.[0]?.message?.content || "";
}

function normalizeTrendAnalysis(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    trendSummary: String(o.trendSummary || "").trim() || "분석 결과를 생성하지 못했습니다.",
    strengths: arr(o.strengths),
    weaknesses: arr(o.weaknesses),
    recommendations: arr(o.recommendations),
  };
}

async function analyzeWithGeminiText(data, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Gemini API 키가 없습니다.");
  const userText = JSON.stringify(data, null, 2);
  const available = await fetchAvailableGeminiModels(key);
  const models = orderModels(geminiModelList(), available);
  const errors = [];
  for (const model of models) {
    try {
      const text = await callGeminiText(key, model, userText);
      return normalizeTrendAnalysis(parseJsonFromText(text));
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || "Gemini 분석 실패");
}

async function analyzeWithOpenAIText(data, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("OpenAI API 키가 없습니다.");
  const userText = JSON.stringify(data, null, 2);
  const models = openaiModelList();
  const errors = [];
  for (const model of models) {
    try {
      const text = await callOpenAIText(key, model, userText);
      return normalizeTrendAnalysis(parseJsonFromText(text));
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || "OpenAI 분석 실패");
}

async function callClaudeText(apiKey, model, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0.35,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: TREND_ANALYSIS_PROMPT }, { type: "text", text: userText }],
        },
      ],
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    const err = new Error(`Claude (${model}): ${msg}`);
    err.retryable = isRetryableModelError(msg);
    throw err;
  }
  return (json.content || []).filter((p) => p.type === "text").map((p) => p.text).join("");
}

async function analyzeWithClaudeText(data, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Claude API 키가 없습니다.");
  const userText = JSON.stringify(data, null, 2);
  const errors = [];
  for (const model of CLAUDE_MODEL_CANDIDATES) {
    try {
      const text = await callClaudeText(key, model, userText);
      return normalizeTrendAnalysis(parseJsonFromText(text));
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || "Claude 분석 실패");
}

async function analyzeWithGrokText(data, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Grok API 키가 없습니다.");
  const userText = JSON.stringify(data, null, 2);
  const errors = [];
  for (const model of GROK_MODEL_CANDIDATES) {
    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.35,
          max_tokens: 2048,
          messages: [
            { role: "system", content: TREND_ANALYSIS_PROMPT },
            { role: "user", content: userText },
          ],
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = json?.error?.message || "Grok API 오류";
        const err = new Error(`Grok (${model}): ${msg}`);
        err.retryable = isRetryableModelError(msg);
        throw err;
      }
      const text = json.choices?.[0]?.message?.content || "";
      return normalizeTrendAnalysis(parseJsonFromText(text));
    } catch (err) {
      errors.push(err.message);
      if (!err.retryable && !isRetryableModelError(err.message)) break;
    }
  }
  throw new Error(errors[0] || "Grok 분석 실패");
}

/** @param {object} trendData 학생·과목별 점수·오답 요약 */
export async function analyzeStudentTrend(trendData, creds = {}) {
  const provider = creds.provider || "gemini";
  const apiKey = creds.apiKey?.trim() || null;
  const label = PROVIDER_LABELS[provider] || provider;

  if (!apiKey) {
    throw new Error(`${label} API 키를 사이드바 하단에 저장해 주세요.`);
  }

  switch (provider) {
    case "gemini":
      return analyzeWithGeminiText(trendData, apiKey);
    case "openai":
      return analyzeWithOpenAIText(trendData, apiKey);
    case "claude":
      return analyzeWithClaudeText(trendData, apiKey);
    case "grok":
      return analyzeWithGrokText(trendData, apiKey);
    default:
      throw new Error(`지원하지 않는 AI: ${provider}`);
  }
}
