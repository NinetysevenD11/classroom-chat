"""
PDF 페이지를 썸네일 이미지로 변환.

썸네일은 base64 data URL로 만들어서 HTML에 바로 박을 수 있게 한다.
- 업로드 직후 한 번만 렌더링
- 세션 상태에 들고 있다가 UI에서 <img src=...> 로 표시
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF

from state import PageInfo

THUMBNAIL_DPI = 80  # 썸네일용, 속도·메모리 절충값 (200p 교과서도 10초 내)
FULL_DPI = 120      # 나중에 LLM에 넘길 때는 이 해상도로 재렌더


def pdf_to_thumbnails(pdf_bytes: bytes) -> list[PageInfo]:
    """업로드된 PDF 바이트 → PageInfo 리스트."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages: list[PageInfo] = []
    for i in range(len(doc)):
        pix = doc.load_page(i).get_pixmap(dpi=THUMBNAIL_DPI)
        png_bytes = pix.tobytes("png")
        b64 = base64.b64encode(png_bytes).decode()
        pages.append(
            PageInfo(
                index=i,
                page_number=i + 1,
                thumbnail_b64=f"data:image/png;base64,{b64}",
            )
        )
    doc.close()
    return pages


def pdf_page_to_b64(pdf_bytes: bytes, page_index: int, dpi: int = FULL_DPI) -> str:
    """특정 페이지를 고해상도 base64 PNG로. (LLM 전달용)"""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pix = doc.load_page(page_index).get_pixmap(dpi=dpi)
    b64 = base64.b64encode(pix.tobytes("png")).decode()
    doc.close()
    return b64


def pdf_to_text(pdf_bytes: bytes) -> str:
    """교육과정 PDF → 전체 텍스트(블록 정렬로 읽기 순서 개선)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    chunks: list[str] = []
    try:
        for i in range(len(doc)):
            page = doc.load_page(i)
            try:
                chunks.append(page.get_text("text", sort=True) or "")
            except TypeError:
                chunks.append(page.get_text("text") or "")
    finally:
        doc.close()
    return "\n\n".join(chunks)


def pdf_page_count(path: Path) -> int:
    """로컬 PDF 파일의 페이지 수."""
    doc = fitz.open(path)
    try:
        return len(doc)
    finally:
        doc.close()


def merge_pdf_pages_from_pick_list(picks: list[tuple[Path, int]], out_path: Path) -> None:
    """
    picks: (원본 PDF 절대경로, 0부터 페이지 인덱스) 를 **이 순서대로** 이어 붙인 단일 PDF 저장.
    """
    if not picks:
        raise ValueError("picks 비어 있음")
    merged = fitz.open()
    try:
        for src, pidx in picks:
            if not src.is_file():
                continue
            doc = fitz.open(src)
            try:
                if 0 <= pidx < len(doc):
                    merged.insert_pdf(doc, from_page=pidx, to_page=pidx)
            finally:
                doc.close()
        if len(merged) == 0:
            raise ValueError("병합된 페이지가 없습니다.")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        merged.save(str(out_path))
    finally:
        merged.close()
