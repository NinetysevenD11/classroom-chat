"""
v14.1 Tool Use 스키마.
pipeline.py가 기대하는 모든 필드(thinking_*, meta, ...)를 포함.
"""

UNDERSTAND_TOOL = {
    "name": "analyze_lesson_overview",
    "description": "교과서와 교육과정을 분석하여 차시 개요를 추출합니다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "thinking_summary": {
                "type": "string",
                "description": "교과서 분석 과정의 한 줄 요약 (UI에 표시됨)"
            },
            "thinking_curriculum": {
                "type": "string",
                "description": "교육과정 매칭 과정의 한 줄 요약 (UI에 표시됨)"
            },
            "meta": {
                "type": "object",
                "description": "차시 메타 정보",
                "properties": {
                    "subject": {"type": "string", "description": "과목명"},
                    "lesson_number": {"type": "integer"},
                    "total_lessons": {"type": "integer"},
                    "textbook_page": {"type": "string", "description": "교과서 쪽수 범위"}
                }
            },
            "achievement_standard": {
                "type": "object",
                "description": "성취기준",
                "properties": {
                    "code": {"type": "string", "description": "성취기준 코드 (예: [6사03-01])"},
                    "description": {"type": "string", "description": "성취기준 본문"}
                }
            },
            "content_elements": {
                "type": "array",
                "items": {"type": "string"},
                "description": "내용 요소 키워드"
            },
            "learning_goal": {
                "type": "string",
                "description": "차시 학습 목표 ('~할 수 있다'로 끝나는 한 문장)"
            },
            "main_topic": {
                "type": "string",
                "description": "차시 핵심 주제"
            },
            "textbook_materials": {
                "type": "array",
                "items": {"type": "string"},
                "description": "교과서에서 확인한 자료 종류 (그래프·지도·사진 등)"
            },
            "illustration_key": {
                "type": "string",
                "enum": [
                    "city_people", "map_region", "people_diverse", "nature_tree",
                    "water_cycle", "discussion_talk", "question_think", "science_lab",
                    "observation", "math_numbers", "shape_geometry", "history_past",
                    "daily_life", "vote_democracy", "reading_book"
                ],
                "description": (
                    "도입부에 넣을 SVG 일러스트의 key. 주제와 가장 맞는 것 선택.\n"
                    "- city_people: 도시·인구·주거\n"
                    "- map_region: 지도·지역·영토\n"
                    "- people_diverse: 다양한 사람들·공동체\n"
                    "- nature_tree: 식물·생태·환경\n"
                    "- water_cycle: 물·날씨·순환\n"
                    "- discussion_talk: 토론·의사소통\n"
                    "- question_think: 탐구·질문·사고 (범용)\n"
                    "- science_lab: 과학 실험\n"
                    "- observation: 관찰·탐색\n"
                    "- math_numbers: 수·연산\n"
                    "- shape_geometry: 도형·공간·측정\n"
                    "- history_past: 역사·과거·유물\n"
                    "- daily_life: 일상·의식주\n"
                    "- vote_democracy: 투표·민주주의\n"
                    "- reading_book: 읽기·문학\n"
                    "애매하면 question_think."
                )
            }
        },
        "required": [
            "thinking_summary", "thinking_curriculum",
            "meta", "learning_goal",
            "textbook_materials", "illustration_key"
        ]
    }
}


DESIGN_TOOL = {
    "name": "design_lesson",
    "description": "차시 개요를 바탕으로 학습지 활동을 설계합니다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "thinking_activities": {
                "type": "string",
                "description": "왜 이런 블록들로 구성했는지 설계 근거 한 줄"
            },
            "thinking_review": {
                "type": "string",
                "description": "학생 수준과 적합성 검토 요약 한 줄"
            },
            "worksheet_title": {
                "type": "string",
                "description": "학습지 상단 제목"
            },
            "hook_question": {
                "type": "string",
                "description": (
                    "도입부 상단에 크게 들어갈 '후킹 질문' 한 문장. "
                    "학생 호기심을 자극하는 의문형. "
                    "예: '같은 나라인데 왜 서울과 강원도는 이렇게 다를까?'"
                )
            },
            "blocks": {
                "type": "array",
                "description": (
                    "도입→전개→정리 흐름의 활동 모듈 리스트.\n"
                    "도입 2~4블록, 전개 2~4블록, 정리 정확히 2블록.\n"
                    "배열의 모든 문자열은 빈 값이면 안 됨."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "phase": {
                            "type": "string",
                            "enum": ["intro", "develop", "wrap"],
                            "description": "수업 단계"
                        },
                        "block_type": {
                            "type": "string",
                            "enum": [
                                "concept", "ox_quiz", "short_answer", "drawing",
                                "discussion", "wrap_up",
                                "comparison_table", "matching",
                                "sequence_ordering", "data_interpretation"
                            ],
                            "description": (
                                "활동 유형. 답란은 시스템이 자동 생성하므로 content에 빈칸 그리지 말 것."
                            )
                        },
                        "title": {
                            "type": "string",
                            "description": "활동 소제목"
                        },
                        "content": {
                            "type": "string",
                            "description": (
                                "활동 지시문. 언더스코어(_) 사용 금지. "
                                "답란은 block_type에 따라 자동 생성됨."
                            )
                        },
                        "keywords": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "[wrap_up 전용] 학생이 요약문에 사용할 핵심 키워드 3~6개. "
                                "본문 content에 나열하지 말고 이 필드에만 넣을 것. "
                                "모든 항목은 비어있지 않은 문자열."
                            )
                        },
                        "table_headers": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[comparison_table 전용] 표 열 헤더. 첫 열은 '비교 기준'."
                        },
                        "table_rows": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[comparison_table 전용] 비교 기준 행 이름. 빈 값 금지."
                        },
                        "matching_left": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[matching 전용] 좌측 항목 (보통 개념·용어). 빈 값 금지."
                        },
                        "matching_right": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[matching 전용] 우측 항목 (보통 정의·예시). matching_left와 개수 동일."
                        },
                        "sequence_items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[sequence_ordering 전용] 섞인 순서로 제시되는 항목 4~6개."
                        },
                        "data_text": {
                            "type": "string",
                            "description": "[data_interpretation 전용] 제시되는 자료 본문. 구체적 수치·사례 포함."
                        },
                        "data_questions": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "[data_interpretation 전용] 자료 해석 질문 정확히 3개(1~2 해석, 3 확장/추론)."
                        }
                    },
                    "required": ["phase", "block_type", "title", "content"]
                }
            }
        },
        "required": [
            "thinking_activities", "thinking_review",
            "worksheet_title", "hook_question", "blocks"
        ]
    }
}
