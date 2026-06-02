/**
 * 시험지 이미지/PDF → 문항·정답 JSON (Gemini 또는 OpenAI Vision)
 * Render 환경 변수: GEMINI_API_KEY 또는 OPENAI_API_KEY
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

async function scanWithGemini(files) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다. Render 환경 변수에 추가해 주세요.");

  const parts = [{ text: SCAN_PROMPT }];
  for (const f of files) {
    const parsed = dataUrlParts(f.dataUrl);
    if (!parsed) continue;
    parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
  }
  if (parts.length < 2) throw new Error("분석할 이미지 또는 PDF가 없습니다.");

  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

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
    throw new Error(`Gemini API: ${msg}`);
  }

  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const parsed = parseJsonFromText(text);
  return normalizeQuestions(parsed.questions);
}

async function scanWithOpenAI(files) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY가 설정되지 않았습니다.");

  const imageParts = [];
  for (const f of files) {
    const parsed = dataUrlParts(f.dataUrl);
    if (!parsed) continue;
    if (parsed.mimeType === "application/pdf") {
      throw new Error("OpenAI 모드에서는 PDF 대신 이미지(JPG/PNG)를 사용하거나 GEMINI_API_KEY를 설정하세요.");
    }
    if (!parsed.mimeType.startsWith("image/")) continue;
    imageParts.push({
      type: "image_url",
      image_url: { url: f.dataUrl, detail: "high" },
    });
  }
  if (!imageParts.length) throw new Error("분석할 이미지가 없습니다.");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: SCAN_PROMPT },
        { role: "user", content: [{ type: "text", text: "시험지를 분석해 주세요." }, ...imageParts] },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || "OpenAI API 오류");
  const parsed = parseJsonFromText(json.choices?.[0]?.message?.content || "");
  return normalizeQuestions(parsed.questions);
}

/** @param {{ dataUrl: string, name?: string }[]} files */
export async function scanExamPaper(files) {
  const list = (files || []).filter((f) => f?.dataUrl && f.dataUrl.length < 12_000_000);
  if (!list.length) throw new Error("업로드된 파일이 없습니다.");

  if (process.env.GEMINI_API_KEY?.trim()) {
    return scanWithGemini(list);
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return scanWithOpenAI(list);
  }
  throw new Error(
    "AI API 키가 없습니다. Render에 GEMINI_API_KEY(권장) 또는 OPENAI_API_KEY를 설정해 주세요."
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
