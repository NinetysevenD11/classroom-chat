"""
Playwright Chromium 실행 — 번들 브라우저가 없을 때 시스템 Chrome/Edge로 폴백.

Cursor 샌드박스 등에서 PLAYWRIGHT_BROWSERS_PATH가 비어 있거나
chromium_headless_shell이 내려받아지지 않은 경우가 있어,
html_to_pdf / layout_audit가 동일하게 실패하지 않도록 한다.
"""
from __future__ import annotations

from pathlib import Path

# A4 가로 (96 CSS px/in) — HTML .page 크기·Playwright 뷰포트·PDF 출력 공통
A4_LANDSCAPE_WIDTH_PX = 1123   # 297mm
A4_LANDSCAPE_HEIGHT_PX = 794   # 210mm
A4_LANDSCAPE_WIDTH_MM = "297mm"
A4_LANDSCAPE_HEIGHT_MM = "210mm"
A4_LANDSCAPE_ASPECT = 297 / 210


def _is_missing_browser_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if "executable doesn't exist" in msg:
        return True
    if "playwright install" in msg:
        return True
    if "could not find" in msg and "chromium" in msg:
        return True
    return False


async def launch_chromium(playwright, *, headless: bool = True):
    """
    bundled Chromium → channel=chrome → channel=msedge 순으로 시도.
    """
    import os

    docker_args = []
    if os.environ.get("RENDER") or os.environ.get("FLY_APP_NAME") or Path("/.dockerenv").exists():
        docker_args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]

    last: BaseException | None = None
    for channel in (None, "chrome", "msedge"):
        try:
            if channel is None:
                return await playwright.chromium.launch(
                    headless=headless,
                    args=docker_args or None,
                )
            return await playwright.chromium.launch(
                channel=channel,
                headless=headless,
                args=docker_args or None,
            )
        except Exception as exc:
            last = exc
            if _is_missing_browser_error(exc):
                continue
            raise
    raise RuntimeError(
        "Playwright용 Chromium/Chrome 실행 파일을 찾을 수 없습니다.\n"
        "프로젝트 폴더에서 아래를 한 번 실행한 뒤 다시 시도하세요:\n"
        "  python -m playwright install chromium\n"
        "또는 Google Chrome(또는 Edge)이 설치되어 있어야 자동 폴백이 동작합니다."
    ) from last


async def worksheet_viewport_height(page) -> int:
    """문서 내 .page 개수에 맞춰 뷰포트 높이(px) 계산."""
    try:
        count = await page.evaluate(
            "() => document.querySelectorAll('.page').length || 1"
        )
    except Exception:
        count = 1
    return A4_LANDSCAPE_HEIGHT_PX * max(int(count), 1)


async def prepare_worksheet_page(page) -> None:
    """A4 가로 비율에 맞게 뷰포트·인쇄 미디어·auto-fit 적용."""
    await page.set_viewport_size({
        "width": A4_LANDSCAPE_WIDTH_PX,
        "height": await worksheet_viewport_height(page),
    })
    await page.emulate_media(media="print")
    for _ in range(3):
        try:
            await page.evaluate(
                "() => { if (typeof window.__lessonRunAutoFit === 'function') window.__lessonRunAutoFit(); }"
            )
        except Exception:
            pass
        await page.wait_for_timeout(400)


async def write_worksheet_pdf(page, pdf_path: Path) -> None:
    """렌더된 HTML을 A4 가로 PDF로 저장."""
    await page.pdf(
        path=str(pdf_path),
        width=A4_LANDSCAPE_WIDTH_MM,
        height=A4_LANDSCAPE_HEIGHT_MM,
        print_background=True,
        margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
        prefer_css_page_size=True,
    )
