"""
JSON(analyze.py 출력) + 교과서 이미지 → HTML → PDF 렌더링.

사용:
    python render.py --json 1차시.json \
                     --textbook-image p54.png \
                     --out 1차시.pdf

의존성:
    pip install jinja2 playwright
    playwright install chromium
"""

import argparse
import asyncio
import base64
import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from playwright.async_api import async_playwright

from .playwright_launch import (
    A4_LANDSCAPE_HEIGHT_PX,
    A4_LANDSCAPE_WIDTH_PX,
    launch_chromium,
    prepare_worksheet_page,
    write_worksheet_pdf,
)

HERE = Path(__file__).parent
TEMPLATE_NAME = "lesson_template.j2.html"


def image_to_data_url(path: Path) -> str:
    """
    교과서 이미지를 base64 data URL로 변환.
    HTML에 삽입할 때 외부 파일 경로 대신 data URL을 쓰면
    Playwright가 파일 접근 권한 걱정 없이 바로 렌더링한다.
    """
    ext = path.suffix.lower().lstrip(".")
    mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png"}.get(ext, "png")
    b64 = base64.b64encode(path.read_bytes()).decode()
    return f"data:image/{mime};base64,{b64}"


def render_html(lesson_json: dict, textbook_image_url: str | None = None) -> str:
    env = Environment(
        loader=FileSystemLoader(HERE),
        autoescape=select_autoescape(["html"]),
        variable_start_string="{{",
        variable_end_string="}}",
    )
    template = env.get_template(TEMPLATE_NAME)
    return template.render(
        **lesson_json,
        textbook_image_url=textbook_image_url,
    )


async def html_to_pdf(html: str, pdf_path: Path) -> None:
    # HTML을 임시 파일로 쓰고 file:// 로 로드 (외부 CDN 폰트 로드를 위해)
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path, required=True, help="analyze.py의 JSON 출력")
    parser.add_argument("--textbook-image", type=Path, help="1페이지에 넣을 교과서 이미지")
    parser.add_argument("--out", type=Path, default=Path("lesson.pdf"))
    parser.add_argument("--keep-html", action="store_true", help="중간 HTML도 남김")
    args = parser.parse_args()

    lesson = json.loads(args.json.read_text("utf-8"))

    textbook_url = None
    if args.textbook_image and args.textbook_image.exists():
        textbook_url = image_to_data_url(args.textbook_image)

    html = render_html(lesson, textbook_image_url=textbook_url)
    asyncio.run(html_to_pdf(html, args.out))

    if not args.keep_html:
        tmp = args.out.with_suffix(".rendered.html")
        if tmp.exists():
            tmp.unlink()

    print(f"✓ PDF 저장: {args.out}")


if __name__ == "__main__":
    main()
