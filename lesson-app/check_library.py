"""
라이브러리 폴더 진단 스크립트 v3
- 출판사 레벨 추가 (학년 → 과목 → 출판사 → 단원)
- _curriculum 폴더 별도 검사
- macOS NFC 정규화 대응
사용법: lesson-app 폴더에서 `python check_library.py`
"""
import re
import unicodedata as ud
from pathlib import Path

GRADE_RE = re.compile(r"^(\d+)학년$")
UNIT_RE = re.compile(r"^(\d+)단원(?:[_\s](.+))?$")
PDF_ALIASES = {"교과서", "지도서", "교육과정"}
CURRICULUM_DIR = "_curriculum"
BAND_RE = re.compile(r"^(\d+-\d+)학년군$")

def norm(s: str) -> str:
    return ud.normalize("NFC", s)

BASE = Path(__file__).parent
ASSETS = BASE / "assets"

print(f"\n📂 검사 대상: {ASSETS.resolve()}")
print("=" * 70)

if not ASSETS.exists():
    print(f"❌ assets 폴더가 없음.")
    raise SystemExit(1)

# ─── 1. assets 최상위 항목 ───────────────────────────────
top_items = sorted(list(ASSETS.iterdir()))
print(f"\n[1] assets 폴더 안의 모든 항목: {len(top_items)}개")

valid_grades = []
curriculum_dir = None
for item in top_items:
    name = norm(item.name)
    if not item.is_dir():
        if name == ".DS_Store":
            continue
        print(f"    ⏭️  파일이라 무시: {name}")
        continue
    if name == CURRICULUM_DIR:
        curriculum_dir = item
        print(f"    📚 '{name}' → 교육과정 전용 폴더 인식")
        continue
    m = GRADE_RE.match(name)
    if m:
        print(f"    ✅ '{name}' → {m.group(1)}학년 인식")
        valid_grades.append((item, name, int(m.group(1))))
    else:
        print(f"    ❌ '{name}' → 학년 폴더 아님 (무시됨)")
        if "학년" not in name:
            print(f"       💡 '학년' 글자가 빠짐")

if not valid_grades:
    print("\n❌ 학년 폴더가 0개. assets/N학년 형식으로 만들어주세요.")
    raise SystemExit(0)

# ─── 2. 학년 → 과목 → 출판사 → 단원 ───────────────────────
total_units = 0
ok_units = 0

for grade_dir, grade_label, grade_no in valid_grades:
    print(f"\n[2] {grade_label} 안 검사")
    subjects = sorted([s for s in grade_dir.iterdir() if s.is_dir()])
    if not subjects:
        print(f"    ⚠️  과목 폴더가 없음. 예: '국어', '수학', '사회'")
        continue
    for sub in subjects:
        sub_name = norm(sub.name)
        print(f"    📁 {sub_name} (과목)")
        publishers = sorted([p for p in sub.iterdir() if p.is_dir()])
        if not publishers:
            print(f"        ⚠️  출판사 폴더가 없음. 예: '비상교육', '미래엔'")
            print(f"           ※ 새 구조는 학년/과목/출판사/단원/ 4단계 깊이 필요")
            continue
        for pub in publishers:
            pub_name = norm(pub.name)
            print(f"        📁 {pub_name} (출판사)")
            units = sorted([u for u in pub.iterdir() if u.is_dir()])
            if not units:
                print(f"            ⚠️  단원 폴더가 없음. 예: '1단원_신나는 글쓰기'")
                continue
            for unit in units:
                unit_name = norm(unit.name)
                um = UNIT_RE.match(unit_name)
                if not um:
                    print(f"            ❌ '{unit_name}' → 단원 형식 아님")
                    if "단원" not in unit_name:
                        print(f"               💡 '단원' 글자 누락. 예: '1단원' 또는 '1단원_분수의 나눗셈'")
                    else:
                        print(f"               💡 '숫자단원' 또는 '숫자단원_단원명' 형식 필요")
                    continue
                unit_no_str = um.group(1)
                unit_subname = (um.group(2) or "").strip()
                display = f"{unit_no_str}단원 · {unit_subname}" if unit_subname else f"{unit_no_str}단원"
                pdfs = list(unit.glob("*.pdf"))
                file_status = []
                has_textbook = False
                for pdf in pdfs:
                    stem = norm(pdf.stem.strip())
                    if stem in PDF_ALIASES:
                        file_status.append(f"✅{stem}")
                        if stem == "교과서":
                            has_textbook = True
                    else:
                        file_status.append(f"❌{stem}(인식안됨)")
                mark = "✅" if has_textbook else "⚠️"
                desc = " " if has_textbook else " (교과서 PDF 없음)"
                print(f"            {mark} {display}{desc}  ({unit_name}/)")
                if file_status:
                    print(f"                파일: {', '.join(file_status)}")
                else:
                    print(f"                ⚠️  PDF가 0개")
                total_units += 1
                if has_textbook:
                    ok_units += 1

# ─── 3. 교육과정 폴더 검사 ───────────────────────────────
print(f"\n[3] 교육과정 폴더 검사")
if not curriculum_dir:
    print(f"    ⚠️  assets/_curriculum 폴더가 없음")
    print(f"       💡 학년군별 교육과정 PDF를 자동 매칭하려면 다음 구조로 만드세요:")
    print(f"          assets/_curriculum/5-6학년군/사회.pdf")
    print(f"          assets/_curriculum/3-4학년군/국어.pdf 등")
else:
    bands = sorted([b for b in curriculum_dir.iterdir() if b.is_dir()])
    if not bands:
        print(f"    ⚠️  학년군 폴더가 없음")
    else:
        for band in bands:
            band_name = norm(band.name)
            bm = BAND_RE.match(band_name)
            if bm:
                print(f"    ✅ {band_name}")
            else:
                print(f"    ⚠️  '{band_name}' → 학년군 폴더 형식 아님 (예: '5-6학년군')")
                continue
            pdfs = sorted(band.glob("*.pdf"))
            if not pdfs:
                print(f"        (PDF 없음)")
            for pdf in pdfs:
                stem = norm(pdf.stem.strip())
                print(f"        📄 {stem}.pdf")

# ─── 결과 요약 ───────────────────────────────────────────
print("\n" + "=" * 70)
print(f"📊 인식 가능 단원: {ok_units}개 / 전체 {total_units}개")
if ok_units > 0:
    print("✅ 라이브러리 페이지를 새로고침하면 보입니다.")
else:
    print("❌ 인식 가능한 단원이 0개입니다. 위 메시지를 확인해 주세요.")
print()
print("💡 새 폴더 구조 요약:")
print("   assets/{N}학년/{과목}/{출판사}/{N}단원_{단원명}/{교과서|지도서|교육과정}.pdf")
print("   assets/_curriculum/{N-N}학년군/{과목}.pdf  ← 교육과정 자동 매칭용")