"""
레이아웃 감사 + 자동 보정 (작업 4)

목적: 학습지 PDF 생성 직후 페이지별로 다음 두 가지 문제를 측정하고 자동 보정.
1) 활동 잘림 — 블록이 페이지 경계를 넘거나 두 페이지에 걸침
2) 빈 공간 20% 이상 — 마지막 블록 하단 ~ 페이지 푸터까지가 페이지 높이의 20% 초과

측정: Playwright로 렌더된 HTML을 열어 .block 의 DOM 좌표를 px로 측정
보정: CSS 변수 주입으로 그리드 스케일·답란 높이·폰트 크기 한 단계 축소
       또는 페이지 padding 미세 조정으로 빈 공간 감소
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import asyncio


from services.playwright_launch import (
    A4_LANDSCAPE_HEIGHT_PX as PAGE_HEIGHT_PX,
    A4_LANDSCAPE_WIDTH_PX as PAGE_WIDTH_PX,
    worksheet_viewport_height,
)
EMPTY_THRESHOLD = 0.20   # 푸터 위 빈 영역이 이만큼 넘으면 답란·여백 확대 보정


@dataclass
class PageAudit:
    """한 페이지의 감사 결과."""
    page_index: int
    page_class: str                  # cover, fit-one, 등
    block_count: int
    has_overflow: bool = False        # 페이지 경계 넘어간 블록 있음
    has_split_block: bool = False     # 두 페이지에 걸친 블록 있음
    empty_ratio: float = 0.0          # 마지막 블록 하단 이후 빈 공간 비율
    issues: list[str] = field(default_factory=list)

    @property
    def needs_fix(self) -> bool:
        return self.has_overflow or self.has_split_block or self.empty_ratio > EMPTY_THRESHOLD


@dataclass
class AuditReport:
    """전체 학습지 감사 결과."""
    pages: list[PageAudit] = field(default_factory=list)

    @property
    def needs_fix(self) -> bool:
        return any(p.needs_fix for p in self.pages)

    @property
    def overflow_count(self) -> int:
        return sum(1 for p in self.pages if p.has_overflow or p.has_split_block)

    @property
    def empty_count(self) -> int:
        return sum(1 for p in self.pages if p.empty_ratio > EMPTY_THRESHOLD)

    def summary(self) -> str:
        if not self.needs_fix:
            return f"모든 {len(self.pages)}쪽 정상"
        parts = []
        if self.overflow_count:
            parts.append(f"잘림 {self.overflow_count}쪽")
        if self.empty_count:
            parts.append(f"빈공간 {self.empty_count}쪽")
        return f"{len(self.pages)}쪽 중 문제 발견: " + ", ".join(parts)


async def audit_html(html_text: str) -> AuditReport:
    """렌더된 HTML 문자열을 받아 감사 결과 반환."""
    from playwright.async_api import async_playwright

    from services.playwright_launch import launch_chromium

    # 임시 HTML 파일
    import tempfile, os
    fd, tmp_path = tempfile.mkstemp(suffix=".html", text=True)
    os.close(fd)
    Path(tmp_path).write_text(html_text, encoding="utf-8")

    try:
        async with async_playwright() as p:
            browser = await launch_chromium(p)
            page = await browser.new_page(viewport={
                "width": PAGE_WIDTH_PX,
                "height": PAGE_HEIGHT_PX,
            })
            await page.goto(Path(tmp_path).resolve().as_uri(), wait_until="networkidle")
            await page.wait_for_timeout(800)
            await page.set_viewport_size({
                "width": PAGE_WIDTH_PX,
                "height": await worksheet_viewport_height(page),
            })
            await page.emulate_media(media="print")
            for _ in range(2):
                try:
                    await page.evaluate(
                        "() => { if (typeof window.__lessonRunAutoFit === 'function') window.__lessonRunAutoFit(); }"
                    )
                except Exception:
                    pass
                await page.wait_for_timeout(300)

            # 모든 .page와 그 안 .block 좌표 수집
            data = await page.evaluate(f"""() => {{
                const PAGE_H = {PAGE_HEIGHT_PX};
                const pages = Array.from(document.querySelectorAll('.page'));
                return pages.map((pg, idx) => {{
                    const r = pg.getBoundingClientRect();
                    const cls = pg.className;
                    const blocks = Array.from(pg.querySelectorAll('.block, .develop-block'));
                    const questions = Array.from(pg.querySelectorAll('.data-question'));
                    const blockData = blocks.map(b => {{
                        const br = b.getBoundingClientRect();
                        const innerOverflow = b.scrollHeight > b.clientHeight + 1;
                        return {{
                            top: br.top - r.top,
                            bottom: br.bottom - r.top,
                            height: br.height,
                            tag: b.className,
                            innerOverflow: innerOverflow,
                        }};
                    }});
                    const footer = pg.querySelector('.footer');
                    const footerTop = footer ? (footer.getBoundingClientRect().top - r.top) : PAGE_H;
                    const questionData = questions.map(q => {{
                        const qr = q.getBoundingClientRect();
                        const innerOverflow = q.scrollHeight > q.clientHeight + 1;
                        return {{
                            top: qr.top - r.top,
                            bottom: qr.bottom - r.top,
                            innerOverflow: innerOverflow,
                        }};
                    }});
                    return {{
                        index: idx,
                        pageClass: cls,
                        pageHeight: r.height,
                        footerTop: footerTop,
                        blocks: blockData,
                        questions: questionData,
                    }};
                }});
            }}""")

            await browser.close()
    finally:
        try: os.unlink(tmp_path)
        except: pass

    # 분석
    report = AuditReport()
    for page_data in data:
        audit = PageAudit(
            page_index=page_data["index"],
            page_class=page_data["pageClass"],
            block_count=len(page_data["blocks"]),
        )

        # 표지(cover) 페이지는 감사 제외 — 이미지만 들어가고 잘림 측정 의미 없음
        if "cover" in audit.page_class:
            report.pages.append(audit)
            continue

        page_h = page_data["pageHeight"] or PAGE_HEIGHT_PX
        footer_top = page_data["footerTop"]

        if page_data["blocks"]:
            # 블록 하단이 footer 아래면 잘림
            for b in page_data["blocks"]:
                if b["bottom"] > footer_top + 2:  # 2px 허용
                    audit.has_overflow = True
                    audit.issues.append(f"블록 하단 {b['bottom']:.0f}px > footer {footer_top:.0f}px")
                if b["bottom"] > page_h + 2:
                    audit.has_split_block = True
                    audit.issues.append(f"블록 페이지 경계 초과")
                if b.get("innerOverflow"):
                    audit.has_overflow = True
                    audit.issues.append("카드 내부 콘텐츠 오버플로")

            # 빈 공간 비율
            last_bottom = max(b["bottom"] for b in page_data["blocks"])
            usable_h = footer_top  # 푸터 위까지가 콘텐츠 영역
            if usable_h > 0:
                empty_h = max(0, usable_h - last_bottom)
                audit.empty_ratio = empty_h / usable_h
                if audit.empty_ratio > EMPTY_THRESHOLD:
                    audit.issues.append(f"빈 공간 {audit.empty_ratio*100:.0f}% (>20%)")

            # 문항 단위 잘림·내부 오버플로 (질문+답란이 한 덩어리로 잘리면 안 됨)
            for q in page_data.get("questions", []):
                if q.get("innerOverflow"):
                    audit.has_overflow = True
                    audit.issues.append("문항 단위 내부 오버플로")
                if q["bottom"] > footer_top + 2:
                    audit.has_overflow = True
                    audit.issues.append("문항이 푸터 영역 침범")

        report.pages.append(audit)

    return report


# =====================================================================
# 보정 — CSS 변수 주입
# 잘림: 블록을 통째로 살짝 축소
# 빈 공간: 빈 페이지 콘텐츠를 키워서 채움
# =====================================================================

async def audit_and_correct(html_text: str, max_iterations: int = 2) -> tuple[str, list[str]]:
    """감사 → 보정 → 재감사 루프 (최대 max_iterations회).
    회차마다 보정 강도가 점진적으로 더 강해짐.
    Returns: (최종 HTML, 적용된 보정 로그 리스트).
    """
    log = []
    current_html = html_text

    for i in range(max_iterations):
        report = await audit_html(current_html)
        log.append(f"[{i+1}회] {report.summary()}")

        if not report.needs_fix:
            break

        # 회차별 강도: 1회=중간, 2회=강
        intensity = i + 1
        new_html, note = apply_correction(current_html, report, intensity=intensity)
        log.append(f"  보정 (강도 {intensity}): {note}")

        if new_html == current_html:
            log.append("  더 이상 보정 불가 — 종료")
            break

        current_html = new_html

    # 최종 감사 — 여전히 잘리면 긴급 축소 CSS 주입
    final_report = await audit_html(current_html)
    if any(p.has_overflow or p.has_split_block for p in final_report.pages):
        emergency = """
<style id="layout-correction-emergency">
.blocks-grid.count-1 > .block.block-data_interpretation > .block-title {
    font-size: 15px !important;
    margin-bottom: 8px !important;
}
.blocks-grid.count-1 > .block.block-data_interpretation .data-source {
    max-height: 130px !important;
    font-size: 12px !important;
    line-height: 1.5 !important;
    padding: 10px 12px !important;
}
.blocks-grid.count-1 > .block.block-data_interpretation .data-question-text {
    font-size: 12.5px !important;
    line-height: 1.42 !important;
}
.blocks-grid.count-1 > .block.block-data_interpretation .data-answer-box {
    min-height: 56px !important;
}
.blocks-grid.count-1 > .block.block-data_interpretation .data-questions-stack {
    gap: 6px !important;
}
</style>
"""
        import re
        if "<style id=\"layout-correction-emergency\">" in current_html:
            current_html = re.sub(
                r'<style id="layout-correction-emergency">.*?</style>',
                emergency.strip(),
                current_html,
                count=1,
                flags=re.DOTALL,
            )
        elif "</head>" in current_html:
            current_html = current_html.replace("</head>", emergency + "</head>", 1)
        log.append(f"[긴급] {final_report.summary()} → 강제 축소 CSS 적용")

    return current_html, log


def apply_correction(html_text: str, report: AuditReport, intensity: int = 1) -> tuple[str, str]:
    """감사 결과를 바탕으로 CSS 변수를 HTML <head>에 주입.
    intensity: 1=가벼운 보정, 2=강한 보정.
    Returns: (수정된 HTML, 적용된 보정 설명).
    """
    if not report.needs_fix:
        return html_text, "보정 불필요"

    needs_shrink = any(p.has_overflow or p.has_split_block for p in report.pages)
    needs_grow = any(p.empty_ratio > EMPTY_THRESHOLD and not (p.has_overflow or p.has_split_block) for p in report.pages)

    css_vars = []
    notes = []

    if needs_shrink:
        # 강도별 축소 — 답란은 학생 필기 공간을 위해 덜 축소
        font_scale = 0.94 if intensity == 1 else 0.88
        pad_scale = 0.86 if intensity == 1 else 0.76
        ans_scale = 0.90 if intensity == 1 else 0.82
        source_max = "180px" if intensity == 1 else "155px"
        css_vars.append(f"--block-font-scale: {font_scale};")
        css_vars.append(f"--block-padding-scale: {pad_scale};")
        css_vars.append(f"--answerbox-minheight-scale: {ans_scale};")
        css_vars.append(f"--data-source-max-height: {source_max};")
        notes.append(f"잘림 {report.overflow_count}쪽 → 폰트/여백/자료 축소 (답란 최소 유지)")

    if needs_grow and not needs_shrink:
        max_empty = max(
            (p.empty_ratio for p in report.pages if p.empty_ratio > EMPTY_THRESHOLD),
            default=EMPTY_THRESHOLD,
        )
        fill_boost = 1.0 + (max_empty - EMPTY_THRESHOLD) * 5
        ans_scale = min(2.2, (1.45 if intensity == 1 else 1.75) * fill_boost)
        pad_scale = 1.06 if intensity == 1 else 1.12
        css_vars.append(f"--answerbox-minheight-scale: {ans_scale:.3f};")
        css_vars.append(f"--block-padding-scale: {pad_scale};")
        css_vars.append("--answerbox-flex-grow: 1;")
        notes.append(f"빈공간 {report.empty_count}쪽 → 답란 확대 (목표 여백 ≤20%)")

    if not css_vars:
        return html_text, "보정 불필요"

    correction_css = f"""
<style id="layout-correction">
:root {{
{chr(10).join('    ' + v for v in css_vars)}
}}
.block, .develop-block, .matching-rows, .matching-container, .ox-container {{
    font-size: calc(1em * var(--block-font-scale, 1));
    padding: calc(14px * var(--block-padding-scale, 1)) calc(16px * var(--block-padding-scale, 1));
}}
.box, .answer-box, .data-answer-box {{
    min-height: calc(72px * var(--answerbox-minheight-scale, 1)) !important;
    flex: var(--answerbox-flex-grow, 1) 1 auto !important;
}}
.block > .box:last-of-type,
.block .data-answer-box {{
    flex: var(--answerbox-flex-grow, 1) 1 auto !important;
}}
.data-question, .data-question-body {{
    break-inside: avoid !important;
    page-break-inside: avoid !important;
}}
.blocks-grid.count-1 > .block.block-data_interpretation .data-source {{
    max-height: var(--data-source-max-height, min(210px, 32vh)) !important;
    font-size: calc(14.25px * var(--block-font-scale, 1));
}}
.blocks-grid.count-1 > .block.block-data_interpretation .data-question-text {{
    font-size: calc(15px * var(--block-font-scale, 1));
}}
</style>
"""
    # 기존 보정 CSS가 있으면 교체
    import re
    if "<style id=\"layout-correction\">" in html_text:
        new_html = re.sub(
            r'<style id="layout-correction">.*?</style>',
            correction_css.strip(),
            html_text,
            count=1,
            flags=re.DOTALL,
        )
    elif "</head>" in html_text:
        new_html = html_text.replace("</head>", correction_css + "</head>", 1)
    else:
        new_html = correction_css + html_text

    return new_html, " · ".join(notes)
