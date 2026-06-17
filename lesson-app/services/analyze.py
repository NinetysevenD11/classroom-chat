"""
v14.1 Claude API 엔진 — Tool Use 방식
기존 프롬프트 기반 JSON → Tool Use로 전환.
Claude가 스키마에 맞춘 구조화된 응답을 뱉기 때문에 JSON 파싱 실패 불가능.
"""
import json
import os
import time
import base64
import random
from anthropic import Anthropic

from .prompts import build_understand_user_prompt, build_design_user_prompt, UNDERSTAND_SYSTEM, DESIGN_SYSTEM
from .schema import UNDERSTAND_TOOL, DESIGN_TOOL

CLAUDE_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 8192
# Gemini 모델은 계정/리전/런칭 시점에 따라 가용성이 달라 후보를 순회한다.
# (2.0-flash 계열은 신규 사용자에겐 막히는 경우가 있어 2.5 계열을 우선한다.)
GEMINI_MODEL_CANDIDATES = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
]


def get_client(api_key: str | None = None):
    # api_key를 명시하면 사용자별 키로 동작, 없으면 환경변수 기본 사용
    return Anthropic(api_key=api_key) if api_key else Anthropic()


def build_claude_contents(prompt_text, textbook_images_b64, guide_images_b64=None):
    """
    Claude에 보낼 content 리스트 구성.
    순서: [지도서 라벨+이미지] → [교과서 라벨+이미지] → [지시문]
    """
    contents = []
    
    if guide_images_b64:
        contents.append({
            "type": "text",
            "text": "🔖 [교사용 지도서 페이지 — 교수·학습 의도와 발문 예시 참고용]"
        })
        for b64 in guide_images_b64:
            contents.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": b64}
            })
    
    contents.append({
        "type": "text",
        "text": "📖 [학생 교과서 페이지 — 실제 수업에서 학생이 볼 자료]"
    })
    for b64 in textbook_images_b64:
        contents.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": b64}
        })
    
    contents.append({"type": "text", "text": prompt_text})
    return contents


def _call_with_tool(system_prompt, contents, tool_spec, on_stream_delta, label, api_key: str | None = None):
    """
    Tool Use 방식으로 Claude 호출.
    응답에서 tool_use 블록을 찾아 input 딕셔너리를 그대로 반환.
    """
    client = get_client(api_key)
    tool_name = tool_spec["name"]
    
    for attempt in range(5):
        try:
            # Tool Use + Streaming
            accumulated_text = ""
            result = None
            
            with client.messages.stream(
                model=CLAUDE_MODEL,
                max_tokens=MAX_TOKENS,
                temperature=0.7,
                system=system_prompt,
                tools=[tool_spec],
                tool_choice={"type": "tool", "name": tool_name},
                messages=[{"role": "user", "content": contents}]
            ) as stream:
                for text in stream.text_stream:
                    accumulated_text += text
                    if on_stream_delta:
                        on_stream_delta('text', text)
                
                # 스트림 완료 후 최종 메시지에서 tool_use 블록 추출
                final_message = stream.get_final_message()
                for block in final_message.content:
                    if block.type == "tool_use" and block.name == tool_name:
                        result = block.input
                        break
            
            if result is None:
                raise RuntimeError(f"{label}: Claude가 {tool_name} 도구를 호출하지 않음")
            
            return result
            
        except Exception as e:
            err_str = str(e).lower()
            if "rate limit" in err_str or "overloaded" in err_str or "529" in err_str or "503" in err_str:
                print(f"[Claude 서버 지연] 3초 대기 후 재시도... ({attempt+1}/5)")
                time.sleep(3)
            else:
                raise e
    
    raise RuntimeError("Claude 서버 과부하가 너무 심합니다. 잠시 후 다시 시도해주세요.")


def call_understand_stream(
    model_name, curriculum_text, images_b64,
    lesson_number, total_lessons, subject,
    on_stream_delta, guide_images_b64=None,
    api_key: str | None = None,
    provider: str = "anthropic",
):
    """차시 개요 분석 (Tool Use)."""
    prompt = build_understand_user_prompt(curriculum_text, lesson_number, total_lessons, subject)
    contents = build_claude_contents(prompt, images_b64, guide_images_b64)
    if provider == "gemini":
        return _call_gemini_json(UNDERSTAND_SYSTEM, prompt, images_b64, guide_images_b64, UNDERSTAND_TOOL["input_schema"], on_stream_delta, api_key)
    return _call_with_tool(UNDERSTAND_SYSTEM, contents, UNDERSTAND_TOOL, on_stream_delta, "차시 분석", api_key)


def call_design_stream(
    model_name, overview, images_b64,
    lesson_number, total_lessons, subject,
    on_stream_delta, guide_images_b64=None,
    guide_text: str | None = None,
    api_key: str | None = None,
    provider: str = "anthropic",
):
    """활동 설계 (Tool Use)."""
    prompt = build_design_user_prompt(
        json.dumps(overview, ensure_ascii=False),
        lesson_number,
        total_lessons,
        subject,
        guide_text=guide_text,
    )
    contents = build_claude_contents(prompt, images_b64, guide_images_b64)
    if provider == "gemini":
        return _call_gemini_json(DESIGN_SYSTEM, prompt, images_b64, guide_images_b64, DESIGN_TOOL["input_schema"], on_stream_delta, api_key)
    return _call_with_tool(DESIGN_SYSTEM, contents, DESIGN_TOOL, on_stream_delta, "활동 설계", api_key)


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        raise RuntimeError("빈 응답")
    try:
        return json.loads(text)
    except Exception:
        pass
    if "```" in text:
        parts = [p for p in text.split("```") if p.strip()]
        for p in parts:
            s = p.strip()
            if s.startswith("json"):
                s = s[4:].strip()
            try:
                return json.loads(s)
            except Exception:
                continue
    i = text.find("{")
    j = text.rfind("}")
    if i >= 0 and j > i:
        return json.loads(text[i : j + 1])
    raise RuntimeError("JSON 파싱 실패")


def _call_gemini_json(system_prompt: str, user_prompt: str, textbook_images_b64: list[str], guide_images_b64: list[str] | None, schema: dict, on_stream_delta, api_key: str | None) -> dict:
    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        raise RuntimeError(f"Gemini SDK 로드 실패: {exc}")

    if not api_key:
        raise RuntimeError("Gemini API KEY가 없습니다.")

    client = genai.Client(api_key=api_key)

    schema_text = json.dumps(schema, ensure_ascii=False, indent=2)
    full_text = (
        system_prompt
        + "\n\n"
        + "아래 형식의 JSON만 출력하세요. 다른 설명/문장/마크다운 금지.\n"
        + "스키마:\n"
        + schema_text
        + "\n\n"
        + user_prompt
    )

    contents: list[object] = [full_text]
    if guide_images_b64:
        for b64 in guide_images_b64:
            try:
                contents.append(types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/png"))
            except Exception:
                pass
    for b64 in (textbook_images_b64 or []):
        try:
            contents.append(types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/png"))
        except Exception:
            pass

    def _is_transient(msg: str) -> bool:
        m = (msg or "").lower()
        return (
            ("503" in m)
            or ("unavailable" in m)
            or ("high demand" in m)
            or ("rate limit" in m)
            or ("429" in m)
            or ("resource_exhausted" in m)
        )

    last_exc: Exception | None = None
    for model_name in GEMINI_MODEL_CANDIDATES:
        # 모델 후보별로도 일시적 오류는 백오프로 재시도
        for attempt in range(1, 5):
            try:
                resp = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        temperature=0.2,
                        max_output_tokens=MAX_TOKENS,
                        response_mime_type="application/json",
                    ),
                )
                text = getattr(resp, "text", "") or ""
                if on_stream_delta and text:
                    on_stream_delta("text", text[:250])
                return _extract_json(text)
            except Exception as exc:
                last_exc = exc
                msg = str(exc)

                # 계정/리전/SDK 버전에 따라 모델명이 없을 수 있음(404). 후보를 순회.
                if (
                    ("not found" in msg.lower())
                    or ("404" in msg)
                    or ("is not supported" in msg.lower())
                    or ("no longer available" in msg.lower())
                ):
                    break  # next model

                # 일시적 과부하/레이트리밋이면 대기 후 같은 모델로 재시도
                if _is_transient(msg):
                    wait_s = min(35.0, (2 ** attempt) + random.uniform(0.0, 1.8))
                    time.sleep(wait_s)
                    continue

                # 그 외 오류(인증/권한/요청형식)는 즉시 표면화
                raise

    raise RuntimeError(f"Gemini 모델 호출 실패: {last_exc}")