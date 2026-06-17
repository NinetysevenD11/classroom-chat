# 수업 자료 생성기

교과서 PDF와 국가수준 교육과정 PDF를 업로드하면, 차시별로 도입·전개·정리 3페이지 구성의 수업 자료 PDF를 자동으로 만들어주는 웹 앱입니다.

## 기능

- **업로드**: 교과서 PDF + 교육과정 PDF (과목 6개 지원)
- **페이지 그룹화**: PDF 페이지 썸네일을 클릭으로 선택 → 차시 바구니에 배정 (아이패드 터치 대응)
- **자동 생성**: 차시마다 Claude API 호출 → JSON → HTML → PDF 3단계
- **결과 다운로드**: A4 가로 3페이지 PDF, Pretendard 폰트

## 로컬 실행

```bash
# 1. 의존성 설치
pip install -r requirements.txt
playwright install chromium

# 2. 환경변수 설정 (또는 .env 파일)
export ANTHROPIC_API_KEY=sk-ant-...

# 3. 서버 기동
python app.py
# → http://localhost:8080
```

API 키가 없으면 자동으로 **MOCK 모드**로 동작합니다 (샘플 JSON으로 PDF 생성). UI와 렌더링을 먼저 확인해보고 싶을 때 유용합니다.

## Docker 실행

```bash
docker build -t lesson-app .
docker run -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e LESSON_APP_USERS="seyoon:비밀번호1,colleague:비밀번호2" \
  -e STORAGE_SECRET="긴-랜덤-문자열" \
  -v $(pwd)/outputs:/app/outputs \
  lesson-app
```

## Railway 배포 (추천)

같은 학년 선생님 2~3명이 나눠 쓰기 좋은 배포 방법입니다.

1. GitHub에 저장소 push
2. Railway 대시보드 → **New Project** → **Deploy from GitHub**
3. 저장소 선택, Railway가 Dockerfile 자동 감지
4. **Variables** 탭에서 환경변수 설정:
   - `ANTHROPIC_API_KEY` = `sk-ant-...`
   - `LESSON_APP_USERS` = `seyoon:비밀번호1,colleague:비밀번호2`
   - `STORAGE_SECRET` = `긴-랜덤-문자열` (예: `openssl rand -hex 32`)
5. **Volumes** 탭에서 `/app/outputs` 볼륨 추가 (생성된 PDF 영속화)
6. **Settings → Networking → Generate Domain** 으로 공개 URL 획득

**예상 비용**: Railway Hobby $5/월로 충분. 트래픽 적으니 넉넉합니다.

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ⚠️ 선택 | Claude API 키. 없으면 MOCK 모드 |
| `LESSON_APP_USERS` | ⚠️ 선택 | `user:pass,user2:pass2`. 없으면 인증 비활성 (로컬만) |
| `STORAGE_SECRET` | 권장 | NiceGUI 세션 쿠키 서명용 |
| `HOST` | — | 기본 `0.0.0.0` |
| `PORT` | — | 기본 `8080` |

## 프로젝트 구조

```
app.py                    # NiceGUI 4개 화면 (로그인/업로드/그룹화/실행/결과)
state.py                  # 세션 상태 모델 (Session, LessonBucket)
pdf_utils.py              # PDF → 썸네일/이미지/텍스트 변환
pipeline.py               # 파이프라인 오케스트레이터 (MOCK 자동 폴백)
services/
  schema.py               # Claude tool_use JSON 스키마 2종
  prompts.py              # 생성/검토 프롬프트
  analyze.py              # LLM 호출 래퍼
  render.py               # 템플릿 렌더링
  mock_lesson.json        # MOCK 모드용 샘플
templates/
  lesson_template.j2.html # A4 가로 3페이지 Jinja2 템플릿
outputs/                  # 생성된 PDF (런타임)
Dockerfile
requirements.txt
```

## 파이프라인 동작

```
PDF 업로드
  ↓
페이지 썸네일 생성 (PyMuPDF, 80dpi)
  ↓
사용자가 차시 바구니에 배정
  ↓
각 차시마다:
  1. analyze: 교과서 이미지(150dpi) + 교육과정 텍스트 → Claude Sonnet → JSON
     (+ Haiku 검토 → 수정 반영)
  2. render: JSON → Jinja2 → HTML
  3. pdf: Playwright page.pdf() → A4 가로 3페이지 PDF
  ↓
/outputs/{과목}_{hash}/{과목}_N차시.pdf
```

## 디자인 커스터마이즈

`templates/lesson_template.j2.html`의 `:root` CSS 변수를 바꾸면 전체 톤이 한 번에 바뀝니다:

```css
:root {
  --intro: #4F7CAC;     /* 도입 (파랑) */
  --develop: #6B9C7E;   /* 전개 (초록) */
  --wrap: #C89B5E;      /* 정리 (주황) */
  --paper: #FFFFFF;     /* 종이 배경 */
  --bg: #FBF8F3;        /* 카드 배경 */
}
```

## 알려진 제약

- NiceGUI 3.x의 `ui.upload`는 async 핸들러 필요 (`await e.file.read()`)
- 인증은 `app.storage.user` 기반. `app.storage.browser` 또는 `BaseHTTPMiddleware`는 이 앱 구조에서 충돌함
- Playwright Chromium이 메모리 ~500MB 사용 — Railway Hobby 티어에서는 PDF 생성 중 잠깐 피크
- 교과서 PDF는 100MB 이하 권장 (업로드 리밋)
