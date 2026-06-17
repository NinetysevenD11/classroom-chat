"""
파이프라인 오케스트레이터 — v12 (지도서 이미지 전달 완결본)
- analyze.py의 call_*_stream과 시그니처 일치
- guide_images_b64는 키워드 인자로 전달
"""
from __future__ import annotations

import asyncio
import random
import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from pdf_utils import pdf_page_to_b64, pdf_to_text
from services.playwright_launch import launch_chromium

HERE = Path(__file__).parent
SERVICES_DIR = HERE / "services"
TEMPLATES_DIR = HERE / "templates"
_persist = os.environ.get("LESSON_PERSIST_DIR")
if _persist:
    OUTPUTS_DIR = Path(_persist) / "outputs"
else:
    OUTPUTS_DIR = HERE / "outputs"
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

STEPS: list[tuple[str, str]] = [
    ("analyze_lesson", "차시 분석"),
    ("review_analysis", "차시 검토"),
    ("match_curriculum", "교육과정 매칭"),
    ("plan_activities", "활동 계획"),
    ("review_activities", "활동 검토"),
    ("render_html", "HTML 렌더"),
    ("verify_output", "최종 검증"),
]
STEP_KEYS = [k for k, _ in STEPS]

@dataclass
class StepProgress:
    bucket_name: str
    step: str
    status: str
    message: str = ""
    thinking: str = ""
    thinking_partial: str = ""
    pdf_path: Optional[Path] = None
    html_path: Optional[Path] = None
    attempt: int = 1

ProgressCallback = Callable[[StepProgress], None]

def has_api_key(key: str | None = None) -> bool:
    k = (key if key is not None else os.environ.get("ANTHROPIC_API_KEY", "")).strip()
    return bool(k and k.startswith("sk-ant"))

def has_gemini_key(key: str | None = None) -> bool:
    k = (key or "").strip()
    # Google API key는 보통 AIza로 시작하지만, 포맷 강제는 느슨하게
    return bool(k and len(k) >= 20)

_TRANSIENT_HINTS = ("rate limit", "overloaded", "529", "503", "unavailable", "temporarily", "high demand")

def _is_transient_exc(exc: Exception) -> bool:
    msg = (str(exc) or "").lower()
    return any(h in msg for h in _TRANSIENT_HINTS)

async def _retry_call(fn, *args, max_attempts=8, on_attempt=None, **kwargs):
    last_exc: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        if on_attempt: on_attempt(attempt)
        try:
            return await fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            # 일시적 과부하/레이트리밋만 백오프 재시도. 그 외는 즉시 표면화.
            if not _is_transient_exc(exc):
                raise
            if attempt >= max_attempts:
                raise
            # exponential backoff with jitter (cap)
            base = min(40.0, (2 ** attempt))
            jitter = random.uniform(0.0, 1.3)
            await asyncio.sleep(base + jitter)
    if last_exc: raise last_exc


def _guide_total_pages(guide_bytes: bytes) -> int:
    if not guide_bytes:
        return 0
    try:
        import fitz
        doc = fitz.open(stream=guide_bytes, filetype="pdf")
        n = len(doc)
        doc.close()
        return int(n)
    except Exception:
        return 0


def _tb_to_guide_center_page(tb_page_0: int, textbook_total_pages: int, guide_total: int) -> int:
    """교과서 0-based 페이지 → 지도서 0-based 중심 페이지(비례 매핑)."""
    if guide_total <= 0:
        return 0
    ratio = int(tb_page_0) / max(1, int(textbook_total_pages or 1))
    return int(guide_total * ratio)


def _guide_anchor_centers(page_indices: list[int], textbook_total_pages: int, guide_total: int) -> list[int]:
    """
    교과서 버킷의 페이지 범위를 반영해 지도서에서 여러 '앵커' 중심을 만든다.
    - 시작/끝/중앙(평균)을 사용해, 긴 구간에서도 지도서가 따라가도록 한다.
    """
    if not page_indices or guide_total <= 0:
        return []
    pages = sorted({int(p) for p in page_indices if p is not None})
    if not pages:
        return []
    anchors = [pages[0], pages[-1]]
    if len(pages) >= 3:
        anchors.append(int(round(sum(pages) / len(pages))))
    # 중복 제거(정렬은 중심 변환 후에)
    out: list[int] = []
    for a in anchors:
        c = _tb_to_guide_center_page(a, textbook_total_pages, guide_total)
        c = max(0, min(guide_total - 1, c))
        out.append(c)
    # 중복 제거(순서 유지)
    seen = set()
    uniq: list[int] = []
    for c in out:
        if c in seen:
            continue
        seen.add(c)
        uniq.append(c)
    return uniq


def _expand_guide_pages(
    guide_total: int,
    centers: list[int],
    radius_each_side: int,
    max_pages: int,
) -> list[int]:
    """여러 중심을 기준으로 반경을 합쳐, 최대 max_pages까지 페이지 목록을 만든다."""
    if guide_total <= 0 or not centers:
        return []
    r = max(0, int(radius_each_side))
    picked: list[int] = []
    seen = set()
    for c in centers:
        lo = max(0, int(c) - r)
        hi = min(guide_total - 1, int(c) + r)
        for p in range(lo, hi + 1):
            if p in seen:
                continue
            seen.add(p)
            picked.append(p)
            if len(picked) >= max_pages:
                return picked
    return picked


def _candidate_guide_search_pages(
    guide_total: int,
    centers: list[int],
    window_each_side: int = 30,
    max_candidates: int = 220,
) -> list[int]:
    """
    지도서 전체를 매번 스캔하지 않도록, 비례 매핑으로 얻은 centers 주변만 후보로 만든다.
    """
    if guide_total <= 0:
        return []
    if not centers:
        # centers가 없으면 앞쪽만 제한적으로(최대 max_candidates)
        return list(range(0, min(guide_total, max_candidates)))
    w = max(0, int(window_each_side))
    seen = set()
    out: list[int] = []
    for c in centers:
        lo = max(0, int(c) - w)
        hi = min(guide_total - 1, int(c) + w)
        for p in range(lo, hi + 1):
            if p in seen:
                continue
            seen.add(p)
            out.append(p)
            if len(out) >= max_candidates:
                return out
    return out


def _match_guide_pages_that_reference_textbook_pages(
    guide_bytes: bytes,
    textbook_page_indices: list[int],
    textbook_total_pages: int,
    guide_total_pages: int,
    candidate_pages: list[int],
    max_hits: int = 8,
) -> list[int]:
    """
    지도서 텍스트에서 교과서 페이지(예: p.12, 12쪽, 교과서 12)를 언급/표기한
    지도서 페이지를 찾아 반환한다. 매칭 실패 시 빈 리스트.
    """
    if not guide_bytes or not textbook_page_indices:
        return []
    try:
        import re
        import fitz

        # 1-based 교과서 페이지 번호
        tb_pages_1 = sorted({int(p) + 1 for p in textbook_page_indices if p is not None and int(p) >= 0})
        if not tb_pages_1:
            return []

        # 숫자들을 한 번에 찾되, 너무 관대한 매칭(예: 1이 10의 일부로 잡힘)을 피한다.
        nums = "|".join(re.escape(str(n)) for n in tb_pages_1[:80])  # 안전 상한
        # 대표적인 표기 패턴들
        rx = re.compile(
            rf"(?:교과서|교재|본문)?\s*(?:p\.|p|페이지)?\s*(?:{nums})\b|(?:{nums})\s*쪽",
            re.IGNORECASE,
        )

        doc = fitz.open(stream=guide_bytes, filetype="pdf")
        hits: list[tuple[int, int]] = []  # (score, page)
        for p in candidate_pages:
            if p < 0 or p >= len(doc):
                continue
            try:
                t = doc.load_page(p).get_text("text") or ""
            except Exception:
                t = ""
            if not t:
                continue
            m = rx.findall(t)
            if not m:
                continue
            # 점수: 매칭된 횟수(대략적인 관련도)
            hits.append((len(m), int(p)))

        doc.close()
        if not hits:
            return []

        hits.sort(key=lambda x: (-x[0], x[1]))
        picked = [p for _, p in hits[: max(1, int(max_hits))]]
        # 원래 순서 유지(오름차순)
        picked = sorted(set(picked))
        # 안전 범위 내로 클램프
        picked = [max(0, min(int(guide_total_pages) - 1, int(p))) for p in picked if guide_total_pages > 0]
        return picked
    except Exception:
        return []


def _extract_guide_images(
    guide_bytes: bytes,
    textbook_page_indices: list[int],
    textbook_total_pages: int,
    radius_each_side: int = 5,
    max_pages: int = 10,
) -> list[str]:
    """지도서에서 교과서 구간에 대응하는 페이지들을 이미지로 추출(확장 스팬)."""
    if not guide_bytes:
        return []
    try:
        gtotal = _guide_total_pages(guide_bytes)
        if gtotal <= 0:
            return []
        centers = _guide_anchor_centers(textbook_page_indices, textbook_total_pages, gtotal)
        candidates = _candidate_guide_search_pages(gtotal, centers)
        matched = _match_guide_pages_that_reference_textbook_pages(
            guide_bytes,
            textbook_page_indices,
            textbook_total_pages,
            gtotal,
            candidates,
            max_hits=min(8, max_pages),
        )
        if matched:
            pages = _expand_guide_pages(
                gtotal,
                matched,
                radius_each_side=max(1, radius_each_side // 2),
                max_pages=max_pages,
            )
        else:
            pages = _expand_guide_pages(
                gtotal, centers, radius_each_side=radius_each_side, max_pages=max_pages
            )
        return [pdf_page_to_b64(guide_bytes, p, dpi=100) for p in pages]
    except Exception as e:
        print(f"[경고] 지도서 이미지 추출 실패: {e}")
        return []


def _extract_guide_text_for_bucket(
    guide_bytes: bytes,
    textbook_page_indices: list[int],
    textbook_total_pages: int,
    max_chars: int = 32000,
    radius_each_side: int = 8,
    max_pages: int = 24,
) -> str:
    """
    지도서 PDF에서 교과서 버킷 페이지 범위를 반영해 '주변 여러 페이지' 텍스트를 추출한다.
    (이미지 추출과 동일한 앵커/스팬 로직을 사용)
    """
    if not guide_bytes or not textbook_page_indices:
        return ""
    gtotal = _guide_total_pages(guide_bytes)
    if gtotal <= 0:
        return ""
    centers = _guide_anchor_centers(textbook_page_indices, textbook_total_pages, gtotal)
    candidates = _candidate_guide_search_pages(gtotal, centers)
    matched = _match_guide_pages_that_reference_textbook_pages(
        guide_bytes,
        textbook_page_indices,
        textbook_total_pages,
        gtotal,
        candidates,
        max_hits=min(10, max_pages),
    )
    if matched:
        pages = _expand_guide_pages(
            gtotal,
            matched,
            radius_each_side=max(1, radius_each_side // 2),
            max_pages=max_pages,
        )
    else:
        pages = _expand_guide_pages(
            gtotal, centers, radius_each_side=radius_each_side, max_pages=max_pages
        )
    try:
        import fitz
        doc = fitz.open(stream=guide_bytes, filetype="pdf")
        chunks: list[str] = []
        for p in pages:
            if p < 0 or p >= len(doc):
                continue
            try:
                t = doc.load_page(p).get_text("text") or ""
            except Exception:
                t = ""
            t = (t or "").strip()
            if t:
                chunks.append(f"[지도서 p.{p+1}]\n{t}")
        doc.close()
        merged = "\n\n".join(chunks).strip()
        if not merged:
            return ""
        if len(merged) > max_chars:
            merged = merged[:max_chars] + "\n...(이하 생략)..."
        return merged.strip()
    except Exception as e:
        print(f"[경고] 지도서 텍스트 추출 실패: {e}")
        return ""


async def step_understand(
    bucket_index: int, total_buckets: int, subject: str,
    textbook_bytes: bytes, page_indices: list[int],
    curriculum_text: str, 
    guide_bytes: Optional[bytes] = None,
    textbook_total_pages: int = 100,
    on_stream_delta=None,
    api_key: str | None = None,
    provider: str = "anthropic",
) -> dict:
    if provider == "gemini":
        if not has_gemini_key(api_key):
            raise RuntimeError("🚨 에러: 개인 API KEY가 없거나 올바르지 않습니다.")
    else:
        if not has_api_key(api_key):
            raise RuntimeError("🚨 에러: 개인 API KEY가 없거나 올바르지 않습니다.")

    from services.analyze import call_understand_stream
    images_b64 = [pdf_page_to_b64(textbook_bytes, i) for i in page_indices]
    guide_images_b64 = (
        _extract_guide_images(guide_bytes, page_indices, textbook_total_pages)
        if guide_bytes
        else []
    )
    
    return await asyncio.to_thread(
        call_understand_stream,
        None,
        curriculum_text,
        images_b64,
        bucket_index + 1,
        total_buckets,
        subject,
        on_stream_delta,
        guide_images_b64,
        api_key,
        provider,
    )


async def step_design(
    overview: dict,
    bucket_index: int,
    total_buckets: int,
    subject: str,
    textbook_bytes: bytes,
    page_indices: list[int],
    guide_bytes: Optional[bytes] = None,
    textbook_total_pages: int = 100,
    guide_text: str | None = None,
    on_stream_delta=None,
    api_key: str | None = None,
    provider: str = "anthropic",
) -> dict:
    if provider == "gemini":
        if not has_gemini_key(api_key):
            raise RuntimeError("🚨 에러: 개인 API KEY가 없거나 올바르지 않습니다.")
    else:
        if not has_api_key(api_key):
            raise RuntimeError("🚨 에러: 개인 API KEY가 없거나 올바르지 않습니다.")

    from services.analyze import call_design_stream
    images_b64 = [pdf_page_to_b64(textbook_bytes, i) for i in page_indices]
    guide_images_b64 = (
        _extract_guide_images(guide_bytes, page_indices, textbook_total_pages)
        if guide_bytes
        else []
    )
    
    return await asyncio.to_thread(
        call_design_stream,
        None,
        overview,
        images_b64,
        bucket_index + 1,
        total_buckets,
        subject,
        on_stream_delta,
        guide_images_b64,
        guide_text,
        api_key,
        provider,
    )


def render_lesson_html(lesson_json: dict, textbook_images: list[str] = None) -> str:
    """HTML 렌더링. 
    - clean_content: 언더스코어·중복 공백 제거
    - clean_array: 배열에서 빈/공백 문자열 제거
    - illustration_svg: overview의 illustration_key로 SVG 주입
    """
    import re
    from jinja2 import Environment, FileSystemLoader, select_autoescape
    from services.illustrations import get_illustration

    def clean_content(text):
        if not text or not isinstance(text, str):
            return text
        text = re.sub(r'_{3,}', '', text)
        text = re.sub(r'[ \t]{2,}', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r'→\s*\n', '', text)
        return text.strip()
    
    def clean_array(arr):
        """배열에서 빈/공백 문자열 제거. 빈 배열이면 []."""
        if not arr or not isinstance(arr, list):
            return []
        return [str(x).strip() for x in arr if x and str(x).strip()]
    
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        autoescape=select_autoescape(["html"])
    )
    env.filters['clean_content'] = clean_content
    env.filters['clean_array'] = clean_array
    
    # illustration_key로 SVG 조회
    illustration_key = lesson_json.get('illustration_key', 'default')
    illustration_svg = get_illustration(illustration_key)['svg']
    
    template = env.get_template("lesson_template.j2.html")
    return template.render(
        **lesson_json,
        textbook_images=textbook_images or [],
        illustration_svg=illustration_svg,
    )


async def html_to_pdf(html: str, pdf_path: Path) -> None:
    from playwright.async_api import async_playwright
    from services.playwright_launch import (
        A4_LANDSCAPE_HEIGHT_PX,
        A4_LANDSCAPE_WIDTH_PX,
        prepare_worksheet_page,
        write_worksheet_pdf,
    )
    tmp_html = pdf_path.with_suffix(".rendered.html")
    tmp_html.write_text(html, encoding="utf-8")
    async with async_playwright() as p:
        browser = await launch_chromium(p)
        page = await browser.new_page(viewport={
            "width": A4_LANDSCAPE_WIDTH_PX,
            "height": A4_LANDSCAPE_HEIGHT_PX,
        })
        await page.goto(tmp_html.resolve().as_uri(), wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await prepare_worksheet_page(page)
        await write_worksheet_pdf(page, pdf_path)
        await browser.close()
    tmp_html.unlink(missing_ok=True)


def verify_lesson_json(lesson: dict) -> tuple[bool, str]:
    """
    Tool Use를 써도 Claude가 이상한 응답을 뱉을 수 있으니 방어.
    blocks가 비어있으면 상세 진단 정보 포함.
    """
    blocks = lesson.get("blocks", [])
    if not blocks:
        # 디버깅 정보 덤프
        print("=" * 60)
        print("[검증 실패] blocks가 비어있음")
        print(f"  lesson_json keys: {list(lesson.keys())}")
        print(f"  worksheet_title: {lesson.get('worksheet_title', 'N/A')}")
        print(f"  hook_question: {lesson.get('hook_question', 'N/A')}")
        print(f"  illustration_key: {lesson.get('illustration_key', 'N/A')}")
        print("=" * 60)
        return False, (
            "blocks 배열이 비어있습니다. "
            "Claude가 design_lesson 도구를 제대로 호출하지 않았을 수 있습니다. "
            "다시 시도해 주세요."
        )

    # phase별 분포 확인
    phase_counts = {"intro": 0, "develop": 0, "wrap": 0}
    for b in blocks:
        phase = b.get("phase")
        if phase in phase_counts:
            phase_counts[phase] += 1
    
    missing_phases = [p for p, c in phase_counts.items() if c == 0]
    if missing_phases:
        print(f"[경고] 다음 단계에 블록이 없습니다: {missing_phases}")

    required_fields = {
        "comparison_table": ["table_headers", "table_rows"],
        "matching": ["matching_left", "matching_right"],
        "sequence_ordering": ["sequence_items"],
        "data_interpretation": ["data_text", "data_questions"],
        "wrap_up": ["keywords"],  # v14.1 추가
    }

    for i, block in enumerate(blocks):
        btype = block.get("block_type", "")
        required = required_fields.get(btype, [])
        for f in required:
            val = block.get(f)
            if not val or (isinstance(val, list) and len(val) == 0):
                print(f"  [경고] 블록 #{i} ({btype}) — 필드 '{f}' 누락, 빈 박스로 대체됨")

        if btype == "matching":
            L = [x for x in (block.get("matching_left") or []) if x and str(x).strip()]
            R = [x for x in (block.get("matching_right") or []) if x and str(x).strip()]
            if L and R and len(L) != len(R):
                print(f"  [경고] 블록 #{i} matching — 좌({len(L)})/우({len(R)}) 개수 불일치")

    return True, "정상"


async def process_bucket(
    bucket_name: str, bucket_index: int, total_buckets: int, subject: str,
    textbook_bytes: bytes, page_indices: list[int], curriculum_text: str, 
    output_dir: Path, on_progress: ProgressCallback,
    guide_bytes: Optional[bytes] = None,
    textbook_total_pages: int = 100,
    api_key: str | None = None,
    provider: str = "anthropic",
    admin_fast: bool = False,
) -> Path:
    max_api_attempts = 3 if admin_fast else 8
    layout_audit_iters = 1 if admin_fast else 3

    def emit(step, status, message="", thinking="", thinking_partial="", pdf_path=None, html_path=None, attempt=1):
        on_progress(StepProgress(bucket_name, step, status, message, thinking, thinking_partial, pdf_path, html_path, attempt))

    stream_state = {"buffer": ""}
    def extract_thinking_from_partial(buf: str) -> tuple[str, str]:
        import re as _re
        matches = list(_re.finditer(r'"(thinking_[a-z_]+)"\s*:\s*"', buf))
        if not matches: return "", ""
        m = matches[-1]
        value_start = m.end()
        value_end = buf.find('"', value_start)
        value = buf[value_start:] if value_end < 0 else buf[value_start:value_end]
        return m.group(1), value

    def make_stream_handler(steps_in_call: list[str]):
        def handler(event_type: str, text: str):
            if event_type == 'text':
                stream_state["buffer"] += text
                field, value = extract_thinking_from_partial(stream_state["buffer"])
                if field:
                    step_for_field = {
                        "thinking_summary": "analyze_lesson", "thinking_curriculum": "match_curriculum",
                        "thinking_activities": "plan_activities", "thinking_review": "review_activities",
                    }.get(field, steps_in_call[0])
                    emit(step_for_field, "streaming", "Claude 사고 중...", thinking_partial=value)
        return handler

    # === Call 1: Understand ===
    for step in ["analyze_lesson", "review_analysis", "match_curriculum"]:
        emit(step, "running", "모델 호출 중...")
    try:
        def on_attempt_1(n):
            if n > 1:
                for s in ["analyze_lesson", "review_analysis", "match_curriculum"]:
                    emit(s, "running", f"재시도 {n}/{max_api_attempts}", attempt=n)
        stream_state["buffer"] = ""
        overview = await _retry_call(
            step_understand,
            bucket_index,
            total_buckets,
            subject,
            textbook_bytes,
            page_indices,
            curriculum_text,
            guide_bytes=guide_bytes,
            textbook_total_pages=textbook_total_pages,
            on_stream_delta=make_stream_handler(
                ["analyze_lesson", "review_analysis", "match_curriculum"]
            ),
            api_key=api_key,
            provider=provider,
            on_attempt=on_attempt_1,
            max_attempts=max_api_attempts,
        )
    except Exception as exc:
        emit("analyze_lesson", "error", str(exc))
        raise

    emit("analyze_lesson", "success", "완료", thinking=overview.get("thinking_summary", ""))
    await asyncio.sleep(0.04 if admin_fast else 0.15)
    emit("review_analysis", "success", "완료", thinking=overview.get("thinking_summary", ""))
    await asyncio.sleep(0.04 if admin_fast else 0.15)
    emit("match_curriculum", "success", "완료", thinking=overview.get("thinking_curriculum", ""))

    # === Call 2: Design ===
    for step in ["plan_activities", "review_activities"]:
        emit(step, "running", "모델 호출 중...")
    try:
        guide_text_for_design = (
            _extract_guide_text_for_bucket(
                guide_bytes,
                page_indices,
                textbook_total_pages,
            )
            if guide_bytes
            else ""
        )
        def on_attempt_2(n):
            if n > 1:
                for s in ["plan_activities", "review_activities"]:
                    emit(s, "running", f"재시도 {n}/{max_api_attempts}", attempt=n)
        stream_state["buffer"] = ""
        design = await _retry_call(
            step_design,
            overview,
            bucket_index,
            total_buckets,
            subject,
            textbook_bytes,
            page_indices,
            guide_bytes=guide_bytes,
            textbook_total_pages=textbook_total_pages,
            guide_text=guide_text_for_design or None,
            on_stream_delta=make_stream_handler(["plan_activities", "review_activities"]),
            api_key=api_key,
            provider=provider,
            on_attempt=on_attempt_2,
            max_attempts=max_api_attempts,
        )
    except Exception as exc:
        emit("plan_activities", "error", str(exc))
        raise

    emit("plan_activities", "success", "완료", thinking=design.get("thinking_activities", ""))
    await asyncio.sleep(0.04 if admin_fast else 0.15)
    emit("review_activities", "success", "완료", thinking=design.get("thinking_review", ""))

    # === Render ===
    emit("render_html", "running", "렌더링 중...")
    try:
        lesson_json = {
            "meta": overview.get("meta", {}) or {"subject": subject},
            "worksheet_title": design.get("worksheet_title", "학습지"),
            "blocks": design.get("blocks", []),
            # v14 추가: 일러스트 키와 후킹 질문
            "illustration_key": overview.get("illustration_key", "default"),
            "hook_question": design.get("hook_question", ""),
        }
        # meta에 subject 보장
        if "subject" not in lesson_json["meta"]:
            lesson_json["meta"]["subject"] = subject
        all_pages_b64 = [pdf_page_to_b64(textbook_bytes, p) for p in page_indices] if page_indices else []
        html = render_lesson_html(lesson_json, textbook_images=all_pages_b64)
        
        safe_name = bucket_name.replace("/", "_")
        html_path = output_dir / f"{subject}_{safe_name}.preview.html"
        html_path.write_text(html, encoding="utf-8")
        emit("render_html", "success", "HTML 준비 완료", html_path=html_path)
    except Exception as exc:
        emit("render_html", "error", str(exc))
        raise

    # === Verify + PDF ===
    emit("verify_output", "running", "최종 검증 중...")
    try:
        ok, reason = verify_lesson_json(lesson_json)
        if not ok:
            raise RuntimeError(f"검증 실패: {reason}")
        safe_name = bucket_name.replace("/", "_")
        pdf_path = output_dir / f"{subject}_{safe_name}.pdf"

        # 레이아웃 감사 + 보정 (작업 4)
        try:
            from layout_audit import audit_and_correct
            html, audit_log = await audit_and_correct(html, max_iterations=layout_audit_iters)
            for line in audit_log:
                print(f"[layout_audit] {line}")
            # 보정된 HTML을 미리보기 파일에도 반영
            html_path.write_text(html, encoding="utf-8")
        except Exception as audit_exc:
            print(f"[layout_audit] 감사 실패 (무시하고 진행): {audit_exc}")

        await html_to_pdf(html, pdf_path)
        emit("verify_output", "success", "완료", pdf_path=pdf_path)
        return pdf_path
    except Exception as exc:
        emit("verify_output", "error", str(exc))
        raise


async def _extract_supplement_async(
    data: bytes,
    filename: str | None,
    subject: str,
    role_label: str,
    *,
    lesson_plan: bool,
    vision_key: str | None,
) -> str:
    """평가문항·수업 지도안: PDF/이미지 텍스트 + 필요 시 Gemini OCR."""
    from services.document_text import extract_supplement_text

    return await asyncio.to_thread(
        extract_supplement_text,
        data,
        filename or "",
        subject,
        role_label,
        lesson_plan=lesson_plan,
        vision_api_key=vision_key,
    )


def safe_extract_and_filter(pdf_bytes: bytes | None, name: str, subject: str) -> str:
    if not pdf_bytes: return ""
    raw_text = pdf_to_text(pdf_bytes)
    if not raw_text or not raw_text.strip():
        return f"[{name} 텍스트 추출 불가]"
    
    if len(raw_text) > 30000:
        lines = raw_text.split('\n')
        keywords = [subject, "5학년", "5~6학년", "성취기준", "학습요소", "평가", "단원", "목표"]
        captured_lines = []
        for i, line in enumerate(lines):
            if any(k in line for k in keywords):
                captured_lines.extend(lines[max(0, i - 10):min(len(lines), i + 11)])
        seen = set()
        unique_lines = [l for l in captured_lines if not (l in seen or seen.add(l))]
        if unique_lines: raw_text = '\n'.join(unique_lines)

    if len(raw_text) > 20000:
        raw_text = raw_text[:20000] + "\n...(이하 생략)..."
    return raw_text.strip()


def _get_textbook_total_pages(textbook_bytes: bytes) -> int:
    """교과서 PDF 총 페이지 수."""
    try:
        import fitz
        doc = fitz.open(stream=textbook_bytes, filetype="pdf")
        total = len(doc)
        doc.close()
        return total
    except Exception:
        return 100


async def run_pipeline(
    session,
    on_progress: ProgressCallback,
    resume_from: Optional[list[str]] = None,
    api_key: str | None = None,
    provider: str = "anthropic",
    admin_fast: bool = False,
    supplement_vision_key: str | None = None,
) -> list[Path]:
    from uuid import uuid4
    run_id = uuid4().hex[:8]
    run_dir = OUTPUTS_DIR / f"{session.subject}_{run_id}"
    run_dir.mkdir(parents=True, exist_ok=True)

    # 학년별 금지 개념 필터 (작업 7) — session.grade를 prompts 모듈에 컨텍스트로 박아둠
    try:
        from prompts import set_current_grade
        grade = getattr(session, "grade", None) or getattr(session, "grade_no", None)
        if isinstance(grade, str):
            try: grade = int(grade)
            except: grade = None
        set_current_grade(grade)
        if grade:
            print(f"[pipeline] 학년 컨텍스트 설정: {grade}학년 → 학년별 금지 개념 적용")
    except Exception as exc:
        print(f"[pipeline] set_current_grade 실패 (무시): {exc}")

    # 교육과정 텍스트 (선택)
    if session.curriculum_bytes:
        curriculum_text = safe_extract_and_filter(session.curriculum_bytes, "교육과정", session.subject)
        # 지도서 텍스트는 curriculum_text에 섞지 않고, 활동 설계(design) 단계에서 별도로 주입한다.
        if not curriculum_text.strip():
            curriculum_text = "텍스트 없음"
    else:
        curriculum_text = "텍스트 없음"

    vision_key = (supplement_vision_key or "").strip()
    if not vision_key and (provider or "").lower() == "gemini":
        vision_key = (api_key or "").strip()

    # 품질 보조 자료(선택): 평가문항 / 수업지도안 → PDF·이미지 모두 텍스트(필요 시 OCR)
    try:
        ass_bytes = getattr(session, "assessment_bytes", None)
        if ass_bytes:
            ass_text = await _extract_supplement_async(
                ass_bytes,
                getattr(session, "assessment_filename", None),
                session.subject,
                "평가문항",
                lesson_plan=False,
                vision_key=vision_key or None,
            )
            if ass_text:
                curriculum_text += "\n\n" + "[평가문항]\n" + ass_text
    except Exception:
        pass
    try:
        lp_bytes = getattr(session, "lesson_plan_bytes", None)
        if lp_bytes:
            lp_text = await _extract_supplement_async(
                lp_bytes,
                getattr(session, "lesson_plan_filename", None),
                session.subject,
                "수업 지도안",
                lesson_plan=True,
                vision_key=vision_key or None,
            )
            if lp_text:
                curriculum_text += "\n\n" + "[수업 지도안]\n" + lp_text
    except Exception:
        pass

    # 교과서 총 페이지 수 (지도서 비례 매칭용)
    textbook_total_pages = _get_textbook_total_pages(session.textbook_bytes)
    guide_bytes = getattr(session, 'guide_bytes', None)

    non_empty_buckets = [b for b in session.buckets if b.page_indices]
    results, failures = [], []
    for i, bucket in enumerate(non_empty_buckets):
        if resume_from and bucket.name in resume_from: continue
        try:
            pdf = await process_bucket(
                bucket.name, i, len(non_empty_buckets), session.subject,
                session.textbook_bytes, bucket.page_indices, curriculum_text, 
                run_dir, on_progress,
                guide_bytes=guide_bytes,
                textbook_total_pages=textbook_total_pages,
                api_key=api_key,
                provider=provider,
                admin_fast=admin_fast,
            )
            results.append(pdf)
        except Exception as exc:
            failures.append((bucket.name, str(exc)))

    if failures:
        on_progress(StepProgress(
            "전체", "verify_output", "error", 
            f"{len(results)}성공, {len(failures)}실패", 
            "; ".join(f"{n}:{e[:20]}" for n, e in failures)
        ))
    return results