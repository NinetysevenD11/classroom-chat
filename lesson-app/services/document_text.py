"""
평가문항·수업 지도안 등 보조 문서에서 텍스트 추출.

- PDF: PyMuPDF로 텍스트 레이어 추출(정렬), 텍스트가 매우 적으면 페이지를 이미지로 렌더링 후 Gemini로 OCR.
- PNG/JPEG/WebP: Gemini 멀티모달로 전면 OCR(표·양식 유지를 마크다운으로 요청).
"""

from __future__ import annotations

import random
import time
from pathlib import Path

# analyze.py와 동일한 후보 순서를 유지(별도 import로 순환 참조 방지)
_GEMINI_OCR_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
]

_ALLOWED_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}


def sniff_extension(filename: str, data: bytes) -> str:
    """반환: 소문자 확장자(.pdf 등). 알 수 없으면 .pdf 시도."""
    fn = (filename or "").strip().lower()
    suf = Path(fn).suffix.lower()
    if suf in _ALLOWED_EXT:
        return suf
    if data.startswith(b"%PDF"):
        return ".pdf"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".pdf"


def _pdf_page_count(data: bytes) -> int:
    try:
        import fitz

        doc = fitz.open(stream=data, filetype="pdf")
        n = len(doc)
        doc.close()
        return int(n)
    except Exception:
        return 0


def pdf_to_text_sorted(pdf_bytes: bytes) -> str:
    """페이지별로 블록 정렬을 켠 텍스트 추출(표·다단에서 읽기 순서가 조금 나아짐)."""
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    parts: list[str] = []
    try:
        for i in range(len(doc)):
            page = doc.load_page(i)
            try:
                t = page.get_text("text", sort=True) or ""
            except TypeError:
                t = page.get_text("text") or ""
            t = (t or "").strip()
            if t:
                parts.append(f"[PDF p.{i + 1}]\n{t}")
    finally:
        doc.close()
    return "\n\n".join(parts).strip()


def _pdf_render_pages_png(
    pdf_bytes: bytes,
    dpi: int = 132,
    max_pages: int = 24,
) -> list[tuple[bytes, str]]:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    out: list[tuple[bytes, str]] = []
    try:
        n = min(len(doc), max_pages)
        for i in range(n):
            pix = doc.load_page(i).get_pixmap(dpi=dpi)
            png = pix.tobytes("png")
            out.append((png, "image/png"))
    finally:
        doc.close()
    return out


def _needs_pdf_vision_fallback(pdf_bytes: bytes, native_text: str) -> bool:
    n = _pdf_page_count(pdf_bytes)
    if n <= 0:
        return True
    t = (native_text or "").strip()
    if len(t) < max(120, 22 * n):
        return True
    # 페이지당 한글·문자가 거의 없으면 스캔 PDF로 간주
    ratio = len(t) / max(1, n)
    return ratio < 35


def gemini_ocr_image_batch(
    image_parts: list[tuple[bytes, str]],
    user_prompt: str,
    api_key: str,
    *,
    max_output_tokens: int = 12288,
) -> str:
    from google import genai
    from google.genai import types

    if not api_key or not image_parts:
        return ""

    client = genai.Client(api_key=api_key)
    contents: list[object] = [user_prompt]
    for blob, mime in image_parts:
        try:
            contents.append(types.Part.from_bytes(data=blob, mime_type=mime))
        except Exception:
            continue

    def _transient(msg: str) -> bool:
        m = (msg or "").lower()
        return ("503" in m) or ("unavailable" in m) or ("429" in m) or ("rate" in m) or ("resource_exhausted" in m)

    last_exc: Exception | None = None
    for model_name in _GEMINI_OCR_MODELS:
        for attempt in range(1, 5):
            try:
                resp = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        temperature=0.05,
                        max_output_tokens=max_output_tokens,
                    ),
                )
                return (getattr(resp, "text", "") or "").strip()
            except Exception as exc:
                last_exc = exc
                msg = str(exc)
                if (
                    ("not found" in msg.lower())
                    or ("404" in msg)
                    or ("is not supported" in msg.lower())
                    or ("no longer available" in msg.lower())
                ):
                    break
                if _transient(msg):
                    time.sleep(min(32.0, (2**attempt) + random.uniform(0.0, 1.2)))
                    continue
                raise
    raise RuntimeError(f"Gemini OCR 실패: {last_exc}")


def extract_supplement_text(
    data: bytes,
    filename: str,
    subject: str,
    role_label: str,
    *,
    lesson_plan: bool,
    vision_api_key: str | None,
) -> str:
    """
    평가문항 / 수업 지도안 바이트 → 텍스트.
    vision_api_key: Gemini 키(관리자가 Anthropic만 써도 OCR용으로 별도 전달 가능).
    """
    if not data:
        return ""

    ext = sniff_extension(filename, data)
    vk = (vision_api_key or "").strip()

    role_ctx = f"과목 맥락 힌트: {subject}" if subject else ""

    if ext != ".pdf":
        if not vk:
            return (
                f"[{role_label}: 이미지 파일은 텍스트 분석을 위해 Gemini API 키가 필요합니다. "
                f"사이드바에 Gemini 키를 입력한 뒤 다시 생성해 주세요.]"
            )
        lp_extra = ""
        if lesson_plan:
            lp_extra = (
                "\n이 파일은 **수업 지도안**입니다. 양식이 제각각이므로 표·칸·단계·시간 배분·교수학습활동·평가·교재 자료 등이 있으면 "
                "**원래 구조를 최대한 유지**해 마크다운으로 옮기세요. 표는 GitHub-flavored 마크다운 표로, 빈 칸은 `(작성)`으로 표시해도 됩니다. "
                "한글 맞춤법을 지키고, 추측으로 숫자를 만들지 마세요.\n"
            )
        prompt = (
            f"다음 이미지는 학습지 생성 보조 자료입니다({role_label}). {role_ctx}\n"
            f"{lp_extra}\n"
            "출력 규칙: 설명 문장 없이 **추출된 내용만** 출력. 가능하면 제목·번호·항목 계층을 유지하세요."
        )
        mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png" if ext == ".png" else "image/webp"
        try:
            text = gemini_ocr_image_batch([(data, mime)], prompt, vk)
        except Exception as exc:
            return f"[{role_label} 이미지 OCR 실패: {exc}]"
        return _trim(text)

    native = pdf_to_text_sorted(data)
    ocr_piece = ""
    if vk and _needs_pdf_vision_fallback(data, native):
        try:
            parts = _pdf_render_pages_png(data, dpi=128, max_pages=24)
            batches: list[list[tuple[bytes, str]]] = []
            for i in range(0, len(parts), 4):
                batches.append(parts[i : i + 4])
            ocr_chunks: list[str] = []
            for bi, batch in enumerate(batches):
                if not batch:
                    continue
                p = (
                    f"다음은 {role_label} PDF의 일부 페이지 이미지입니다(배치 {bi + 1}/{len(batches)}). {role_ctx}\n"
                    + (
                        "수업 지도안으로 보이면 표·활동·평가·자료 열을 빠짐없이 마크다운 표로 옮기세요.\n"
                        if lesson_plan
                        else "평가문항이면 문항 번호·지문·선지를 빠짐없이 옮기세요.\n"
                    )
                    + "출력: 추출 텍스트만."
                )
                ocr_chunks.append(gemini_ocr_image_batch(batch, p, vk))
            ocr_piece = "\n\n".join(x for x in ocr_chunks if x).strip()
        except Exception as exc:
            ocr_piece = f"[스캔/OCR 보조 실패: {exc}]"

    merged = native.strip()
    if ocr_piece and not ocr_piece.startswith("["):
        merged = (merged + "\n\n[스캔·이미지 기반 보충 인식]\n" + ocr_piece).strip() if merged else ocr_piece
    elif ocr_piece:
        merged = (merged + "\n\n" + ocr_piece).strip() if merged else ocr_piece

    if not merged.strip():
        if not vk and _needs_pdf_vision_fallback(data, native):
            return (
                f"[{role_label}: PDF에서 추출된 텍스트가 거의 없습니다(스캔본 가능성). "
                "Gemini API 키를 입력하면 페이지 이미지 OCR로 보충 인식합니다.]"
            )
        return f"[{role_label} 텍스트 추출 불가]"
    return _trim(merged)


def _trim(text: str) -> str:
    raw = (text or "").strip()
    if len(raw) > 32000:
        lines = raw.split("\n")
        keywords = [
            "성취기준",
            "평가",
            "수업",
            "활동",
            "교수",
            "학습",
            "단원",
            "차시",
            "목표",
            "전개",
            "도입",
            "정리",
            "자료",
            "교과서",
            "지도",
            "문항",
            "확인",
            "탐구",
        ]
        captured: list[str] = []
        for i, line in enumerate(lines):
            if any(k in line for k in keywords):
                captured.extend(lines[max(0, i - 8) : min(len(lines), i + 9)])
        seen: set[str] = set()
        uniq = [ln for ln in captured if not (ln in seen or seen.add(ln))]
        if uniq:
            raw = "\n".join(uniq)
    if len(raw) > 24000:
        raw = raw[:24000] + "\n...(이하 생략)..."
    return raw.strip()
