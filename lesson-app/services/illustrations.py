"""
도입부에 들어가는 상황 일러스트 SVG 프리셋.

Claude는 차시 주제에 맞는 illustration_key를 선택하고,
pipeline에서 해당 SVG를 가져와 템플릿에 주입함.

디자인 원칙: 
- 편집 디자인 톤 (교과서·잡지 일러스트 스타일)
- 단색 외곽선 + 소수 액센트 컬러 (2~3색)
- 학습지 좌상단에 ~120x120px로 들어가도 깔끔
- 모든 아이콘 viewBox="0 0 120 120" 통일
"""

ILLUSTRATIONS = {
    # 인구·도시·지역 (사회)
    "city_people": {
        "title": "도시와 사람들",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="20" y="35" width="18" height="55" fill="#FEF3C7" stroke="#0F766E" stroke-width="2"/>
<rect x="42" y="25" width="22" height="65" fill="#D1FAE5" stroke="#0F766E" stroke-width="2"/>
<rect x="68" y="45" width="20" height="45" fill="#FECACA" stroke="#0F766E" stroke-width="2"/>
<rect x="92" y="30" width="14" height="60" fill="#DBEAFE" stroke="#0F766E" stroke-width="2"/>
<rect x="25" y="45" width="3" height="3" fill="#0F766E"/>
<rect x="32" y="45" width="3" height="3" fill="#0F766E"/>
<rect x="25" y="55" width="3" height="3" fill="#0F766E"/>
<rect x="32" y="55" width="3" height="3" fill="#0F766E"/>
<rect x="48" y="35" width="3" height="3" fill="#0F766E"/>
<rect x="55" y="35" width="3" height="3" fill="#0F766E"/>
<rect x="48" y="50" width="3" height="3" fill="#0F766E"/>
<rect x="55" y="50" width="3" height="3" fill="#0F766E"/>
<rect x="74" y="55" width="3" height="3" fill="#0F766E"/>
<rect x="81" y="55" width="3" height="3" fill="#0F766E"/>
<circle cx="35" cy="100" r="4" fill="#0F766E"/>
<circle cx="55" cy="100" r="4" fill="#F59E0B"/>
<circle cx="75" cy="100" r="4" fill="#0F766E"/>
<line x1="10" y1="90" x2="115" y2="90" stroke="#334155" stroke-width="2"/>
</svg>"""
    },
    
    "map_region": {
        "title": "지도와 지역",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M30 20 Q50 15 70 25 Q90 30 95 55 Q98 80 80 95 Q60 105 40 95 Q20 85 22 60 Q25 30 30 20 Z" 
  fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
<circle cx="45" cy="40" r="3" fill="#DC2626"/>
<circle cx="70" cy="55" r="3" fill="#DC2626"/>
<circle cx="55" cy="75" r="3" fill="#DC2626"/>
<path d="M45 40 L70 55 L55 75" stroke="#DC2626" stroke-width="1.5" stroke-dasharray="2,2"/>
<text x="48" y="32" font-family="sans-serif" font-size="7" fill="#0F766E" font-weight="bold">A</text>
<text x="73" y="48" font-family="sans-serif" font-size="7" fill="#0F766E" font-weight="bold">B</text>
<text x="58" y="88" font-family="sans-serif" font-size="7" fill="#0F766E" font-weight="bold">C</text>
</svg>"""
    },
    
    "people_diverse": {
        "title": "다양한 사람들",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="30" cy="45" r="12" fill="#FEF3C7" stroke="#0F766E" stroke-width="2"/>
<path d="M18 85 Q18 65 30 65 Q42 65 42 85" fill="#D1FAE5" stroke="#0F766E" stroke-width="2"/>
<circle cx="60" cy="42" r="13" fill="#FECACA" stroke="#0F766E" stroke-width="2"/>
<path d="M46 85 Q46 63 60 63 Q74 63 74 85" fill="#FEF3C7" stroke="#0F766E" stroke-width="2"/>
<circle cx="90" cy="46" r="11" fill="#DBEAFE" stroke="#0F766E" stroke-width="2"/>
<path d="M79 85 Q79 66 90 66 Q101 66 101 85" fill="#FECACA" stroke="#0F766E" stroke-width="2"/>
<circle cx="27" cy="43" r="1.5" fill="#0F766E"/><circle cx="33" cy="43" r="1.5" fill="#0F766E"/>
<circle cx="57" cy="40" r="1.5" fill="#0F766E"/><circle cx="63" cy="40" r="1.5" fill="#0F766E"/>
<circle cx="87" cy="44" r="1.5" fill="#0F766E"/><circle cx="93" cy="44" r="1.5" fill="#0F766E"/>
<path d="M27 50 Q30 52 33 50" stroke="#0F766E" stroke-width="1.5" fill="none"/>
<path d="M57 47 Q60 49 63 47" stroke="#0F766E" stroke-width="1.5" fill="none"/>
<path d="M87 51 Q90 53 93 51" stroke="#0F766E" stroke-width="1.5" fill="none"/>
</svg>"""
    },
    
    # 자연·환경
    "nature_tree": {
        "title": "나무와 자연",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="60" cy="50" r="35" fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
<circle cx="45" cy="42" r="12" fill="#A7F3D0" stroke="#0F766E" stroke-width="1.5"/>
<circle cx="75" cy="45" r="14" fill="#A7F3D0" stroke="#0F766E" stroke-width="1.5"/>
<circle cx="60" cy="30" r="10" fill="#A7F3D0" stroke="#0F766E" stroke-width="1.5"/>
<rect x="55" y="80" width="10" height="25" fill="#92400E" stroke="#451A03" stroke-width="2"/>
<line x1="15" y1="105" x2="105" y2="105" stroke="#0F766E" stroke-width="2"/>
<circle cx="30" cy="103" r="2" fill="#F59E0B"/>
<circle cx="90" cy="103" r="2" fill="#F59E0B"/>
</svg>"""
    },
    
    "water_cycle": {
        "title": "물과 순환",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M30 30 Q30 20 40 20 Q50 20 50 30 Q60 25 70 35 Q80 35 80 45 Q75 55 60 52 Q45 55 30 45 Q25 40 30 30 Z" 
  fill="#DBEAFE" stroke="#0F766E" stroke-width="2"/>
<line x1="40" y1="60" x2="40" y2="72" stroke="#3B82F6" stroke-width="2"/>
<line x1="55" y1="62" x2="55" y2="74" stroke="#3B82F6" stroke-width="2"/>
<line x1="70" y1="60" x2="70" y2="72" stroke="#3B82F6" stroke-width="2"/>
<path d="M15 95 Q30 85 60 88 Q90 90 105 95 L105 110 L15 110 Z" 
  fill="#BFDBFE" stroke="#0F766E" stroke-width="2"/>
<path d="M25 95 Q35 92 45 95" stroke="#3B82F6" stroke-width="1.5" fill="none"/>
<path d="M60 98 Q70 95 80 98" stroke="#3B82F6" stroke-width="1.5" fill="none"/>
<path d="M85 82 Q90 75 90 68" stroke="#F59E0B" stroke-width="2" fill="none" marker-end="url(#arrow1)"/>
<defs><marker id="arrow1" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto">
<path d="M0 0 L10 5 L0 10 Z" fill="#F59E0B"/></marker></defs>
</svg>"""
    },
    
    # 소통·토론 (사회·국어)
    "discussion_talk": {
        "title": "대화와 토론",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M15 30 Q15 20 25 20 L55 20 Q65 20 65 30 L65 55 Q65 65 55 65 L40 65 L30 75 L32 65 L25 65 Q15 65 15 55 Z" 
  fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<circle cx="30" cy="42" r="2" fill="#0F766E"/>
<circle cx="40" cy="42" r="2" fill="#0F766E"/>
<circle cx="50" cy="42" r="2" fill="#0F766E"/>
<path d="M55 55 Q55 45 65 45 L95 45 Q105 45 105 55 L105 80 Q105 90 95 90 L85 90 L75 100 L77 90 L65 90 Q55 90 55 80 Z" 
  fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
<line x1="65" y1="60" x2="95" y2="60" stroke="#0F766E" stroke-width="1.5"/>
<line x1="65" y1="70" x2="90" y2="70" stroke="#0F766E" stroke-width="1.5"/>
<line x1="65" y1="80" x2="85" y2="80" stroke="#0F766E" stroke-width="1.5"/>
</svg>"""
    },
    
    "question_think": {
        "title": "질문과 생각",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="60" cy="55" r="32" fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<path d="M50 40 Q50 32 60 32 Q70 32 70 42 Q70 50 60 52 L60 62" 
  stroke="#0F766E" stroke-width="4" fill="none" stroke-linecap="round"/>
<circle cx="60" cy="72" r="3" fill="#0F766E"/>
<circle cx="25" cy="30" r="4" fill="#F59E0B" opacity="0.6"/>
<circle cx="95" cy="35" r="3" fill="#F59E0B" opacity="0.6"/>
<circle cx="20" cy="80" r="3" fill="#F59E0B" opacity="0.6"/>
<circle cx="100" cy="85" r="4" fill="#F59E0B" opacity="0.6"/>
<path d="M30 100 Q60 95 90 100" stroke="#0F766E" stroke-width="2" fill="none"/>
</svg>"""
    },
    
    # 과학·실험
    "science_lab": {
        "title": "과학 실험",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M45 25 L45 50 L30 90 Q28 98 38 98 L82 98 Q92 98 90 90 L75 50 L75 25" 
  fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
<line x1="40" y1="25" x2="80" y2="25" stroke="#0F766E" stroke-width="3" stroke-linecap="round"/>
<path d="M35 75 Q60 70 85 75 L82 88 Q60 85 38 88 Z" fill="#3B82F6" opacity="0.4"/>
<circle cx="45" cy="82" r="2" fill="#3B82F6"/>
<circle cx="60" cy="78" r="2.5" fill="#3B82F6"/>
<circle cx="75" cy="85" r="2" fill="#3B82F6"/>
<circle cx="55" cy="88" r="1.5" fill="#3B82F6"/>
<path d="M50 20 Q50 10 55 10" stroke="#F59E0B" stroke-width="2" fill="none"/>
<circle cx="55" cy="10" r="2" fill="#F59E0B"/>
</svg>"""
    },
    
    "observation": {
        "title": "관찰과 발견",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="48" cy="48" r="28" fill="none" stroke="#0F766E" stroke-width="3"/>
<circle cx="48" cy="48" r="22" fill="#DBEAFE" opacity="0.5" stroke="#0F766E" stroke-width="1"/>
<line x1="68" y1="68" x2="92" y2="92" stroke="#0F766E" stroke-width="5" stroke-linecap="round"/>
<line x1="68" y1="68" x2="92" y2="92" stroke="#92400E" stroke-width="3" stroke-linecap="round"/>
<path d="M35 45 Q42 38 48 45" stroke="#F59E0B" stroke-width="2" fill="none"/>
<circle cx="45" cy="50" r="2" fill="#0F766E"/>
<circle cx="55" cy="50" r="2" fill="#0F766E"/>
<path d="M38 58 Q45 55 50 58" stroke="#0F766E" stroke-width="1.5" fill="none"/>
</svg>"""
    },
    
    # 숫자·계산 (수학)
    "math_numbers": {
        "title": "숫자와 계산",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="20" y="25" width="80" height="70" rx="6" fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<text x="30" y="55" font-family="sans-serif" font-size="20" fill="#0F766E" font-weight="bold">1</text>
<text x="45" y="55" font-family="sans-serif" font-size="20" fill="#DC2626" font-weight="bold">+</text>
<text x="60" y="55" font-family="sans-serif" font-size="20" fill="#0F766E" font-weight="bold">2</text>
<text x="75" y="55" font-family="sans-serif" font-size="20" fill="#DC2626" font-weight="bold">=</text>
<text x="87" y="55" font-family="sans-serif" font-size="20" fill="#F59E0B" font-weight="bold">?</text>
<line x1="28" y1="72" x2="92" y2="72" stroke="#0F766E" stroke-width="1.5"/>
<text x="30" y="85" font-family="sans-serif" font-size="11" fill="#64748B">3 × 4 =</text>
<text x="72" y="85" font-family="sans-serif" font-size="11" fill="#64748B">9 - 5 =</text>
</svg>"""
    },
    
    "shape_geometry": {
        "title": "도형과 공간",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<circle cx="35" cy="40" r="18" fill="#FECACA" stroke="#0F766E" stroke-width="2.5"/>
<rect x="62" y="22" width="36" height="36" fill="#DBEAFE" stroke="#0F766E" stroke-width="2.5"/>
<polygon points="35,70 22,98 48,98" fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<polygon points="80,70 95,80 90,100 70,100 65,80" fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
</svg>"""
    },
    
    # 시간·역사
    "history_past": {
        "title": "과거와 역사",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="35" y="25" width="50" height="75" rx="4" fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<rect x="35" y="25" width="50" height="15" fill="#92400E"/>
<text x="60" y="36" text-anchor="middle" font-family="serif" font-size="8" fill="#FEF3C7" font-weight="bold">歷史</text>
<line x1="42" y1="52" x2="78" y2="52" stroke="#0F766E" stroke-width="1.5"/>
<line x1="42" y1="62" x2="78" y2="62" stroke="#0F766E" stroke-width="1.5"/>
<line x1="42" y1="72" x2="70" y2="72" stroke="#0F766E" stroke-width="1.5"/>
<line x1="42" y1="82" x2="78" y2="82" stroke="#0F766E" stroke-width="1.5"/>
<circle cx="95" cy="95" r="12" fill="#F59E0B" opacity="0.3" stroke="#F59E0B" stroke-width="2"/>
<line x1="95" y1="87" x2="95" y2="95" stroke="#92400E" stroke-width="2" stroke-linecap="round"/>
<line x1="95" y1="95" x2="101" y2="95" stroke="#92400E" stroke-width="2" stroke-linecap="round"/>
</svg>"""
    },
    
    # 생활·윤리
    "daily_life": {
        "title": "일상과 생활",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M20 55 L60 25 L100 55 L100 100 L20 100 Z" 
  fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<rect x="45" y="70" width="30" height="30" fill="#92400E" stroke="#451A03" stroke-width="2"/>
<circle cx="68" cy="85" r="1.5" fill="#F59E0B"/>
<rect x="30" y="65" width="10" height="12" fill="#DBEAFE" stroke="#0F766E" stroke-width="1.5"/>
<rect x="80" y="65" width="10" height="12" fill="#DBEAFE" stroke="#0F766E" stroke-width="1.5"/>
<path d="M55 25 L55 15 L62 15 L62 22" stroke="#0F766E" stroke-width="2" fill="none"/>
<path d="M25 95 Q60 90 95 95" stroke="#0F766E" stroke-width="1" fill="none" opacity="0.5"/>
</svg>"""
    },
    
    "vote_democracy": {
        "title": "투표와 민주주의",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="25" y="45" width="70" height="55" rx="3" fill="#D1FAE5" stroke="#0F766E" stroke-width="2.5"/>
<rect x="50" y="38" width="20" height="10" fill="#0F766E"/>
<rect x="55" y="28" width="10" height="10" fill="#0F766E"/>
<rect x="30" y="60" width="60" height="3" fill="#0F766E"/>
<text x="60" y="80" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#0F766E" font-weight="bold">VOTE</text>
<path d="M50 88 L56 94 L70 80" stroke="#F59E0B" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>"""
    },
    
    # 책·언어 (국어)
    "reading_book": {
        "title": "책과 읽기",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M15 30 Q60 20 105 30 L105 95 Q60 85 15 95 Z" 
  fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<line x1="60" y1="25" x2="60" y2="90" stroke="#0F766E" stroke-width="2"/>
<line x1="22" y1="40" x2="54" y2="37" stroke="#64748B" stroke-width="1"/>
<line x1="22" y1="48" x2="54" y2="45" stroke="#64748B" stroke-width="1"/>
<line x1="22" y1="56" x2="50" y2="53" stroke="#64748B" stroke-width="1"/>
<line x1="22" y1="64" x2="54" y2="61" stroke="#64748B" stroke-width="1"/>
<line x1="22" y1="72" x2="48" y2="69" stroke="#64748B" stroke-width="1"/>
<line x1="66" y1="37" x2="98" y2="40" stroke="#64748B" stroke-width="1"/>
<line x1="66" y1="45" x2="98" y2="48" stroke="#64748B" stroke-width="1"/>
<line x1="66" y1="53" x2="94" y2="56" stroke="#64748B" stroke-width="1"/>
<line x1="66" y1="61" x2="98" y2="64" stroke="#64748B" stroke-width="1"/>
<line x1="66" y1="69" x2="92" y2="72" stroke="#64748B" stroke-width="1"/>
</svg>"""
    },
    
    # 기본 (매칭 안 될 때)
    "default": {
        "title": "학습 시작",
        "svg": """<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="25" y="35" width="70" height="55" rx="4" fill="#FEF3C7" stroke="#0F766E" stroke-width="2.5"/>
<line x1="35" y1="50" x2="85" y2="50" stroke="#0F766E" stroke-width="1.5"/>
<line x1="35" y1="60" x2="75" y2="60" stroke="#0F766E" stroke-width="1.5"/>
<line x1="35" y1="70" x2="85" y2="70" stroke="#0F766E" stroke-width="1.5"/>
<line x1="35" y1="80" x2="65" y2="80" stroke="#0F766E" stroke-width="1.5"/>
<circle cx="95" cy="30" r="12" fill="#F59E0B"/>
<path d="M89 30 L93 34 L101 26" stroke="#FEF3C7" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>"""
    },
}

def get_illustration(key: str) -> dict:
    """주어진 key로 SVG 가져오기. 못 찾으면 default."""
    return ILLUSTRATIONS.get(key, ILLUSTRATIONS["default"])

def list_keys_with_titles() -> str:
    """프롬프트에 넣을 키-제목 목록."""
    lines = []
    for k, v in ILLUSTRATIONS.items():
        if k == "default":
            continue
        lines.append(f'- "{k}": {v["title"]}')
    return "\n".join(lines)