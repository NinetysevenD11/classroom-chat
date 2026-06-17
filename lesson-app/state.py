from __future__ import annotations
from typing import List, Set, Optional
from uuid import uuid4
from dataclasses import dataclass

# 👇 이 부분이 빠져있었습니다! (페이지 썸네일 정보)
@dataclass
class PageInfo:
    index: int
    page_number: int
    thumbnail_b64: str

class LessonBucket:
    def __init__(self, name: str):
        self.id: str = f"bucket-{uuid4().hex[:8]}"
        self.name: str = name
        self.page_indices: list[int] = []

class Session:
    def __init__(self):
        # 과목
        self.subject: str = "사회"
        
        # 교과서 (필수)
        self.textbook_filename: str | None = None
        self.textbook_bytes: bytes | None = None
        
        # 교육과정 (선택 사항)
        self.curriculum_filename: str | None = None
        self.curriculum_bytes: bytes | None = None
        
        # 지도서 (선택 사항)
        self.guide_filename: str | None = None
        self.guide_bytes: bytes | None = None

        # 평가문항/수업지도안 (선택 사항 — 품질 보조)
        self.assessment_filename: str | None = None
        self.assessment_bytes: bytes | None = None
        self.lesson_plan_filename: str | None = None
        self.lesson_plan_bytes: bytes | None = None

        # 페이지 및 차시 관리
        self.pages: list[PageInfo] = []
        self.buckets: list[LessonBucket] = []
        self.selected_page_indices: set[int] = set()

    def is_ready_for_grouping(self) -> bool:
        # 교과서만 있으면 통과 (교육과정/지도서는 선택)
        return bool(self.textbook_bytes and self.subject)

    def is_ready_to_run(self) -> bool:
        if not self.is_ready_for_grouping():
            return False
        # 페이지가 하나라도 배정된 바구니가 있는지 확인
        return any(len(b.page_indices) > 0 for b in self.buckets)

    def add_bucket(self):
        n = len(self.buckets) + 1
        self.buckets.append(LessonBucket(name=f"{n}차시"))

    def remove_bucket(self, b_id: str):
        self.buckets = [b for b in self.buckets if b.id != b_id]
        # 남은 바구니 이름 재정렬
        for i, b in enumerate(self.buckets):
            b.name = f"{i+1}차시"

    def assign_selected_to(self, b_id: str) -> int:
        target = next((b for b in self.buckets if b.id == b_id), None)
        if not target: return 0
        
        # 기존 바구니에서 선택된 페이지들 제거
        for b in self.buckets:
            b.page_indices = [idx for idx in b.page_indices if idx not in self.selected_page_indices]
        
        # 새 바구니에 추가 및 정렬
        target.page_indices.extend(list(self.selected_page_indices))
        target.page_indices.sort()
        
        count = len(self.selected_page_indices)
        self.selected_page_indices.clear()
        return count

    def toggle_page(self, page_index: int):
        if page_index in self.selected_page_indices:
            self.selected_page_indices.remove(page_index)
        else:
            self.selected_page_indices.add(page_index)

    def bucket_of_page(self, page_index: int) -> LessonBucket | None:
        for b in self.buckets:
            if page_index in b.page_indices:
                return b
        return None