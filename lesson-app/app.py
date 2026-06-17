"""
수업 자료 생성 앱 — 터미널 로그 유지 및 에러 시 강제 이동 방지 완벽 적용
"""

from __future__ import annotations
from dotenv import load_dotenv
load_dotenv()

import asyncio
import math
import os
import time
import datetime
import urllib.parse
import traceback
from collections import Counter
from html import escape
from pathlib import Path
from uuid import uuid4

from nicegui import app, events, ui

from state import Session, LessonBucket
from pdf_utils import merge_pdf_pages_from_pick_list, pdf_page_count, pdf_to_thumbnails
from pipeline import StepProgress, run_pipeline, has_api_key, has_gemini_key
from accounts_store import load_accounts, register_new_user, verify_password, delete_user

# 🚨 과목 리스트
SUBJECTS = ["국어", "수학", "사회", "과학", "영어"]

# ============ 자료 라이브러리 및 출력 폴더 ============
_BASE_DIR = Path(os.path.abspath(__file__)).parent
# 클라우드 등: LESSON_PERSIST_DIR=/data 로 볼륨 마운트 시 assets·outputs·data를 한곳에 유지
_persist = os.environ.get("LESSON_PERSIST_DIR")
if _persist:
    _persist_root = Path(_persist)
    _ASSETS_DIR = _persist_root / "assets"
    _OUTPUTS_DIR = _persist_root / "outputs"
    _ACCOUNTS_PATH = _persist_root / "data" / "accounts.json"
else:
    _ASSETS_DIR = _BASE_DIR / "assets"
    _OUTPUTS_DIR = _BASE_DIR / "outputs"
    _ACCOUNTS_PATH = _BASE_DIR / "data" / "accounts.json"
_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
_OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
_ACCOUNTS_PATH.parent.mkdir(parents=True, exist_ok=True)
# 자료 라이브러리 폴더 구조: assets/{N}학년/{과목}/{N}단원_{단원명}/{교과서|지도서|교육과정}.pdf
# 사용자가 직접 폴더를 만들고 PDF를 넣으면 자동으로 인식됨

app.add_static_files('/outputs', str(_OUTPUTS_DIR))


# =====================================================================
# 단원 작업 이력 — 완료 단원·최근 작업 추적
# outputs/_lesson_history.json에 저장
# 형식: { "<unit_path>": {"last_used": iso8601, "outputs": [pdf_paths], "count": N} }
# =====================================================================
import json as _json
import datetime as _dt

# 최근 작업(단원 이력) — 계정별로 저장
_HISTORY_FILE = _OUTPUTS_DIR / "_lesson_history.json"
# 사용자별 "자료 보관함" — 결과 화면에서 '넣기'를 눌렀을 때만 들어감
_ARCHIVE_FILE = _OUTPUTS_DIR / "_user_archive.json"
# 활동지 PDF가 결과 단계에서 기록될 때마다 한 줄씩 누적 (관리자 통계용)
_GEN_STATS_FILE = _OUTPUTS_DIR / "_worksheet_generation_stats.json"


def _load_history() -> dict[str, dict]:
    """최근 작업 이력 전체를 불러온다.

    저장 형식(v2):
      {"users": {"<username>": {"<unit_path>": {...}}, ...}}

    구형(v1, 전역):
      {"<unit_path>": {...}}
    """
    if not _HISTORY_FILE.exists():
        return {}
    try:
        raw = _json.loads(_HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

    # v2
    if isinstance(raw, dict) and isinstance(raw.get("users"), dict):
        users = raw.get("users") or {}
        return {str(k): (v if isinstance(v, dict) else {}) for k, v in users.items()}

    # v1 (전역) → v2로 감싸서 반환
    if isinstance(raw, dict):
        looks_v1 = any(isinstance(v, dict) and v.get("last_used") for v in raw.values())
        if looks_v1:
            return {"__legacy__": raw}
    return {}


def _save_history(users: dict[str, dict]) -> None:
    try:
        payload = {"users": users}
        _HISTORY_FILE.write_text(_json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[history 저장 실패] {exc}")

def _history_user_key(username: str | None) -> str:
    u = (username or "").strip()
    return u or "__legacy__"

def _history_for_user(username: str | None) -> dict:
    users = _load_history()
    return users.get(_history_user_key(username), {}) if isinstance(users, dict) else {}


def _record_unit_use(unit_path: str, output_pdfs: list[Path] | None = None, username: str | None = None) -> None:
    """단원 사용 기록(계정별). output_pdfs를 주면 결과로 저장."""
    users = _load_history()
    ukey = _history_user_key(username)
    if ukey not in users or not isinstance(users.get(ukey), dict):
        users[ukey] = {}
    history = users[ukey]
    entry = history.get(unit_path, {"outputs": [], "count": 0})
    entry["last_used"] = _dt.datetime.now().isoformat(timespec="seconds")
    entry["count"] = entry.get("count", 0) + 1
    if output_pdfs:
        entry["outputs"] = [str(p) for p in output_pdfs]
        try:
            _append_worksheet_generation_log(unit_path, output_pdfs)
        except Exception as exc:
            print(f"[worksheet stats 로그 실패] {exc}")
    history[unit_path] = entry
    users[ukey] = history
    _save_history(users)


def _get_unit_history(unit_path: str, username: str | None = None) -> dict | None:
    """단원의 이력 정보(계정별). last_used, outputs, count."""
    return _history_for_user(username).get(unit_path)


def _get_recent_units(limit: int = 5, username: str | None = None) -> list[tuple[str, dict]]:
    """최근 사용 단원 목록(계정별, 최신순). 폴더가 사라진 단원은 제외."""
    history = _history_for_user(username)
    items = []
    for unit_path, entry in history.items():
        if Path(unit_path).exists() and entry.get("last_used"):
            items.append((unit_path, entry))
    items.sort(key=lambda x: x[1]["last_used"], reverse=True)
    return items[:limit]


def _delete_unit_history(unit_paths: list[str], username: str | None = None) -> int:
    """최근 작업에서 제거(계정별): history에서 해당 단원 키 삭제."""
    if not unit_paths:
        return 0
    s = {str(x) for x in unit_paths if x}
    if not s:
        return 0
    users = _load_history()
    ukey = _history_user_key(username)
    hist = users.get(ukey, {})
    if not isinstance(hist, dict):
        hist = {}
    before = len(hist)
    for up in list(s):
        hist.pop(up, None)
    users[ukey] = hist
    _save_history(users)
    return max(0, before - len(hist))


def _meta_from_unit_path(unit_path: str) -> dict[str, str]:
    """assets 기준 단원 경로 → 학년/과목/출판사/단원폴더명."""
    try:
        rel = Path(unit_path).resolve().relative_to(_ASSETS_DIR.resolve())
        parts = rel.parts
    except Exception:
        return {"grade": "", "subject": "", "publisher": "", "unit_label": ""}
    grade = parts[0] if len(parts) > 0 else ""
    subject = parts[1] if len(parts) > 1 else ""
    # 구조 지원:
    # - assets/{학년}/{과목}/{단원}/...
    # - assets/{학년}/{과목}/{출판사}/{단원}/...
    # - assets/{학년}/{과목}/{학기}/{출판사}/{단원}/...  (학기 폴더 추가)
    semester = parts[2] if len(parts) > 2 else ""
    if semester in ("1학기", "2학기"):
        publisher = parts[3] if len(parts) > 3 else ""
        unit_label = parts[4] if len(parts) > 4 else ""
    else:
        publisher = parts[2] if len(parts) > 2 else ""
        unit_label = parts[3] if len(parts) > 3 else ""
    return {"grade": grade, "subject": subject, "publisher": publisher, "unit_label": unit_label}


def _lesson_label_from_pdf_stem(stem: str) -> str:
    """{과목}_{차시명} 형태 파일명에서 차시 부분 추출."""
    if "_" not in stem:
        return stem or "—"
    _, tail = stem.rsplit("_", 1)
    return tail or stem


def _load_worksheet_stat_items() -> list[dict]:
    if not _GEN_STATS_FILE.exists():
        return []
    try:
        data = _json.loads(_GEN_STATS_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return [x for x in data["items"] if isinstance(x, dict)]
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
    except Exception:
        pass
    return []


def _save_worksheet_stat_items(items: list[dict]) -> None:
    cap = 8000
    items = items[-cap:]
    _GEN_STATS_FILE.write_text(
        _json.dumps({"items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _append_worksheet_generation_log(unit_path: str, pdfs: list[Path]) -> None:
    if not unit_path or not pdfs:
        return
    meta = _meta_from_unit_path(unit_path)
    ts = _dt.datetime.now().isoformat(timespec="seconds")
    items = _load_worksheet_stat_items()
    user_key = ""
    try:
        user_key = (app.storage.user.get("username") or "").strip()
    except Exception:
        user_key = ""
    for pdf in pdfs:
        try:
            stem = pdf.stem
            lesson = _lesson_label_from_pdf_stem(stem)
            pdf_rel = ""
            try:
                pdf_rel = pdf.resolve().relative_to(_OUTPUTS_DIR.resolve()).as_posix()
            except Exception:
                pdf_rel = pdf.name
            items.append(
                {
                    "ts": ts,
                    "unit_path": str(unit_path),
                    "grade": meta.get("grade") or "",
                    "subject": meta.get("subject") or "",
                    "publisher": meta.get("publisher") or "",
                    "unit_label": meta.get("unit_label") or "",
                    "pdf_name": pdf.name,
                    "lesson": lesson,
                    "user": user_key,
                    "pdf_rel": pdf_rel,
                }
            )
        except Exception:
            continue
    _save_worksheet_stat_items(items)


def _username_for_storage() -> str:
    try:
        return (app.storage.user.get("username") or "").strip()
    except Exception:
        return ""


def _user_worksheet_stat_items(username: str) -> list[dict]:
    if not username:
        return []
    rows = [x for x in _load_worksheet_stat_items() if (x.get("user") or "").strip() == username]
    rows.sort(key=lambda x: x.get("ts") or "", reverse=True)
    return rows


def _load_user_archive() -> dict:
    if not _ARCHIVE_FILE.exists():
        return {}
    try:
        return _json.loads(_ARCHIVE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_user_archive(data: dict) -> None:
    try:
        _ARCHIVE_FILE.write_text(_json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[archive 저장 실패] {exc}")


def _archive_add_pdf_for_user(username: str, pdf_path: Path) -> bool:
    """현재 사용자 보관함에 PDF 추가. 성공 시 True."""
    username = (username or "").strip()
    if not username or not isinstance(pdf_path, Path) or not pdf_path.is_file():
        return False
    try:
        rel = pdf_path.resolve().relative_to(_OUTPUTS_DIR.resolve()).as_posix()
    except Exception:
        return False
    if not rel.lower().endswith(".pdf"):
        return False
    data = _load_user_archive()
    user_list = data.get(username, [])
    if not isinstance(user_list, list):
        user_list = []
    # 최신 우선: 이미 있으면 앞으로 당김
    ts = _dt.datetime.now().isoformat(timespec="seconds")
    user_list = [x for x in user_list if isinstance(x, dict) and (x.get("pdf_rel") or "") != rel]
    user_list.insert(
        0,
        {
            "ts": ts,
            "pdf_rel": rel,
            "pdf_name": pdf_path.name,
        },
    )
    data[username] = user_list[:300]
    _save_user_archive(data)
    return True


def _archive_remove_for_user(username: str, pdf_rels: list[str]) -> int:
    """사용자 보관함에서 항목 삭제(인덱스에서만). 삭제된 개수 반환."""
    username = (username or "").strip()
    if not username or not pdf_rels:
        return 0
    rels = {(r or "").strip() for r in pdf_rels if (r or "").strip()}
    if not rels:
        return 0
    data = _load_user_archive()
    user_list = data.get(username, [])
    if not isinstance(user_list, list):
        return 0
    before = len(user_list)
    user_list = [x for x in user_list if isinstance(x, dict) and (x.get("pdf_rel") or "").strip() not in rels]
    data[username] = user_list
    _save_user_archive(data)
    return max(0, before - len(user_list))


def _user_archive_pdf_entries(username: str, limit: int = 50) -> list[dict]:
    """사용자 보관함: 결과 화면에서 '넣기'를 눌렀던 PDF만."""
    username = (username or "").strip()
    if not username:
        return []
    data = _load_user_archive()
    user_list = data.get(username, [])
    if not isinstance(user_list, list):
        return []
    out: list[dict] = []
    for x in user_list:
        if not isinstance(x, dict):
            continue
        rel = (x.get("pdf_rel") or "").strip()
        if not rel:
            continue
        p = _OUTPUTS_DIR / rel
        if not p.is_file() or p.suffix.lower() != ".pdf":
            continue
        row = dict(x)
        row["_path"] = p
        out.append(row)
        if len(out) >= limit:
            break
    return out


def _worksheet_stats_rows_fallback_from_history() -> list[dict]:
    """구 이력(_lesson_history)의 outputs만으로 통계 행 구성 (로그 도입 이전 데이터용)."""
    rows: list[dict] = []
    for unit_path, entry in _load_history().items():
        meta = _meta_from_unit_path(unit_path)
        ts = entry.get("last_used") or ""
        for pdf_s in entry.get("outputs") or []:
            p = Path(pdf_s)
            if p.suffix.lower() != ".pdf":
                continue
            if not p.exists():
                continue
            rows.append(
                {
                    "ts": ts,
                    "unit_path": str(unit_path),
                    "grade": meta.get("grade") or "",
                    "subject": meta.get("subject") or "",
                    "publisher": meta.get("publisher") or "",
                    "unit_label": meta.get("unit_label") or "",
                    "pdf_name": p.name,
                    "lesson": _lesson_label_from_pdf_stem(p.stem),
                }
            )
    return rows


def _all_worksheet_stat_rows() -> list[dict]:
    logged = _load_worksheet_stat_items()
    if logged:
        return logged
    return _worksheet_stats_rows_fallback_from_history()


def _aggregate_worksheet_stats(items: list[dict]) -> dict[str, list[tuple[str, int]]]:
    g, s, l = Counter(), Counter(), Counter()
    for it in items:
        g[it.get("grade") or "—"] += 1
        s[it.get("subject") or "—"] += 1
        l[it.get("lesson") or "—"] += 1

    def top(cnt: Counter, n: int = 12) -> list[tuple[str, int]]:
        return cnt.most_common(n)

    return {"by_grade": top(g), "by_subject": top(s), "by_lesson": top(l)}


def _admin_bar_chart_html(title: str, pairs: list[tuple[str, int]], bar_color: str) -> str:
    if not pairs:
        return (
            f'<div style="margin-top:14px;"><div style="font-weight:900;font-size:12px;margin-bottom:6px;">{escape(title)}</div>'
            f'<div style="font-size:12px;color:var(--color-ink-muted);">데이터 없음</div></div>'
        )
    mx = max(c for _, c in pairs) or 1
    parts = [
        f'<div style="margin-top:14px;"><div style="font-weight:900;font-size:12px;margin-bottom:8px;">{escape(title)}</div>'
    ]
    for lab, c in pairs:
        w = max(3, int(100 * c / mx))
        elab = escape(str(lab))
        parts.append(
            f'<div style="margin-bottom:10px;">'
            f'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">'
            f'<span style="font-weight:700;color:var(--color-ink);">{elab}</span>'
            f'<span style="font-weight:900;color:var(--color-ink-soft);">{c}</span></div>'
            f'<div style="height:10px;background:var(--bg-muted);border-radius:6px;overflow:hidden;">'
            f'<div style="height:100%;width:{w}%;background:{bar_color};border-radius:6px;"></div>'
            f"</div></div>"
        )
    parts.append("</div>")
    return "".join(parts)


def _mask_rrn_for_admin(s: str) -> str:
    t = (s or "").strip()
    if len(t) >= 8 and "-" in t:
        head, _, tail = t.partition("-")
        if len(head) >= 6:
            return f"{head}-{'*' * min(7, len(tail))}"
    if len(t) >= 6:
        return t[:6] + "-" + "*" * 7
    return t or "—"


def _admin_html_table(title: str, headers: list[str], rows: list[list[str]]) -> str:
    th = "".join(
        f"<th style='padding:8px 10px;border-bottom:1px solid var(--color-line-strong);text-align:left;font-weight:900;font-size:11px;color:var(--color-ink-soft);'>{escape(h)}</th>"
        for h in headers
    )
    if not rows:
        body = f'<tr><td colspan="{max(len(headers), 1)}" style="padding:12px;color:var(--color-ink-muted);font-size:12px;">데이터 없음</td></tr>'
    else:
        body_parts = []
        for r in rows:
            tds = "".join(
                f"<td style='padding:8px 10px;border-bottom:1px solid var(--color-line);font-size:12px;color:var(--color-ink);'>{escape(str(c))}</td>"
                for c in r
            )
            body_parts.append(f"<tr>{tds}</tr>")
        body = "".join(body_parts)
    ttl = f'<div style="font-weight:900;font-size:13px;margin:16px 0 8px;">{escape(title)}</div>' if title else ""
    return (
        f"{ttl}"
        f'<div style="overflow:auto;border:1px solid var(--color-line-strong);border-radius:10px;">'
        f'<table style="width:100%;border-collapse:collapse;">'
        f"<thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>"
    )


def _admin_rank_table_html(title: str, pairs: list[tuple[str, int]], col_label: str) -> str:
    rows = [[str(i), str(lab), str(cnt)] for i, (lab, cnt) in enumerate(pairs, 1)]
    return _admin_html_table(title, ["#", col_label, "PDF 건수"], rows)


def _build_admin_management_dashboard_html() -> str:
    parts: list[str] = [
        '<div style="padding:2px 4px 24px;">'
        "<style>"
        ".admin-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;align-items:start;}"
        ".admin-col{min-width:0;}"
        ".admin-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 14px;}"
        ".admin-kpi{background:var(--bg-surface);border:1px solid var(--color-line-strong);border-radius:12px;"
        "padding:10px 12px;box-shadow:var(--shadow-card);}"
        ".admin-kpi .t{font-size:10px;font-weight:900;color:var(--color-ink-faint);letter-spacing:0.08em;}"
        ".admin-kpi .v{margin-top:6px;font-size:16px;font-weight:900;color:var(--color-ink);}"
        ".admin-kpi .s{margin-top:2px;font-size:11px;font-weight:700;color:var(--color-ink-soft);}"
        "@media (max-width: 1100px){.admin-grid{grid-template-columns:1fr;}.admin-kpis{grid-template-columns:repeat(2,1fr);}}"
        "</style>"
    ]

    accounts = load_accounts(_ACCOUNTS_PATH)
    # 관리자용: 회원 탈퇴(계정 삭제) UI는 대시보드 탭에서 렌더링되므로 여기서는 표만 만든다.
    mrows = []
    for un in sorted(accounts.keys(), key=lambda x: str(x).lower()):
        row = accounts[un]
        mrows.append(
            [
                un,
                str(row.get("name") or ""),
                str(row.get("phone") or ""),
                str(row.get("email") or ""),
                _mask_rrn_for_admin(str(row.get("resident_registration_number") or "")),
            ]
        )
    logged = _load_worksheet_stat_items()
    items = _all_worksheet_stat_rows()
    if not logged and items:
        parts.append(
            '<p style="font-size:12px;color:var(--color-ink-muted);margin:10px 0 4px;line-height:1.5;">'
            "※ 아직 신규 통계 로그가 없어, 기존 단원 이력(<code>_lesson_history.json</code>의 마지막 PDF 목록)으로 집계했습니다. "
            "앞으로는 결과 화면에서 PDF가 저장될 때마다 자동으로 누적됩니다."
            "</p>"
        )

    agg = _aggregate_worksheet_stats(items)
    # KPI (죽은 오른쪽 공간을 먼저 채움)
    total_pdfs = len(items) if isinstance(items, list) else 0
    users = set()
    try:
        for it in items:
            u = (it.get("user") or "").strip()
            if u:
                users.add(u)
    except Exception:
        pass
    parts.append(
        "<div class='admin-kpis'>"
        f"<div class='admin-kpi'><div class='t'>TOTAL PDF</div><div class='v'>{total_pdfs}</div><div class='s'>누적 생성</div></div>"
        f"<div class='admin-kpi'><div class='t'>USERS</div><div class='v'>{len(users) or len(accounts)}</div><div class='s'>활동 사용자</div></div>"
        f"<div class='admin-kpi'><div class='t'>TOP SUBJECT</div><div class='v'>{escape((agg['by_subject'][0][0] if agg['by_subject'] else '—'))}</div><div class='s'>가장 많이 생성</div></div>"
        f"<div class='admin-kpi'><div class='t'>TOP GRADE</div><div class='v'>{escape((agg['by_grade'][0][0] if agg['by_grade'] else '—'))}</div><div class='s'>가장 많이 생성</div></div>"
        "</div>"
    )

    # 2열 레이아웃: 좌(계정/랭킹), 우(그래프)
    left_parts: list[str] = []
    left_parts.append(_admin_html_table("회원가입 계정", ["아이디", "이름", "전화번호", "이메일", "주민등록번호(관리자 마스킹)"], mrows))
    if _ENV_USERS:
        env_rows = [[u, "(LESSON_APP_USERS에 등록됨 · 비밀번호는 표시하지 않음)"] for u in sorted(_ENV_USERS.keys(), key=str.lower)]
        left_parts.append(_admin_html_table("환경변수로 등록된 계정", ["아이디", "비고"], env_rows))
    left_parts.append(_admin_rank_table_html("학년별 · 많이 만들어진 활동지 (PDF 건수)", agg["by_grade"], "학년"))
    left_parts.append(_admin_rank_table_html("과목별 · 많이 만들어진 활동지 (PDF 건수)", agg["by_subject"], "과목"))
    left_parts.append(_admin_rank_table_html("차시별 · 많이 만들어진 활동지 (파일명 기준)", agg["by_lesson"], "차시/파일 접미사"))

    right_parts: list[str] = []
    right_parts.append(_admin_bar_chart_html("학년별 그래프", agg["by_grade"][:10], "var(--color-primary)"))
    right_parts.append(_admin_bar_chart_html("과목별 그래프", agg["by_subject"][:10], "rgba(59,130,246,0.85)"))
    right_parts.append(_admin_bar_chart_html("차시별 그래프", agg["by_lesson"][:10], "rgba(16,185,129,0.85)"))

    parts.append("<div class='admin-grid'>")
    parts.append("<div class='admin-col'>")
    parts.append("".join(left_parts))
    parts.append("</div>")
    parts.append("<div class='admin-col'>")
    parts.append("".join(right_parts))
    parts.append("</div>")
    parts.append("</div>")

    tail = sorted(items, key=lambda x: str(x.get("ts") or ""), reverse=True)[:40]
    log_rows = []
    for it in tail:
        log_rows.append(
            [
                str(it.get("ts") or ""),
                str(it.get("grade") or ""),
                str(it.get("subject") or ""),
                str(it.get("lesson") or ""),
                str(it.get("pdf_name") or ""),
            ]
        )
    parts.append(_admin_html_table("최근 생성 로그 (최대 40건)", ["시각", "학년", "과목", "차시", "파일"], log_rows))
    parts.append("</div>")
    return "".join(parts)


def _admin_collect_storage_refs() -> dict[str, set[str]]:
    """outputs 내 PDF 참조 경로(rel)들을 수집."""
    refs_archive: set[str] = set()
    try:
        data = _load_user_archive()
        for _, items in (data or {}).items():
            if not isinstance(items, list):
                continue
            for it in items:
                if isinstance(it, dict):
                    rel = (it.get("pdf_rel") or "").strip()
                    if rel:
                        refs_archive.add(rel)
    except Exception:
        pass

    refs_stats: set[str] = set()
    try:
        for it in _load_worksheet_stat_items() or []:
            if isinstance(it, dict):
                rel = (it.get("pdf_rel") or "").strip()
                if rel:
                    refs_stats.add(rel)
    except Exception:
        pass

    refs_history_outputs: set[str] = set()
    try:
        users = _load_history()
        for _, hist in (users or {}).items():
            if not isinstance(hist, dict):
                continue
            for _, entry in hist.items():
                if not isinstance(entry, dict):
                    continue
                for p in entry.get("outputs") or []:
                    try:
                        rp = Path(str(p)).resolve().relative_to(_OUTPUTS_DIR.resolve()).as_posix()
                        if rp:
                            refs_history_outputs.add(rp)
                    except Exception:
                        continue
    except Exception:
        pass

    return {
        "archive": refs_archive,
        "stats": refs_stats,
        "history_outputs": refs_history_outputs,
        "any": set().union(refs_archive, refs_stats, refs_history_outputs),
    }


def _admin_list_outputs_pdfs(limit: int = 250) -> list[dict]:
    """outputs 내 PDF 파일 목록(최신순)."""
    rows: list[dict] = []
    try:
        for p in sorted(_OUTPUTS_DIR.glob("*.pdf"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                rel = p.resolve().relative_to(_OUTPUTS_DIR.resolve()).as_posix()
            except Exception:
                rel = p.name
            rows.append(
                {
                    "rel": rel,
                    "name": p.name,
                    "size_kb": int(p.stat().st_size / 1024),
                    "mtime": _dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                }
            )
            if len(rows) >= limit:
                break
    except Exception:
        pass
    return rows


def _admin_clear_user_archive(username: str | None = None) -> int:
    """user_archive 비우기. username 없으면 전체 삭제."""
    data = _load_user_archive()
    if not isinstance(data, dict):
        data = {}
    if username:
        before = len(data.get(username, []) or [])
        data[username] = []
        _save_user_archive(data)
        return before
    # 전체
    before = sum(len(v) for v in data.values() if isinstance(v, list))
    _save_user_archive({})
    return before


def _admin_clear_history() -> int:
    users = _load_history()
    n = 0
    if isinstance(users, dict):
        for _, h in users.items():
            if isinstance(h, dict):
                n += len(h)
    _save_history({})
    return n


def _admin_clear_generation_stats() -> int:
    items = _load_worksheet_stat_items()
    n = len(items) if isinstance(items, list) else 0
    _save_worksheet_stat_items([])
    return n


def _admin_remove_user_from_archive(username: str) -> int:
    u = (username or "").strip()
    if not u:
        return 0
    data = _load_user_archive()
    if not isinstance(data, dict):
        return 0
    before = len(data.get(u, []) or []) if isinstance(data.get(u), list) else 0
    if u in data:
        data.pop(u, None)
        _save_user_archive(data)
    return before


def _admin_remove_user_from_history(username: str) -> int:
    u = (username or "").strip()
    if not u:
        return 0
    users = _load_history()
    hist = users.get(u, {})
    before = len(hist) if isinstance(hist, dict) else 0
    if u in users:
        users.pop(u, None)
        _save_history(users)
    return before


def _admin_remove_user_from_api_vault(username: str) -> bool:
    u = (username or "").strip()
    if not u:
        return False
    try:
        v = _api_vault_get()
        if u in v:
            v.pop(u, None)
            app.storage.user[_API_VAULT_KEY] = v
        return True
    except Exception:
        return False

def _format_relative_time(iso_str: str) -> str:
    """ISO 시간 → '5분 전', '2시간 전', '어제' 같은 상대 표현."""
    try:
        dt = _dt.datetime.fromisoformat(iso_str)
    except Exception:
        return ""
    now = _dt.datetime.now()
    delta = now - dt
    secs = delta.total_seconds()
    if secs < 60:
        return "방금 전"
    if secs < 3600:
        return f"{int(secs // 60)}분 전"
    if secs < 86400:
        return f"{int(secs // 3600)}시간 전"
    if secs < 86400 * 7:
        return f"{int(secs // 86400)}일 전"
    return dt.strftime("%Y-%m-%d")



# =====================================================================
# 자료 라이브러리 — 폴더 구조 스캔 및 파싱
#
# 폴더 규칙:
#   assets/
#     5학년/                              ← (\d+)학년
#       사회/                             ← 자유 (폴더명 그대로)
#         비상교육/                       ← 자유 (출판사명, 폴더명 그대로)
#           2단원_우리 국토의 자연환경/    ← (\d+)단원[_\s](.+)
#             교과서.pdf                  ← 필수
#             지도서.pdf                  ← 선택
#             교육과정.pdf                ← 선택
# =====================================================================
import re as _re
import unicodedata as _ud

_GRADE_RE = _re.compile(r"^(\d+)학년$")
_UNIT_RE = _re.compile(r"^(\d+)단원(?:[_\s](.+))?$")
_PDF_ALIASES = {
    "교과서": "textbook",
    "지도서": "guide",
    "교육과정": "curriculum",
    # 품질 보조 자료(선택)
    "평가문항": "assessment",
    "평가": "assessment",
    "수업지도안": "lesson_plan",
    "지도안": "lesson_plan",
}

_OPTIONAL_UNIT_FILE_EXT = frozenset({".pdf", ".png", ".jpg", ".jpeg", ".webp"})


def _save_optional_unit_asset(unit_path_str: str, logical_stem: str, data: bytes, uploaded_name: str = "") -> bool:
    """단원 폴더에 평가문항·지도안 등 선택 파일 저장(PDF/PNG/JPEG/WebP). logical_stem 예: '평가문항'."""
    try:
        up = Path(unit_path_str)
        if not up.exists() or not up.is_dir():
            return False
        up.resolve().relative_to(_ASSETS_DIR.resolve())
    except Exception:
        return False
    ext = Path((uploaded_name or "").strip()).suffix.lower()
    if ext not in _OPTIONAL_UNIT_FILE_EXT:
        from services.document_text import sniff_extension

        ext = sniff_extension(uploaded_name or "", data)
    if ext not in _OPTIONAL_UNIT_FILE_EXT:
        return False
    out = up / f"{logical_stem}{ext}"
    try:
        out.write_bytes(data)
        return True
    except Exception:
        return False


# =====================================================================
# 교육과정 자동 매칭 — assets/_curriculum/{학년군}/{과목}.pdf
# 학년 → 학년군 매핑:
#   1, 2 → "1-2학년군"
#   3, 4 → "3-4학년군"
#   5, 6 → "5-6학년군"
# =====================================================================
_CURRICULUM_DIR_NAME = "_curriculum"


def _grade_to_band(grade_no: int) -> str:
    """학년 → 학년군 폴더명. 1~2 → '1-2학년군' 등."""
    if grade_no in (1, 2):
        return "1-2학년군"
    if grade_no in (3, 4):
        return "3-4학년군"
    if grade_no in (5, 6):
        return "5-6학년군"
    return ""


def _find_curriculum_pdf(grade_no: int, subject: str) -> Path | None:
    """학년·과목으로 교육과정 PDF 찾기. NFC 정규화로 macOS 대응."""
    band = _grade_to_band(grade_no)
    if not band:
        return None
    curr_dir = _ASSETS_DIR / _CURRICULUM_DIR_NAME
    if not curr_dir.exists():
        return None

    target = _norm(subject).strip()
    band_str = _norm(band).strip()

    # 1) 권장 구조: _curriculum/{학년군}/{과목}.pdf (정확 매칭)
    band_dir = curr_dir / band_str
    if band_dir.exists():
        for pdf in band_dir.glob("*.pdf"):
            if _norm(pdf.stem.strip()) == target:
                return pdf

    # 2) 유연 매칭: _curriculum 폴더 안에 파일명(무관)이라도 과목명이 들어가면 매칭
    #    예: 국가수준교육과정(과학_5-6학년군).pdf, ..._국어_....pdf 등
    candidates: list[Path] = []
    for pdf in curr_dir.glob("*.pdf"):
        stem = _norm(pdf.stem)
        if target and target in stem:
            candidates.append(pdf)

    if not candidates:
        return None

    # 학년군 문자열까지 함께 들어간 파일을 우선
    for pdf in candidates:
        if band_str and band_str in _norm(pdf.stem):
            return pdf

    # 마지막 fallback: 과목명만 포함된 첫 후보
    return candidates[0]



def _norm(s: str) -> str:
    """
    한글 정규화 (NFD → NFC).
    macOS는 한글 폴더명을 자모 분리(NFD) 형태로 저장하는데,
    정규식과 PDF alias 비교는 합쳐진(NFC) 형태 기준이라 변환 필수.
    """
    return _ud.normalize("NFC", s)


def _scan_library() -> list[dict]:
    """
    assets/ 폴더 전체를 스캔해서 학년→과목→출판사→단원 트리 반환.
    형식:
    [
      {
        "grade": 5,
        "grade_label": "5학년",
        "path": Path,
        "subjects": [
          {
            "subject": "사회",
            "path": Path,
            "publishers": [
              {
                "publisher": "비상교육",
                "path": Path,
                "units": [
                  {
                    "unit_no": 2,
                    "unit_name": "우리 국토의 자연환경",
                    "label": "2단원 · 우리 국토의 자연환경",
                    "path": Path,
                    "files": {
                      "textbook": Path or None,
                      "guide": Path or None,
                      "curriculum": Path or None,
                      "assessment": Path or None,
                      "lesson_plan": Path or None,
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
    """
    if not _ASSETS_DIR.exists():
        return []

    _SEMESTER_NAMES = {"1학기", "2학기"}

    def _scan_units_in_dir(parent_dir: Path) -> list[dict]:
        """parent_dir 아래의 'N단원(_이름)' 폴더들을 units로 스캔."""
        units: list[dict] = []
        for unit_dir in sorted(parent_dir.iterdir(), key=lambda p: _unit_sort_key(p.name)):
            if not unit_dir.is_dir():
                continue
            um = _UNIT_RE.match(_norm(unit_dir.name))
            if not um:
                continue
            unit_no = int(um.group(1))
            unit_name = (um.group(2) or "").strip()
            files = {"textbook": None, "guide": None, "curriculum": None, "assessment": None, "lesson_plan": None}
            candidates: dict[str, list[Path]] = {}
            for p in unit_dir.iterdir():
                if not p.is_file():
                    continue
                ext = p.suffix.lower()
                if ext not in _OPTIONAL_UNIT_FILE_EXT:
                    continue
                stem = _norm(p.stem.strip())
                key = _PDF_ALIASES.get(stem)
                if not key:
                    continue
                candidates.setdefault(key, []).append(p)

            def _pick_file(paths: list[Path]) -> Path | None:
                if not paths:
                    return None
                def _prio(pp: Path) -> tuple[int, str]:
                    e = pp.suffix.lower()
                    pr = 0 if e == ".pdf" else 1
                    return (pr, pp.name.lower())

                return sorted(paths, key=_prio)[0]

            for k, plist in candidates.items():
                files[k] = _pick_file(plist)
            label = f"{unit_no}단원 · {unit_name}" if unit_name else f"{unit_no}단원"
            units.append({
                "unit_no": unit_no,
                "unit_name": unit_name,
                "label": label,
                "path": unit_dir,
                "files": files,
            })
        return units

    grades = []
    for grade_dir in sorted(_ASSETS_DIR.iterdir()):
        if not grade_dir.is_dir():
            continue
        if grade_dir.name == _CURRICULUM_DIR_NAME:
            continue  # 교육과정 전용 폴더는 학년 트리에서 제외
        m = _GRADE_RE.match(_norm(grade_dir.name))
        if not m:
            continue
        grade_no = int(m.group(1))

        subjects = []
        for subj_dir in sorted(grade_dir.iterdir()):
            if not subj_dir.is_dir():
                continue

            publishers = []
            subj_name = _norm(subj_dir.name)

            # (A) 출판사 폴더가 없는 구조 지원: assets/{학년}/{과목}/{단원}/...
            direct_units = _scan_units_in_dir(subj_dir)
            if direct_units:
                publishers.append({
                    "publisher": "미분류",
                    "semester": "",
                    "path": subj_dir,
                    "units": direct_units,
                })

            # (A2) 학기 폴더 구조: assets/{학년}/{과목}/{1학기|2학기}/{단원}/...
            for sem_dir in sorted([d for d in subj_dir.iterdir() if d.is_dir() and _norm(d.name) in _SEMESTER_NAMES], key=lambda p: _norm(p.name)):
                sem_name = _norm(sem_dir.name)
                sem_direct_units = _scan_units_in_dir(sem_dir)
                if sem_direct_units:
                    publishers.append({
                        "publisher": "미분류",
                        "semester": sem_name,
                        "path": sem_dir,
                        "units": sem_direct_units,
                    })

                # (B2) 학기+출판사: assets/{학년}/{과목}/{학기}/{출판사}/{단원}/...
                for pub_dir in sorted(sem_dir.iterdir()):
                    if not pub_dir.is_dir():
                        continue
                    if _UNIT_RE.match(_norm(pub_dir.name)):
                        continue
                    units = _scan_units_in_dir(pub_dir)
                    if units:
                        publishers.append({
                            "publisher": _norm(pub_dir.name),
                            "semester": sem_name,
                            "path": pub_dir,
                            "units": units,
                        })

            # (B) 기존 구조: assets/{학년}/{과목}/{출판사}/{단원}/...
            for pub_dir in sorted(subj_dir.iterdir()):
                if not pub_dir.is_dir():
                    continue
                # 학기 폴더는 여기서 출판사로 취급하지 않음
                if _norm(pub_dir.name) in _SEMESTER_NAMES:
                    continue
                # 단원 폴더면 출판사로 취급하지 않음 (direct_units로 이미 처리)
                if _UNIT_RE.match(_norm(pub_dir.name)):
                    continue
                units = _scan_units_in_dir(pub_dir)
                if units:
                    publishers.append({
                        "publisher": _norm(pub_dir.name),
                        "semester": "",
                        "path": pub_dir,
                        "units": units,
                    })

            if publishers:
                subjects.append({
                    "subject": subj_name,
                    "path": subj_dir,
                    "publishers": publishers,
                })
        if subjects:
            grades.append({
                "grade": grade_no,
                "grade_label": _norm(grade_dir.name),
                "path": grade_dir,
                "subjects": subjects,
            })
    return grades


def _unit_sort_key(name: str):
    """단원 폴더 정렬 키 — 단원 번호 기준."""
    m = _UNIT_RE.match(_norm(name))
    return (int(m.group(1)) if m else 9999, name)


def _library_is_empty() -> bool:
    """라이브러리에 유효한 단원이 하나도 없는지."""
    return len(_scan_library()) == 0


def _pdf_meta(pdf_path: Path) -> dict:
    """PDF(또는 이미지)의 페이지 수, 파일 크기, 수정일 (lazy 호출용)."""
    if not pdf_path or not pdf_path.exists():
        return {"pages": 0, "size_kb": 0, "mtime": ""}
    try:
        size = pdf_path.stat().st_size
        mtime = _dt.datetime.fromtimestamp(pdf_path.stat().st_mtime).strftime("%Y-%m-%d")
        ext = pdf_path.suffix.lower()
        if ext in (".png", ".jpg", ".jpeg", ".webp"):
            return {"pages": 1, "size_kb": size / 1024, "mtime": mtime}
        try:
            import fitz
            doc = fitz.open(pdf_path)
            pages = len(doc)
            doc.close()
        except Exception:
            pages = 0
        return {"pages": pages, "size_kb": size / 1024, "mtime": mtime}
    except Exception:
        return {"pages": 0, "size_kb": 0, "mtime": ""}


def _library_stats(library: list) -> dict:
    """라이브러리 전체 통계 (학년·과목·출판사·단원 수)."""
    grade_count = len(library)
    subjects_set = set()
    publishers_set = set()
    units_total = 0
    for grade in library:
        for subj in grade["subjects"]:
            subjects_set.add(f"{grade['grade_label']}/{subj['subject']}")
            for pub in subj["publishers"]:
                sem = pub.get("semester") or ""
                publishers_set.add(f"{grade['grade_label']}/{subj['subject']}/{sem}/{pub['publisher']}")
                units_total += len(pub["units"])
    return {
        "grades": grade_count,
        "subjects": len(subjects_set),
        "publishers": len(publishers_set),
        "units": units_total,
    }


def _count_subject_units(subject: dict) -> int:
    """과목 안의 전체 단원 수."""
    return sum(len(p["units"]) for p in subject["publishers"])


def _count_grade_units(grade: dict) -> int:
    """학년 안의 전체 단원 수."""
    return sum(_count_subject_units(s) for s in grade["subjects"])


def _completed_units_count(library: list) -> int:
    """이력에 기록된 + 폴더 존재하는 단원 수."""
    history = _load_history()
    valid_paths = set()
    for grade in library:
        for subj in grade["subjects"]:
            for pub in subj["publishers"]:
                for unit in pub["units"]:
                    if str(unit["path"]) in history:
                        valid_paths.add(str(unit["path"]))
    return len(valid_paths)


def _last_used_iso(library: list) -> str:
    """라이브러리 안 단원 중 가장 최근 사용 시각 (ISO)."""
    history = _load_history()
    valid_unit_paths = {
        str(unit["path"])
        for grade in library
        for subj in grade["subjects"]
        for pub in subj["publishers"]
        for unit in pub["units"]
    }
    times = [
        entry["last_used"]
        for path, entry in history.items()
        if path in valid_unit_paths and entry.get("last_used")
    ]
    return max(times) if times else ""


def _filter_library(library: list, query: str) -> list:
    """검색어로 라이브러리 필터링. 매칭된 단원의 부모(학년/과목/출판사)도 보존."""
    if not query:
        return library
    q = _norm(query.strip().lower())
    if not q:
        return library
    result = []
    for grade in library:
        gm = q in _norm(grade["grade_label"]).lower()
        new_subjects = []
        for subj in grade["subjects"]:
            sm = q in _norm(subj["subject"]).lower()
            new_publishers = []
            for pub in subj["publishers"]:
                pm = q in _norm(pub["publisher"]).lower()
                new_units = []
                for unit in pub["units"]:
                    um = q in _norm(unit["label"]).lower() or q in _norm(unit["unit_name"]).lower()
                    if gm or sm or pm or um:
                        new_units.append(unit)
                if new_units:
                    new_pub = dict(pub)
                    new_pub["units"] = new_units
                    new_publishers.append(new_pub)
            if new_publishers:
                new_subj = dict(subj)
                new_subj["publishers"] = new_publishers
                new_subjects.append(new_subj)
        if new_subjects:
            new_grade = dict(grade)
            new_grade["subjects"] = new_subjects
            result.append(new_grade)
    return result




# ============ 강력한 다운로드 및 미리보기 라우터 ============
@app.get("/download/pdf/{filepath:path}")
def download_pdf_route(filepath: str):
    from fastapi.responses import Response
    import urllib.parse
    pdf_path = _OUTPUTS_DIR / filepath
    if not pdf_path.exists() or not pdf_path.is_file():
        return Response(status_code=404, content=b"PDF not found")
    
    data = pdf_path.read_bytes()
    encoded_name = urllib.parse.quote(pdf_path.name)
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
            "Cache-Control": "no-cache"
        }
    )


@app.get("/share/qr/{sid}.png")
def share_qr_png(sid: str):
    """세션 공유 다운로드 링크용 QR PNG."""
    from fastapi.responses import Response
    import io
    try:
        import qrcode
    except Exception:
        return Response(status_code=500, content=b"qrcode module missing")

    # 같은 호스트/포트로 접근하므로 상대 URL을 QR에 담는다.
    # (폰에서 스캔 시 브라우저가 현재 서버로 접속)
    url = f"/share/{sid}"
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


# ZIP 일괄 다운로드 — 결과 페이지의 모든 PDF를 한 번에
@app.get("/download/zip/current")
def download_zip_current_session():
    """현재 사용자의 세션 PDF 전부를 ZIP으로 묶어 반환."""
    from fastapi.responses import Response
    import urllib.parse, io, zipfile, datetime
    sid = _session_id()
    pdfs = _SESSION_RESULTS.get(sid, [])
    if not pdfs:
        return Response(status_code=404, content=b"No PDFs in session")
    
    valid = [p for p in pdfs if p.exists() and p.is_file()]
    if not valid:
        return Response(status_code=404, content=b"No valid PDFs")
    
    # 메모리에 ZIP 생성
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 동일 파일명 충돌 회피
        used_names: dict[str, int] = {}
        for pdf in valid:
            base = pdf.name
            if base in used_names:
                used_names[base] += 1
                stem = pdf.stem
                ext = pdf.suffix
                arcname = f"{stem}_{used_names[base]}{ext}"
            else:
                used_names[base] = 0
                arcname = base
            zf.write(pdf, arcname=arcname)
    
    data = buf.getvalue()
    # 파일명: 학습지_YYYYMMDD_HHMM.zip
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M")
    zip_name = f"학습지_{ts}.zip"
    encoded = urllib.parse.quote(zip_name)
    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded}",
            "Cache-Control": "no-cache"
        }
    )

@app.get("/preview/html/{filepath:path}")
def serve_preview_html(filepath: str):
    from fastapi.responses import Response
    html_path = _OUTPUTS_DIR / filepath
    if not html_path.exists() or not html_path.is_file():
        return Response(status_code=404, content=b"HTML not found")
    
    data = html_path.read_bytes()
    return Response(
        content=data,
        media_type="text/html; charset=utf-8"
    )

# 썸네일 서빙 라우트 (outputs 폴더용)
_THUMB_CACHE: dict[str, bytes] = {} 
@app.get("/files/thumb/{filepath:path}")
def serve_thumb(filepath: str, page: int = 0):
    from fastapi.responses import Response

    if page < 0 or page > 800:
        return Response(status_code=400, content=b"bad page")
    cache_key = f"{filepath}#p{page}"
    if cache_key in _THUMB_CACHE:
        return Response(content=_THUMB_CACHE[cache_key], media_type="image/png")

    pdf_path = _OUTPUTS_DIR / filepath
    if not pdf_path.exists() or not pdf_path.is_file():
        return Response(status_code=404, content=b"PDF not found")

    try:
        import fitz

        doc = fitz.open(pdf_path)
        try:
            if page >= len(doc):
                return Response(status_code=404, content=b"page out of range")
            pix = doc.load_page(page).get_pixmap(dpi=80)
            png_bytes = pix.tobytes("png")
        finally:
            doc.close()
        _THUMB_CACHE[cache_key] = png_bytes
        return Response(content=png_bytes, media_type="image/png")
    except Exception as exc:
        return Response(status_code=500, content=str(exc).encode())


# 썸네일 서빙 라우트 (assets 라이브러리용)
_ASSET_THUMB_CACHE: dict[str, bytes] = {}
@app.get("/files/asset_thumb/{filepath:path}")
def serve_asset_thumb(filepath: str):
    from fastapi.responses import Response
    if filepath in _ASSET_THUMB_CACHE:
        return Response(content=_ASSET_THUMB_CACHE[filepath], media_type="image/png")
    pdf_path = _ASSETS_DIR / filepath
    if not pdf_path.exists() or not pdf_path.is_file():
        return Response(status_code=404, content=b"PDF not found")
    try:
        import fitz
        doc = fitz.open(pdf_path)
        pix = doc.load_page(0).get_pixmap(dpi=80)
        png_bytes = pix.tobytes("png")
        doc.close()
        _ASSET_THUMB_CACHE[filepath] = png_bytes
        return Response(content=png_bytes, media_type="image/png")
    except Exception as exc:
        return Response(status_code=500, content=str(exc).encode())

# =====================================================================
# 미리보기 이미지 서빙 — PDF의 N번째 페이지를 PNG로 변환해 반환
# (기존 iframe + .preview.html 방식은 NiceGUI의 DOMPurify가 iframe 태그를
#  제거해서 미리보기가 아예 렌더되지 않는 이슈가 있었음. img 태그는
#  DOMPurify가 허용하므로 이미지 기반으로 전환.)
# =====================================================================
_PAGE_PNG_CACHE: dict[str, bytes] = {}

@app.get("/preview/pdf_png/{filepath:path}")
def serve_pdf_page_png(filepath: str, page: int = 0):
    from fastapi.responses import Response
    cache_key = f"{filepath}#p{page}"
    if cache_key in _PAGE_PNG_CACHE:
        return Response(
            content=_PAGE_PNG_CACHE[cache_key],
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"}
        )
    pdf_path = _OUTPUTS_DIR / filepath
    if not pdf_path.exists() or not pdf_path.is_file():
        return Response(status_code=404, content=b"PDF not found")
    try:
        import fitz
        doc = fitz.open(pdf_path)
        if page < 0 or page >= len(doc):
            doc.close()
            return Response(status_code=404, content=b"Page out of range")
        # 130dpi로 A4 landscape → 약 1530×1080px. 선명하면서도 용량 적당.
        pix = doc.load_page(page).get_pixmap(dpi=130)
        png_bytes = pix.tobytes("png")
        doc.close()
        _PAGE_PNG_CACHE[cache_key] = png_bytes
        return Response(
            content=png_bytes,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=3600"}
        )
    except Exception as exc:
        return Response(status_code=500, content=str(exc).encode())


def _pdf_page_count(pdf_path: Path) -> int:
    """PDF 페이지 수. 실패 시 0."""
    try:
        import fitz
        doc = fitz.open(pdf_path)
        n = len(doc)
        doc.close()
        return n
    except Exception:
        return 0


def _build_preview_html(pdf_path: Path, cache_buster: int = 0) -> str:
    """미리보기 영역에 넣을 HTML (img 태그 세로 나열). DOMPurify 통과 가능."""
    try:
        rel = pdf_path.relative_to(_OUTPUTS_DIR).as_posix()
    except ValueError:
        return '<div style="padding:40px; text-align:center; color:#64748B;">미리보기 경로 오류</div>'
    quoted = urllib.parse.quote(rel)
    n = _pdf_page_count(pdf_path)
    if n == 0:
        return '<div style="padding:40px; text-align:center; color:#64748B;">미리보기를 불러올 수 없습니다</div>'
    imgs = []
    for i in range(n):
        src = f"/preview/pdf_png/{quoted}?page={i}&t={cache_buster}"
        imgs.append(
            f'<img src="{src}" alt="페이지 {i+1}" loading="lazy" '
            f'style="display:block; width:100%; max-width:100%; height:auto; '
            f'aspect-ratio:297/210; object-fit:contain; margin:0 auto 14px auto; '
            f'box-shadow:0 4px 14px rgba(0,0,0,0.12); border-radius:4px; background:white;" />'
        )
    return (
        '<div style="padding:16px; box-sizing:border-box; height:100%; overflow-y:auto; '
        'background:#E2E8F0; -webkit-overflow-scrolling:touch;">'
        + "".join(imgs) +
        '</div>'
    )


# ============ 인증 (서버 메모리 기반 세션) ============
def _parse_users() -> dict[str, str]:
    raw = os.environ.get("LESSON_APP_USERS", "")
    users: dict[str, str] = {}
    for pair in raw.split(","):
        if ":" in pair:
            u, p = pair.split(":", 1)
            users[u.strip()] = p.strip()
    return users

# LESSON_APP_USERS=user:pass,user2:pass2 (평문, 우선 매칭)
_ENV_USERS = _parse_users()
_AUTH_SESSIONS: set[str] = set()

# 관리자 계정(기능 점검용)
_ADMIN_USERS: set[str] = {"winmouse1111"}


def is_admin() -> bool:
    return bool(app.storage.user.get("is_admin"))


def _username_allows_anthropic(username: str | None) -> bool:
    return bool(username) and username in _ADMIN_USERS


_API_VAULT_KEY = "_api_key_vault"


def _api_vault_get() -> dict:
    v = app.storage.user.get(_API_VAULT_KEY)
    if not isinstance(v, dict):
        v = {}
    return v


def _api_vault_put(username: str, prefs: dict) -> None:
    """계정별 API 설정을 브라우저 저장소에 영구 보관(아이디 단위)."""
    if not username:
        return
    v = _api_vault_get()
    v[username] = {
        "anthropic_api_key": (prefs.get("anthropic_api_key") or "").strip(),
        "gemini_api_key": (prefs.get("gemini_api_key") or "").strip(),
        "api_provider": (prefs.get("api_provider") or "anthropic").strip() or "anthropic",
    }
    app.storage.user[_API_VAULT_KEY] = v


def _api_prefs_for_user(username: str) -> dict:
    """금고에서 해당 계정 설정을 읽는다. 없으면 빈 값."""
    row = _api_vault_get().get(username)
    if not isinstance(row, dict):
        return {"anthropic_api_key": "", "gemini_api_key": "", "api_provider": "anthropic"}
    return {
        "anthropic_api_key": (row.get("anthropic_api_key") or "").strip(),
        "gemini_api_key": (row.get("gemini_api_key") or "").strip(),
        "api_provider": (row.get("api_provider") or "anthropic").strip() or "anthropic",
    }


def _apply_non_admin_api_rules(prefs: dict, username: str) -> dict:
    """관리자가 아니면 Anthropic 키·선택을 쓰지 않는다."""
    if _username_allows_anthropic(username):
        return prefs
    out = dict(prefs)
    out["anthropic_api_key"] = ""
    out["api_provider"] = "gemini"
    return out


def _snapshot_api_prefs() -> dict:
    return {
        "anthropic_api_key": app.storage.user.get("anthropic_api_key") or "",
        "gemini_api_key": app.storage.user.get("gemini_api_key") or "",
        "api_provider": app.storage.user.get("api_provider") or "anthropic",
    }


def _apply_api_prefs(prefs: dict) -> None:
    app.storage.user["anthropic_api_key"] = prefs.get("anthropic_api_key") or ""
    app.storage.user["gemini_api_key"] = prefs.get("gemini_api_key") or ""
    app.storage.user["api_provider"] = prefs.get("api_provider") or "anthropic"


def _effective_provider_and_key() -> tuple[str, str]:
    """실제 파이프라인/검증에 쓸 provider와 API KEY (비관리자는 항상 Gemini)."""
    u = app.storage.user.get("username") or ""
    if not _username_allows_anthropic(u):
        k = (app.storage.user.get("gemini_api_key") or "").strip()
        return "gemini", k
    prov = (app.storage.user.get("api_provider") or "anthropic").strip() or "anthropic"
    if prov == "gemini":
        return "gemini", (app.storage.user.get("gemini_api_key") or "").strip()
    return "anthropic", (app.storage.user.get("anthropic_api_key") or "").strip()


def _clear_user_storage_keep_vault_session(sid: str | None) -> None:
    """session_id + 계정별 API 금고만 유지하고 나머지 user storage는 비운다."""
    vault = _api_vault_get()
    for k in list(app.storage.user.keys()):
        del app.storage.user[k]
    if sid:
        app.storage.user["session_id"] = sid
    app.storage.user[_API_VAULT_KEY] = vault


def _clear_user_storage_keep_api_keys(sid: str | None) -> None:
    """하위 호환: 로그인 성공 직전 등 — 금고는 유지, 루트의 API 필드만 비우려면 vault 버전을 쓴다."""
    _clear_user_storage_keep_vault_session(sid)


def _reset_library_page_ui_state() -> None:
    fn = globals().get("library_page")
    if not callable(fn):
        return
    for name in (
        "_expanded",
        "_selected_unit_path",
        "_dd_grade",
        "_dd_subject",
        "_dd_semester",
        "_dd_publisher",
        "_dd_query",
        "_search_query",
    ):
        if hasattr(fn, name):
            try:
                delattr(fn, name)
            except Exception:
                pass


def _on_login_success(sid: str, username: str) -> None:
    # 직전 로그인 사용자 키를 금고에 반영 (같은 브라우저에서 계정 전환)
    prev_u = app.storage.user.get("username")
    if prev_u:
        _api_vault_put(prev_u, _snapshot_api_prefs())
    # 로그인 화면에서 온 경우: 루트에만 남아 있는 키를 새 아이디 금고로 귀속 (해당 유저 금고가 비어 있을 때만)
    orphan = _snapshot_api_prefs()
    v = _api_vault_get()
    if username not in v and (orphan.get("anthropic_api_key") or orphan.get("gemini_api_key")):
        v[username] = {
            "anthropic_api_key": orphan.get("anthropic_api_key") or "",
            "gemini_api_key": orphan.get("gemini_api_key") or "",
            "api_provider": orphan.get("api_provider") or "anthropic",
        }
        app.storage.user[_API_VAULT_KEY] = v

    _clear_user_storage_keep_vault_session(sid)
    app.storage.user["username"] = username
    app.storage.user["is_admin"] = (username in _ADMIN_USERS)

    prefs = _api_prefs_for_user(username)
    prefs = _apply_non_admin_api_rules(prefs, username)
    _apply_api_prefs(prefs)
    _api_vault_put(username, _snapshot_api_prefs())

    _AUTH_SESSIONS.add(sid)
    _SESSIONS[sid] = Session()
    _SESSION_RESULTS.pop(sid, None)
    _reset_library_page_ui_state()


def _on_logout_navigate_login() -> None:
    sid = app.storage.user.get("session_id")
    u = app.storage.user.get("username")
    if u:
        _api_vault_put(u, _snapshot_api_prefs())
    try:
        if sid:
            _AUTH_SESSIONS.discard(sid)
    except Exception:
        pass
    if sid:
        _SESSIONS.pop(sid, None)
        _SESSION_RESULTS.pop(sid, None)
    _reset_library_page_ui_state()
    _clear_user_storage_keep_vault_session(sid)
    ui.navigate.to("/login")


def require_auth() -> str | None:
    sid = app.storage.user.get("session_id")
    if not sid or sid not in _AUTH_SESSIONS:
        ui.navigate.to("/login")
        return None
    if not app.storage.user.get("username"):
        ui.navigate.to("/login")
        return None
    return "admin" if is_admin() else "user"


# ============ 세션 ============
_SESSIONS: dict[str, Session] = {}

def get_session() -> Session:
    sid = app.storage.user.get("session_id")
    if not sid:
        sid = str(uuid4())
        app.storage.user["session_id"] = sid
    if sid not in _SESSIONS:
        _SESSIONS[sid] = Session()
    return _SESSIONS[sid]


# ============ 디자인 시스템 CSS ============
DESIGN_CSS = """
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css');

/* Theme tokens --------------------------------------------------------- */
:root {
  --bg-canvas: #F1F5F9; 
  --bg-sidebar: #FFFFFF;
  --bg-surface: #FFFFFF;
  --bg-subtle: #F8FAFC;
  --bg-muted: #E2E8F0;
  --color-ink: #0F172A;
  --color-ink-soft: #334155;
  --color-ink-muted: #64748B; 
  --color-ink-faint: #94A3B8;
  --color-line: #E2E8F0; 
  --color-line-strong: #CBD5E1; 
  --color-primary: #10B981;
  --color-primary-soft: rgba(16, 185, 129, 0.1);
  --color-primary-gradient: linear-gradient(135deg, #34D399, #059669);
  --color-success: #10B981;
  --color-success-deep: #047857;
  --color-success-soft: rgba(16, 185, 129, 0.12);
  --color-danger: #EF4444;
  /* IDE 감성: 반경을 조금 더 날카롭게 */
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 14px;
  --shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
  --shadow-app: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);

  /* 라이브러리 트리 폴더 색 구분 */
  --folder-grade-bg: rgba(245, 158, 11, 0.12);      /* 노랑 (학년) */
  --folder-grade-line: rgba(245, 158, 11, 0.45);
  --folder-subject-bg: rgba(59, 130, 246, 0.10);    /* 파랑 (과목) */
  --folder-subject-line: rgba(59, 130, 246, 0.40);
  --folder-publisher-bg: rgba(16, 185, 129, 0.10);  /* 초록 (출판사) */
  --folder-publisher-line: rgba(16, 185, 129, 0.45);
}

:root[data-theme="dark"] {
  /* iPhone 다크모드 느낌: 그레이 톤의 블랙 */
  --bg-canvas: #0F1012;
  --bg-sidebar: #121316;
  --bg-surface: #15171A;
  --bg-subtle: #1A1D21;
  --bg-muted: #23262B;

  /* 텍스트 대비 */
  --color-ink: rgba(255,255,255,0.92);
  --color-ink-soft: rgba(255,255,255,0.78);
  --color-ink-muted: rgba(255,255,255,0.60);
  --color-ink-faint: rgba(255,255,255,0.42);

  --color-line: rgba(255,255,255,0.10);
  --color-line-strong: rgba(255,255,255,0.16);

  /* 포인트: 초록 → 연노란색 */
  --color-primary: #F5E37A;
  --color-primary-soft: rgba(245, 227, 122, 0.14);
  --color-primary-gradient: linear-gradient(135deg, #F8EEA4, #E8C74C);

  /* 성공/강조도 같은 계열로 맞춤 */
  --color-success: #F5E37A;
  --color-success-deep: #D8B43F;
  --color-success-soft: rgba(245, 227, 122, 0.16);

  --shadow-card: 0 10px 28px rgba(0,0,0,0.55);
  --shadow-app: 0 22px 60px rgba(0,0,0,0.72);

  --folder-grade-bg: rgba(245, 158, 11, 0.14);
  --folder-grade-line: rgba(245, 158, 11, 0.50);
  --folder-subject-bg: rgba(59, 130, 246, 0.14);
  --folder-subject-line: rgba(59, 130, 246, 0.48);
  --folder-publisher-bg: rgba(245, 227, 122, 0.14);
  --folder-publisher-line: rgba(245, 227, 122, 0.55);
}
html, body { font-family: 'Pretendard', sans-serif !important; background: var(--bg-canvas) !important; color: var(--color-ink); letter-spacing: -0.01em; }
.q-page-container { padding: 0 !important; }
.q-page { min-height: 100vh !important; background: var(--bg-canvas) !important; }
.q-layout { background: var(--bg-canvas) !important; }
.q-btn { font-family: inherit !important; letter-spacing: -0.01em; text-transform: none !important; font-weight: 600; border-radius: var(--radius-md) !important; box-shadow: none !important; }
.q-btn--flat.text-primary, .q-btn--unelevated.bg-primary, .q-btn.bg-primary { background: var(--color-primary) !important; color: #FFFFFF !important; }
.q-btn--unelevated.bg-primary[disabled], .q-btn.bg-primary[disabled] { background: var(--bg-muted) !important; color: var(--color-ink-faint) !important; opacity: 0.8 !important; }

/* 드롭다운(Quasar q-select 메뉴) — 다크모드에서 글씨가 흐리게 보이는 문제 방지 */
:root[data-theme="dark"] .q-menu,
:root[data-theme="dark"] .q-menu * {
  color: rgba(255,255,255,0.92) !important;
}
:root[data-theme="dark"] .q-menu {
  background: var(--bg-surface) !important;
  border: 1px solid var(--color-line-strong) !important;
  box-shadow: 0 18px 50px rgba(0,0,0,0.72) !important;
}
:root[data-theme="dark"] .q-item {
  color: rgba(255,255,255,0.92) !important;
}
:root[data-theme="dark"] .q-item__label,
:root[data-theme="dark"] .q-item__section {
  color: rgba(255,255,255,0.92) !important;
}
:root[data-theme="dark"] .q-item--active,
:root[data-theme="dark"] .q-item.q-manual-focusable--focused,
:root[data-theme="dark"] .q-item:hover {
  background: rgba(255,255,255,0.08) !important;
}
/* 상단 단계 네비 (라이브러리 → … → 결과) — 사이드바와 분리 */
/* 본문 큰 제목 — 상단 단계 바(step-rail)보다 위에 배치 */
.page-hero {
  margin-bottom: 20px;
}
.step-rail {
  display: flex;
  align-items: stretch;
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  overflow-x: auto;
  margin-bottom: 24px;
}
.step-rail__sep {
  width: 1px;
  flex-shrink: 0;
  background: var(--color-line);
  align-self: stretch;
}
.step-rail__link {
  flex: 1;
  min-width: 112px;
  text-decoration: none !important;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 13px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-ink-soft);
  transition: background 0.15s ease, color 0.15s ease;
}
.step-rail__link:hover {
  background: var(--bg-subtle);
  color: var(--color-ink);
}
.step-rail__link--active {
  background: var(--color-primary-soft) !important;
  color: var(--color-success-deep) !important;
  font-weight: 800 !important;
  box-shadow: inset 0 -3px 0 0 var(--color-primary);
}
.step-rail__num {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 900;
  background: var(--bg-muted);
  color: var(--color-ink-muted);
  flex-shrink: 0;
}
.step-rail__link--active .step-rail__num {
  background: var(--color-primary) !important;
  color: #FFFFFF !important;
}
.pdf-card { background: var(--bg-surface); border: 1px solid var(--color-line-strong); transition: all 0.2s; }
.pdf-card .card-title { color: var(--color-ink); font-weight: 700; }
.pdf-card .card-sub { color: var(--color-ink-soft); font-weight: 600; }
.pdf-card.active { background: var(--color-primary-soft) !important; border-color: var(--color-primary) !important; box-shadow: 0 4px 12px rgba(16,185,129,0.15); transform: translateY(-2px); }
.pdf-card.active .card-title { color: var(--color-success-deep) !important; }
.pdf-card.active .card-sub { color: var(--color-primary) !important; }
.q-uploader { background: var(--bg-surface) !important; border: 1.5px dashed var(--color-line-strong) !important; border-radius: var(--radius-md) !important; width: 100% !important; color: var(--color-ink) !important; }
.q-uploader__header { background: transparent !important; color: var(--color-ink-soft) !important; }
.q-uploader__title { font-size: 12px !important; color: var(--color-ink) !important; }
.q-uploader__list { padding: 12px !important; background: transparent !important; }
.q-uploader { min-height: 56px !important; }
.q-uploader__header { padding: 6px 10px !important; }
.q-uploader__dnd { min-height: 30px !important; }
:root[data-theme="dark"] .q-uploader__header { color: var(--color-ink) !important; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--color-line-strong); border-radius: 8px; }
::-webkit-scrollbar-track { background: transparent; }

/* 숫자/메타: 모노스페이스로 '워크스테이션' 감 */
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace !important;
  font-variant-numeric: tabular-nums;
}

/* 파일 목록: 데이터 테이블 */
.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-surface);
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.data-table th, .data-table td {
  padding: 10px 10px;
  border-bottom: 1px solid var(--color-line);
  font-size: 12px;
  line-height: 1.35;
  vertical-align: middle;
}
.data-table th {
  background: var(--bg-subtle);
  color: var(--color-ink-faint);
  letter-spacing: 0.06em;
  font-weight: 900;
  text-transform: uppercase;
  font-size: 10px;
}
.data-table tr:last-child td { border-bottom: none; }
.data-table td.name { font-weight: 900; color: var(--color-ink); white-space: nowrap; }
.data-table td.muted { color: var(--color-ink-soft); font-weight: 700; }
.data-table td.faint { color: var(--color-ink-faint); }
.data-table td.right { text-align: right; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.02em;
  border: 1px solid var(--color-line-strong);
  background: var(--bg-canvas);
  color: var(--color-ink-soft);
}
.pill.ok {
  border-color: rgba(16,185,129,0.35);
  background: rgba(16,185,129,0.08);
  color: var(--color-success-deep);
}
.pill.warn {
  border-color: rgba(245,158,11,0.45);
  background: rgba(245,158,11,0.10);
  color: #92400E;
}
"""

# ============ 공통 셸 ============
def app_shell(current_step: int, render_body, on_asset_click=None, hero=None):
    ui.add_head_html(f"<style>{DESIGN_CSS}</style>")
    ui.add_head_html('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>')
    # QR 생성(클라이언트) — 결과 페이지 공유 다운로드용
    ui.add_head_html('<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>')

    steps = [(1, "라이브러리", "/"), (2, "페이지 그룹화", "/grouping"), (3, "생성", "/run"), (4, "결과", "/results")]

    # theme apply (persisted per user)
    theme = app.storage.user.get("theme", "light")
    if theme not in ("light", "dark"):
        theme = "light"
        app.storage.user["theme"] = theme
    ui.run_javascript(f"document.documentElement.dataset.theme = {theme!r};")

    # sidebar collapse state (persisted per user)
    sidebar_collapsed = bool(app.storage.user.get("sidebar_collapsed", False))

    def toggle_sidebar():
        app.storage.user["sidebar_collapsed"] = not bool(app.storage.user.get("sidebar_collapsed", False))
        ui.navigate.reload()

    with ui.element("div").style("display:flex; min-height:100vh; width:100%; background:var(--bg-canvas);"):
        # Sidebar가 완전히 숨겨졌을 때 다시 열 수 있는 고정 버튼만 남김
        if sidebar_collapsed:
            ui.button("☰", on_click=toggle_sidebar).props("unelevated dense").style(
                "position:fixed; left:14px; top:14px; z-index:9999; "
                "background:var(--bg-surface); color:var(--color-ink) !important; "
                "border:1px solid var(--color-line-strong); border-radius:12px; "
                "box-shadow:var(--shadow-card); padding:10px 12px; font-weight:900;"
            )

        aside_style = (
            "background:var(--bg-sidebar); border-right:1px solid var(--color-line-strong); "
            "display:flex; flex-direction:column; flex-shrink:0; z-index:10; overflow:hidden; "
            "align-self:stretch; min-height:100vh; justify-content:flex-start; "
            "transition: width 0.18s ease, padding 0.18s ease;"
        )
        if sidebar_collapsed:
            aside_style += "width:0px; padding:0; border-right:none;"
        else:
            aside_style += "width:320px; padding:28px 20px;"

        with ui.element("aside").style(aside_style):
            # 펼쳐진 상태에서만 '닫기' 버튼 노출
            if not sidebar_collapsed:
                with ui.element("div").style("display:flex; align-items:center; justify-content:flex-end; margin:-10px 0 10px 0;"):
                    ui.button("⟨", on_click=toggle_sidebar).props("flat dense").style(
                        "min-width:0; padding:6px 8px; font-size:14px; font-weight:900; "
                        "color:var(--color-ink-soft) !important; background:transparent !important;"
                    )

            content_style = (
                "display:none;"
                if sidebar_collapsed
                else "display:flex; flex-direction:column; flex:0 0 auto; width:100%;"
            )
            with ui.element("div").style(content_style):
                # ── Command Palette (⌘K / Ctrl+K) ───────────────────────────────
                palette_dialog = ui.dialog().props("maximized")
                with palette_dialog:
                    with ui.element("div").style("display:flex; align-items:flex-start; justify-content:center; padding:48px 24px; background:rgba(15,23,42,0.55); height:100vh;"):
                        with ui.element("div").style(
                            "width:min(760px, 100%); background:var(--bg-surface); border:1px solid var(--color-line-strong); "
                            "border-radius:var(--radius-lg); box-shadow:var(--shadow-app); overflow:hidden;"
                        ):
                            with ui.element("div").style("padding:14px 16px; border-bottom:1px solid var(--color-line); background:var(--bg-subtle);"):
                                ui.html(
                                    '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">'
                                    '<div style="font-size:12px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint);">COMMAND PALETTE</div>'
                                    '<div class="mono" style="font-size:11px; font-weight:900; color:var(--color-ink-faint);">ESC</div>'
                                    '</div>'
                                )

                        # 검색 입력
                        palette_query = {"q": ""}

                        @ui.refreshable
                        def palette_results():
                            q = (palette_query["q"] or "").strip().lower()
                            items = []
                            for idx, label, path in steps:
                                key = f"{idx} {label} {path}".lower()
                                if not q or q in key:
                                    items.append(("jump", f"이동: {label}", path))

                            if not q or "새로고침" in q or "reload" in q:
                                items.append(("action", "새로고침", "reload"))
                            if not q or "로그아웃" in q or "logout" in q:
                                items.append(("action", "로그아웃", "logout"))

                            with ui.element("div").style("padding:6px 8px; max-height:420px; overflow:auto;"):
                                if not items:
                                    ui.label("결과 없음").style("padding:12px; font-size:12px; color:var(--color-ink-faint); font-weight:800;")
                                for kind, title, payload in items[:12]:
                                    btn = ui.element("button").style(
                                        "width:100%; text-align:left; padding:10px 12px; border-radius:10px; "
                                        "border:1px solid transparent; background:transparent; cursor:pointer; font-family:inherit;"
                                    )

                                    def make_click(k=kind, p=payload):
                                        def _h():
                                            palette_dialog.close()
                                            if k == "jump":
                                                ui.navigate.to(p)
                                            else:
                                                if p == "reload":
                                                    ui.navigate.reload()
                                                elif p == "logout":
                                                    _on_logout_navigate_login()
                                        return _h

                                    btn.on("click", lambda *_, fn=make_click(): fn())
                                    with btn:
                                        ui.html(
                                            f'<div style="display:flex; align-items:center; gap:10px; pointer-events:none;">'
                                            f'<div style="width:28px; height:28px; border-radius:8px; background:var(--bg-canvas); '
                                            f'border:1px solid var(--color-line); display:flex; align-items:center; justify-content:center; '
                                            f'font-size:12px; font-weight:900; color:var(--color-ink-soft);">{ "↪" if kind=="jump" else "⚙" }</div>'
                                            f'<div style="flex:1; min-width:0;">'
                                            f'<div style="font-size:13px; font-weight:900; color:var(--color-ink); line-height:1.2;">{title}</div>'
                                            f'<div class="mono" style="font-size:11px; color:var(--color-ink-faint); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{payload}</div>'
                                            f'</div>'
                                            f'</div>'
                                        )

                        def on_palette_change(e):
                            v = getattr(e, "value", None)
                            if v is None:
                                v = getattr(e, "args", "") or ""
                            palette_query["q"] = str(v or "")
                            palette_results.refresh()

                        with ui.element("div").style("padding:14px 16px;"):
                            with ui.element("div").style(
                                "display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px; "
                                "border:1px solid var(--color-line-strong); background:var(--bg-surface);"
                            ):
                                ui.html('<div style="font-size:14px; color:var(--color-ink-faint);">⌘K</div>')
                                ui.input(placeholder="명령 검색… (예: 라이브러리, 새로고침)").props("dense borderless").style(
                                    "flex:1; font-size:14px; font-family:inherit;"
                                ).on("change", on_palette_change).on("input", on_palette_change)
                            palette_results()

            with ui.element("div").style(
                "display:flex; flex-direction:column; flex:1; min-height:0; overflow-y:auto; justify-content:flex-start; width:100%;"
            ):
                # 단축키: ⌘K / Ctrl+K로 팔레트 열기
                ui.run_javascript(
                    """
                    (function(){
                      if (window.__lesson_palette_bound) return;
                      window.__lesson_palette_bound = true;
                      window.addEventListener('keydown', function(e){
                        const isK = (e.key || '').toLowerCase() === 'k';
                        if ((e.metaKey || e.ctrlKey) && isK) {
                          e.preventDefault();
                          // NiceGUI python callback 대신 dialog open을 서버에 요청해야 하므로
                          // 버튼 클릭 트리거용 커스텀 이벤트를 사용
                          document.dispatchEvent(new CustomEvent('open-lesson-palette'));
                        }
                        if (e.key === 'Escape') {
                          document.dispatchEvent(new CustomEvent('close-lesson-palette'));
                        }
                      });
                    })();
                    """
                )
                ui.on("open-lesson-palette", lambda *_: palette_dialog.open())
                ui.on("close-lesson-palette", lambda *_: palette_dialog.close())

                with ui.element("div").style("display:flex; align-items:center; gap:12px; margin-bottom:32px; padding:0 4px;"):
                    ui.html(
                        '<div style="width:36px;height:36px;background:var(--color-primary-gradient);'
                        'border-radius:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(16,185,129,0.3);">'
                        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
                        '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></div>'
                    )
                    with ui.element("div"):
                        ui.label("Lesson Studio").style("font-size:16px; font-weight:800; letter-spacing:-0.02em; color:var(--color-ink);")

                session_ctx = None
                try: session_ctx = get_session()
                except Exception: pass
            
                if session_ctx and session_ctx.subject:
                    with ui.element("div").style("background:var(--bg-surface); border-radius:12px; padding:12px 14px; margin-bottom:24px; display:flex; align-items:center; gap:10px; border: 1px solid var(--color-line-strong); box-shadow:var(--shadow-card);"):
                        ui.html('<div style="width:28px;height:28px;border-radius:8px;background:var(--color-primary-soft);display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>')
                        with ui.element("div").style("flex:1; min-width:0;"):
                            ui.label(f"{session_ctx.subject} · 5학년").style("font-size:11px; font-weight:700; color:var(--color-primary); margin-bottom:2px;")
                            unit = session_ctx.textbook_filename or "파일 대기 중"
                            ui.label(unit).style("font-size:13px; font-weight:700; color:var(--color-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")

                # ── Sidebar Utilities: Quick + Status ──────────────────────────
                with ui.element("div").style(
                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-md); "
                    "padding:10px 10px; margin:8px 0 18px 0; box-shadow:var(--shadow-card);"
                ):
                    with ui.element("div").style("display:flex; align-items:center; justify-content:space-between; gap:10px;"):
                        ui.label("QUICK").style("font-size:10px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint);")
                        ui.html('<span class="mono" style="font-size:10px; font-weight:900; color:var(--color-ink-faint);">⌘K</span>')

                    # 상태 배지: API 키 유무 (워크스테이션 느낌)
                    api_ok = False
                    try:
                        prov_eff, key_eff = _effective_provider_and_key()
                        api_ok = bool(has_gemini_key(key_eff)) if prov_eff == "gemini" else bool(has_api_key(key_eff))
                    except Exception:
                        api_ok = False
                    ui.html(
                        f'<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">'
                        f'<span class="pill {"ok" if api_ok else "warn"}">{ "🟢 API OK" if api_ok else "🟠 API KEY?" }</span>'
                        f'<span class="pill"><span class="mono">v2026</span></span>'
                        f'</div>'
                    )

                    # API 엔진 + 키 (접기/펼치기; 관리자만 Anthropic / 비관리자는 Gemini만)
                    if "sidebar_api_key_expanded" not in app.storage.user:
                        app.storage.user["sidebar_api_key_expanded"] = True

                    @ui.refreshable
                    def sidebar_api_key_panel():
                        expanded = bool(app.storage.user.get("sidebar_api_key_expanded", True))

                        def toggle_api_key_panel():
                            app.storage.user["sidebar_api_key_expanded"] = not bool(
                                app.storage.user.get("sidebar_api_key_expanded", True)
                            )
                            sidebar_api_key_panel.refresh()

                        with ui.row().style(
                            "width:100%; margin-top:10px; align-items:center; justify-content:space-between; gap:8px;"
                        ):
                            ui.label("API 키").style(
                                "font-size:10px; font-weight:900; letter-spacing:0.06em; color:var(--color-ink-faint);"
                            )
                            ui.button(
                                "접기" if expanded else "펼치기",
                                on_click=toggle_api_key_panel,
                            ).props("dense unelevated no-caps").style(
                                "font-size:11px; font-weight:900; min-height:28px; padding:0 10px; border-radius:10px; "
                                "background:var(--color-primary) !important; color:white !important;"
                            )

                        if not expanded:
                            return

                        provider_select = None
                        anthropic_input = None
                        if is_admin():
                            if "api_provider" not in app.storage.user:
                                app.storage.user["api_provider"] = "anthropic"

                            def set_provider(e):
                                v = getattr(e, "value", None)
                                if v is None:
                                    v = getattr(e, "args", "") or ""
                                app.storage.user["api_provider"] = (str(v or "anthropic") or "anthropic")

                            provider_select = ui.select(
                                options=["anthropic", "gemini"],
                                value=app.storage.user.get("api_provider", "anthropic"),
                                on_change=set_provider,
                            ).props("dense outlined").style("margin-top:10px; width:100%; font-size:12px;")

                            anthropic_input = ui.input(
                                placeholder="개인 API KEY 입력 (Anthropic)",
                                value=app.storage.user.get("anthropic_api_key", ""),
                                password=True,
                            ).props("dense outlined clearable").style(
                                "margin-top:10px; width:100%; font-size:12px; font-family:inherit;"
                            )
                        else:
                            app.storage.user["api_provider"] = "gemini"
                            app.storage.user["anthropic_api_key"] = ""
                            ui.label("Google Gemini").style(
                                "margin-top:10px; font-size:12px; font-weight:900; color:var(--color-ink-soft); "
                                "padding:8px 10px; border-radius:10px; border:1px solid var(--color-line-strong); "
                                "background:var(--bg-subtle);"
                            )

                        gemini_input = ui.input(
                            placeholder="개인 API KEY 입력 (Gemini)",
                            value=app.storage.user.get("gemini_api_key", ""),
                            password=True,
                        ).props("dense outlined clearable").style(
                            "margin-top:8px; width:100%; font-size:12px; font-family:inherit;"
                        )

                        def save_keys():
                            un = app.storage.user.get("username") or ""
                            if is_admin():
                                akey = (anthropic_input.value or "").strip() if anthropic_input else ""
                                gkey = (gemini_input.value or "").strip()
                                prov = (
                                    (provider_select.value or app.storage.user.get("api_provider") or "anthropic")
                                    if provider_select
                                    else "anthropic"
                                )
                                app.storage.user["anthropic_api_key"] = akey
                                app.storage.user["gemini_api_key"] = gkey
                                app.storage.user["api_provider"] = prov
                            else:
                                gkey = (gemini_input.value or "").strip()
                                app.storage.user["anthropic_api_key"] = ""
                                app.storage.user["gemini_api_key"] = gkey
                                app.storage.user["api_provider"] = "gemini"
                                prov = "gemini"
                                akey = ""
                            _api_vault_put(un, _snapshot_api_prefs())
                            ok = has_gemini_key(gkey) if prov == "gemini" else has_api_key(akey)
                            if ok:
                                ui.notify("API KEY 저장됨", type="positive")
                            else:
                                ui.notify(f"API KEY 형식이 올바르지 않습니다. (현재: {prov})", type="warning")

                        _inputs_bind = [gemini_input]
                        if anthropic_input:
                            _inputs_bind.append(anthropic_input)
                        for inp in _inputs_bind:
                            inp.on("keydown.enter", lambda *_: save_keys())
                            inp.on("blur", lambda *_: save_keys())
                        with ui.element("div").style(
                            "margin-top:10px; font-size:11px; font-weight:800; color:var(--color-ink-faint); "
                            "display:flex; align-items:center; flex-wrap:wrap; gap:4px;"
                        ):
                            ui.label("Gemini API KEY 발급:").style("font-weight:800;")
                            ui.link("AI Studio", "https://aistudio.google.com/app/apikey", new_tab=True).style(
                                "color:var(--color-primary); font-weight:900; text-decoration:none;"
                            )

                    sidebar_api_key_panel()

                if is_admin():
                    admin_dialog = ui.dialog()

                    @ui.refreshable
                    def admin_mgmt_body():
                        # 표·그래프 HTML은 관리자 전용 서버 생성물 — DOMPurify가 테이블을 건드리면 빈 화면이 될 수 있음
                        ui.html(_build_admin_management_dashboard_html(), sanitize=False)

                    with admin_dialog:
                        # flex:1만 주면 부모 높이가 auto일 때 스크롤 영역이 0px이 되어 본문이 안 보임 → height 고정
                        with ui.card().style(
                            # 관리자 페이지는 표/그래프가 많아 가로 공간을 넉넉히 사용
                            "width:min(1400px, 98vw); max-width:1400px; height:min(90vh, 920px); "
                            "display:flex; flex-direction:column; padding:0; overflow:hidden;"
                        ):
                            with ui.element("div").style(
                                "display:flex; align-items:center; justify-content:space-between; gap:12px; "
                                "padding:14px 16px; border-bottom:1px solid var(--color-line-strong); background:var(--bg-subtle); flex-shrink:0;"
                            ):
                                ui.label("페이지 관리").style("font-size:17px; font-weight:900; color:var(--color-ink);")
                                with ui.element("div").style("display:flex; gap:8px; align-items:center;"):
                                    ui.button("새로고침", on_click=admin_mgmt_body.refresh).props("flat dense").style(
                                        "font-weight:900; color:var(--color-ink-soft) !important;"
                                    )
                                    ui.button("닫기", on_click=admin_dialog.close).props("unelevated dense").style(
                                        "font-weight:900; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                        "border:1px solid var(--color-line-strong);"
                                    )
                            with ui.scroll_area().style("flex:1; min-height:200px; width:100%;"):
                                with ui.element("div").style("padding:14px 16px 24px; box-sizing:border-box;"):
                                    # ── 관리자 탭 UI ─────────────────────────────
                                    admin_tabs = ui.tabs().props("dense").style("margin-bottom:10px;")
                                    with admin_tabs:
                                        ui.tab("설명")
                                        ui.tab("도구")
                                        ui.tab("대시보드")

                                    with ui.tab_panels(admin_tabs, value="설명").props("animated").style("width:100%;"):
                                        with ui.tab_panel("설명"):
                                            with ui.element("div").style(
                                                "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:14px; "
                                                "padding:14px 14px; box-shadow:var(--shadow-card);"
                                            ):
                                                ui.label("페이지 관리 기능 설명").style(
                                                    "font-size:14px; font-weight:900; color:var(--color-ink);"
                                                )
                                                ui.html(
                                                    "<div style='margin-top:8px; font-size:12px; color:var(--color-ink-soft); line-height:1.6;'>"
                                                    "<div><b>도구</b>: 보관함/최근작업/생성로그 초기화, outputs 고아 PDF 정리</div>"
                                                    "<div style='margin-top:4px;'><b>대시보드</b>: 계정 목록, 생성 통계(학년/과목/차시), 최근 생성 로그</div>"
                                                    "<div style='margin-top:8px; color:var(--color-ink-muted); font-weight:700;'>"
                                                    "※ '고아 PDF 정리'는 되돌릴 수 없는 파일 삭제 기능입니다."
                                                    "</div></div>"
                                                )

                                        with ui.tab_panel("도구"):
                                            @ui.refreshable
                                            def admin_tools_panel():
                                                refs = _admin_collect_storage_refs()
                                                out_pdfs = _admin_list_outputs_pdfs(limit=120)
                                                accounts = load_accounts(_ACCOUNTS_PATH)
                                                deletable_users = sorted(
                                                    [u for u in accounts.keys() if u and (u not in _ADMIN_USERS)],
                                                    key=str.lower,
                                                )
                                                # summary
                                                with ui.element("div").style(
                                                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:14px; "
                                                    "padding:14px 14px; box-shadow:var(--shadow-card); margin-bottom:14px;"
                                                ):
                                                    ui.label("관리 도구").style(
                                                        "font-size:12px; font-weight:900; color:var(--color-ink); letter-spacing:-0.02em;"
                                                    )
                                                    ui.label(
                                                        f"outputs PDF {len(out_pdfs)}개 · 보관함 참조 {len(refs['archive'])}개 · 생성로그 참조 {len(refs['stats'])}개"
                                                    ).style("font-size:11px; color:var(--color-ink-soft); margin-top:4px; font-weight:700;")

                                                    with ui.row().style("gap:10px; flex-wrap:wrap; margin-top:10px;"):
                                                        # 보관함 비우기
                                                        def clear_archive_all():
                                                            dlg = ui.dialog()
                                                            with dlg:
                                                                with ui.card().style("width:min(520px,92vw); padding:18px;"):
                                                                    ui.label("보관함 전체 비우기").style("font-size:16px; font-weight:900;")
                                                                    ui.label("모든 사용자 보관함 목록을 비웁니다. 파일은 삭제하지 않습니다.").style(
                                                                        "font-size:12px; color:var(--color-ink-soft); margin-top:6px;"
                                                                    )
                                                                    with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                                        ui.button("취소", on_click=dlg.close).props("unelevated").style(
                                                                            "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                                            "border:1px solid var(--color-line-strong); font-weight:900;"
                                                                        )
                                                                        def _do():
                                                                            n = _admin_clear_user_archive(None)
                                                                            ui.notify(f"보관함 {n}개 항목 비움", type="positive")
                                                                            dlg.close()
                                                                            admin_tools_panel.refresh()
                                                                            admin_mgmt_body.refresh()
                                                                        ui.button("비우기", on_click=_do).props("dense unelevated").style(
                                                                            "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                                        )
                                                            dlg.open()

                                                        ui.button("보관함 전체 비우기", on_click=clear_archive_all).props("unelevated").style(
                                                            "border-radius:12px; font-weight:900; background:var(--bg-canvas); "
                                                            "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                                        )

                                                        # 최근 작업 이력 초기화
                                                        def clear_history():
                                                            dlg = ui.dialog()
                                                            with dlg:
                                                                with ui.card().style("width:min(520px,92vw); padding:18px;"):
                                                                    ui.label("최근 작업 초기화").style("font-size:16px; font-weight:900;")
                                                                    ui.label("`_lesson_history.json`을 비웁니다.").style(
                                                                        "font-size:12px; color:var(--color-ink-soft); margin-top:6px;"
                                                                    )
                                                                    with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                                        ui.button("취소", on_click=dlg.close).props("unelevated").style(
                                                                            "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                                            "border:1px solid var(--color-line-strong); font-weight:900;"
                                                                        )
                                                                        def _do():
                                                                            n = _admin_clear_history()
                                                                            ui.notify(f"최근 작업 {n}개 단원 이력 삭제", type="positive")
                                                                            dlg.close()
                                                                            admin_tools_panel.refresh()
                                                                            admin_mgmt_body.refresh()
                                                                        ui.button("초기화", on_click=_do).props("dense unelevated").style(
                                                                            "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                                        )
                                                            dlg.open()

                                                        ui.button("최근 작업 초기화", on_click=clear_history).props("unelevated").style(
                                                            "border-radius:12px; font-weight:900; background:var(--bg-canvas); "
                                                            "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                                        )

                                                        # 생성 로그 초기화
                                                        def clear_gen_stats():
                                                            dlg = ui.dialog()
                                                            with dlg:
                                                                with ui.card().style("width:min(520px,92vw); padding:18px;"):
                                                                    ui.label("생성 로그 초기화").style("font-size:16px; font-weight:900;")
                                                                    ui.label("`_worksheet_generation_stats.json`을 비웁니다.").style(
                                                                        "font-size:12px; color:var(--color-ink-soft); margin-top:6px;"
                                                                    )
                                                                    with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                                        ui.button("취소", on_click=dlg.close).props("unelevated").style(
                                                                            "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                                            "border:1px solid var(--color-line-strong); font-weight:900;"
                                                                        )
                                                                        def _do():
                                                                            n = _admin_clear_generation_stats()
                                                                            ui.notify(f"생성 로그 {n}건 삭제", type="positive")
                                                                            dlg.close()
                                                                            admin_tools_panel.refresh()
                                                                            admin_mgmt_body.refresh()
                                                                        ui.button("초기화", on_click=_do).props("dense unelevated").style(
                                                                            "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                                        )
                                                            dlg.open()

                                                        ui.button("생성 로그 초기화", on_click=clear_gen_stats).props("unelevated").style(
                                                            "border-radius:12px; font-weight:900; background:var(--bg-canvas); "
                                                            "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                                        )

                                                # 회원 관리 — 탈퇴(계정 삭제)
                                                with ui.element("div").style(
                                                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:14px; "
                                                    "padding:14px 14px; box-shadow:var(--shadow-card); margin-bottom:14px;"
                                                ):
                                                    ui.label("회원 관리").style(
                                                        "font-size:12px; font-weight:900; color:var(--color-ink); letter-spacing:-0.02em;"
                                                    )
                                                    ui.label("관리자가 회원을 탈퇴(계정 삭제)시킬 수 있습니다. (환경변수 계정/관리자 계정 제외)").style(
                                                        "font-size:11px; color:var(--color-ink-soft); margin-top:4px; font-weight:700;"
                                                    )
                                                    if "admin_delete_user_target" not in app.storage.user:
                                                        app.storage.user["admin_delete_user_target"] = ""
                                                    target_sel = ui.select(
                                                        options=[""] + deletable_users,
                                                        value=app.storage.user.get("admin_delete_user_target", ""),
                                                        on_change=lambda e: app.storage.user.__setitem__(
                                                            "admin_delete_user_target", str(getattr(e, "value", "") or "")
                                                        ),
                                                    ).props("dense outlined").style("margin-top:10px; width:100%; font-size:12px;")

                                                    def _do_delete_user():
                                                        tgt = (app.storage.user.get("admin_delete_user_target") or "").strip()
                                                        if not tgt:
                                                            ui.notify("탈퇴시킬 회원을 선택하세요.", type="warning")
                                                            return
                                                        if tgt in _ADMIN_USERS:
                                                            ui.notify("관리자 계정은 탈퇴시킬 수 없습니다.", type="warning")
                                                            return
                                                        dlg = ui.dialog()
                                                        with dlg:
                                                            with ui.card().style("width:min(560px,92vw); padding:18px;"):
                                                                ui.label("회원 탈퇴(계정 삭제)").style("font-size:16px; font-weight:900;")
                                                                ui.label(
                                                                    f"'{tgt}' 계정을 삭제합니다. 이 계정으로 다시 로그인할 수 없게 됩니다."
                                                                ).style("font-size:12px; color:var(--color-ink-soft); margin-top:6px; line-height:1.5;")
                                                                ui.label("관련 데이터(보관함/최근작업/API 금고)도 함께 정리됩니다.").style(
                                                                    "font-size:12px; color:var(--color-ink-soft); margin-top:6px;"
                                                                )
                                                                with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                                    ui.button("취소", on_click=dlg.close).props("unelevated").style(
                                                                        "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                                        "border:1px solid var(--color-line-strong); font-weight:900;"
                                                                    )

                                                                    def _confirm():
                                                                        ok, msg = delete_user(_ACCOUNTS_PATH, tgt)
                                                                        if not ok:
                                                                            ui.notify(f"삭제 실패: {msg}", type="negative")
                                                                            dlg.close()
                                                                            return
                                                                        _admin_remove_user_from_archive(tgt)
                                                                        _admin_remove_user_from_history(tgt)
                                                                        _admin_remove_user_from_api_vault(tgt)
                                                                        ui.notify(f"'{tgt}' 계정이 삭제되었습니다.", type="positive")
                                                                        app.storage.user["admin_delete_user_target"] = ""
                                                                        dlg.close()
                                                                        admin_tools_panel.refresh()
                                                                        admin_mgmt_body.refresh()

                                                                    ui.button("탈퇴 처리", on_click=_confirm).props("dense unelevated").style(
                                                                        "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                                    )
                                                        dlg.open()

                                                    ui.button("선택 회원 탈퇴", on_click=_do_delete_user).props("unelevated").style(
                                                        "margin-top:10px; border-radius:12px; font-weight:900; background:#EF4444; "
                                                        "color:white !important;"
                                                    )

                                                # outputs 정리(고아 PDF 삭제)
                                                with ui.element("div").style("margin-top:12px; border-top:1px solid var(--color-line); padding-top:12px;"):
                                                    ui.label("스토리지 정리").style("font-size:12px; font-weight:900; color:var(--color-ink);")
                                                    ui.label("참조되지 않는(보관함/로그/이력 어디에도 없는) outputs PDF를 정리합니다.").style(
                                                        "font-size:11px; color:var(--color-ink-soft); margin-top:4px; font-weight:700;"
                                                    )

                                                    def purge_orphan_outputs():
                                                        refs_any = refs["any"]
                                                        all_rows = _admin_list_outputs_pdfs(limit=2000)
                                                        orphans = [r["rel"] for r in all_rows if (r.get("rel") or "") and (r["rel"] not in refs_any)]
                                                        if not orphans:
                                                            ui.notify("정리할 고아 PDF가 없습니다.", type="positive")
                                                            return
                                                        dlg = ui.dialog()
                                                        with dlg:
                                                            with ui.card().style("width:min(620px,92vw); padding:18px;"):
                                                                ui.label("고아 PDF 삭제").style("font-size:16px; font-weight:900;")
                                                                ui.label(
                                                                    f"현재 참조가 없는 PDF {len(orphans)}개를 outputs에서 삭제합니다. 되돌릴 수 없습니다."
                                                                ).style("font-size:12px; color:var(--color-ink-soft); margin-top:6px; line-height:1.5;")
                                                                ui.element("div").style("height:8px;")
                                                                sample = orphans[:8]
                                                                ui.html(
                                                                    "<div style='font-size:11px;color:var(--color-ink-muted);font-weight:800;'>예시</div>"
                                                                    + "<div class='mono' style='margin-top:6px;font-size:11px;white-space:pre-wrap;'>"
                                                                    + escape("\n".join(sample))
                                                                    + ("\\n..." if len(orphans) > len(sample) else "")
                                                                    + "</div>"
                                                                )
                                                                with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                                    ui.button("취소", on_click=dlg.close).props("unelevated").style(
                                                                        "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                                        "border:1px solid var(--color-line-strong); font-weight:900;"
                                                                    )
                                                                    def _do():
                                                                        ok_cnt, failed = _delete_outputs_pdfs_by_rel(orphans)
                                                                        if failed:
                                                                            ui.notify(
                                                                                f"고아 PDF 삭제 {ok_cnt}개 완료, {len(failed)}개 실패",
                                                                                type="warning",
                                                                            )
                                                                        else:
                                                                            ui.notify(f"고아 PDF {ok_cnt}개 삭제 완료", type="positive")
                                                                        dlg.close()
                                                                        admin_tools_panel.refresh()
                                                                        admin_mgmt_body.refresh()
                                                                    ui.button("삭제", on_click=_do).props("dense unelevated").style(
                                                                        "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                                    )
                                                        dlg.open()

                                                    ui.button("고아 PDF 정리", on_click=purge_orphan_outputs).props("unelevated").style(
                                                        "margin-top:10px; border-radius:12px; font-weight:900; background:#EF4444; "
                                                        "color:white !important;"
                                                    )

                                            admin_tools_panel()

                                        with ui.tab_panel("대시보드"):
                                            admin_mgmt_body()

                    with ui.element("div").style(
                        "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-md); "
                        "padding:10px 10px; margin:0 0 14px 0; box-shadow:var(--shadow-card);"
                    ):
                        ui.label("ADMIN").style(
                            "font-size:10px; font-weight:900; color:var(--color-ink-faint); letter-spacing:0.08em; margin:0 4px 8px;"
                        )
                        ui.button(
                            "페이지 관리",
                            on_click=lambda: (admin_mgmt_body.refresh(), admin_dialog.open()),
                        ).props("unelevated color=primary").classes("w-full").style(
                            "font-weight:900; border-radius:12px; padding:12px 10px;"
                        )

                # ── Theme toggle (Light / Dark) ───────────────────────────────
                with ui.element("div").style(
                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-md); "
                    "padding:10px 10px; margin:0 0 18px 0; box-shadow:var(--shadow-card);"
                ):
                    ui.label("APPEARANCE").style("font-size:10px; font-weight:900; color:var(--color-ink-faint); letter-spacing:0.08em; margin:0 6px 8px;")
                    with ui.element("div").style("display:flex; gap:8px;"):
                        def set_theme(t: str):
                            app.storage.user["theme"] = t
                            ui.run_javascript(f"document.documentElement.dataset.theme = {t!r};")
                            ui.notify(f"테마 변경: {t}", type="info")

                        light_btn = ui.button("Light", on_click=lambda: set_theme("light")).props("unelevated dense").style(
                            "flex:1; background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong); font-weight:900; border-radius:10px;"
                        )
                        dark_btn = ui.button("Dark", on_click=lambda: set_theme("dark")).props("unelevated dense").style(
                            "flex:1; background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong); font-weight:900; border-radius:10px;"
                        )
                        # active hint
                        if theme == "dark":
                            dark_btn.style("box-shadow: 0 0 0 2px rgba(52,211,153,0.22) inset; border-color: rgba(52,211,153,0.35);")
                        else:
                            light_btn.style("box-shadow: 0 0 0 2px rgba(52,211,153,0.22) inset; border-color: rgba(52,211,153,0.35);")

                    # 최근 단원 3개 (어디서든 빠른 점프)
                    recent = []
                    try:
                        recent = _get_recent_units(limit=3, username=_username_for_storage())
                    except Exception:
                        recent = []
                    if recent:
                        ui.label("RECENT").style("margin-top:12px; font-size:10px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint);")
                        for unit_path, entry in recent:
                            time_label = _format_relative_time(entry.get("last_used", ""))

                            def make_recent_click(path=unit_path):
                                def _h():
                                    # library_page가 아직 초기화 안된 경우를 대비
                                    try:
                                        if not hasattr(library_page, "_selected_unit_path"):
                                            ui.navigate.to("/")
                                            return
                                        library_page._selected_unit_path = path
                                        # 트리 펼침 상태도 함께 세팅
                                        if hasattr(library_page, "_expanded"):
                                            expanded = library_page._expanded
                                            parts = Path(path).relative_to(_ASSETS_DIR).parts
                                            if len(parts) >= 1: expanded["grades"].add(_norm(parts[0]))
                                            if len(parts) >= 2: expanded["subjects"].add(f"{_norm(parts[0])}/{_norm(parts[1])}")
                                            if len(parts) >= 3: expanded["publishers"].add(f"{_norm(parts[0])}/{_norm(parts[1])}/{_norm(parts[2])}")
                                        ui.navigate.to("/")
                                    except Exception:
                                        ui.navigate.to("/")
                                return _h

                            btn = ui.element("button").on("click", lambda *_, fn=make_recent_click(): fn()).style(
                                "width:100%; text-align:left; padding:8px 10px; border-radius:10px; "
                                "border:1px solid var(--color-line); background:transparent; cursor:pointer; font-family:inherit; margin-top:6px;"
                            )
                            with btn:
                                ui.html(
                                    f'<div style="display:flex; align-items:center; gap:10px; pointer-events:none;">'
                                    f'<div style="width:26px; height:26px; border-radius:8px; background:var(--bg-canvas); border:1px solid var(--color-line); '
                                    f'display:flex; align-items:center; justify-content:center; font-weight:900; color:var(--color-ink-soft);">↗</div>'
                                    f'<div style="flex:1; min-width:0;">'
                                    f'<div style="font-size:12px; font-weight:900; color:var(--color-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{Path(unit_path).name}</div>'
                                    f'<div class="mono" style="font-size:10px; color:var(--color-ink-faint); margin-top:2px;">{time_label}</div>'
                                    f'</div>'
                                    f'</div>'
                                )


            with ui.element("div").style("padding-top:20px; border-top:1px solid var(--color-line);"):
                ui.label("ACCOUNT").style("font-size:10px; font-weight:700; color:var(--color-ink-faint); letter-spacing:0.05em; margin:0 10px 10px;")
                username = app.storage.user.get("username") or "—"
                sid = app.storage.user.get("session_id") or ""
                initial = (str(username)[:1] or "U").upper()

                def do_logout():
                    _on_logout_navigate_login()

                account_dialog = ui.dialog()
                with account_dialog:
                    with ui.element("div").style("padding:24px; width:min(520px, 92vw);"):
                        ui.label("계정 정보").style("font-size:18px; font-weight:900; color:var(--color-ink); margin-bottom:10px;")
                        ui.html(
                            f'<div style="display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:12px; '
                            f'border:1px solid var(--color-line-strong); background:var(--bg-subtle);">'
                            f'<div style="width:42px;height:42px;border-radius:14px;background:var(--color-primary-soft);'
                            f'border:1px solid rgba(16,185,129,0.45);display:flex;align-items:center;justify-content:center;'
                            f'font-size:14px;font-weight:900;color:var(--color-success-deep);">{initial}</div>'
                            f'<div style="flex:1; min-width:0;">'
                            f'<div style="font-size:14px; font-weight:900; color:var(--color-ink);">{username}</div>'
                            f'<div class="mono" style="font-size:11px; color:var(--color-ink-faint); margin-top:2px;">session: {sid}</div>'
                            f'</div>'
                            f'</div>'
                        )
                        ui.label("로그아웃하면 로그인 화면으로 이동합니다.").style(
                            "font-size:12px; color:var(--color-ink-soft); margin-top:12px; line-height:1.5; font-weight:700;"
                        )
                        with ui.element("div").style("display:flex; gap:10px; justify-content:flex-end; margin-top:18px;"):
                            ui.button("닫기", on_click=lambda: account_dialog.close()).props("unelevated").style(
                                "background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong); font-weight:900;"
                            )
                            ui.button("로그아웃", on_click=do_logout).props("color=primary unelevated").style("font-weight:900;")

                with ui.element("div").style(
                    "display:flex; flex-direction:column; gap:10px; padding:10px; "
                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); "
                    "border-radius:var(--radius-md); box-shadow:var(--shadow-card);"
                ):
                    with ui.element("div").style("display:flex; align-items:center; gap:12px;"):
                        ui.html(
                            f'<div style="width:38px;height:38px;border-radius:14px;background:var(--color-primary-soft);'
                            f'border:1px solid rgba(16,185,129,0.45);display:flex;align-items:center;justify-content:center;'
                            f'font-size:14px;font-weight:900;color:var(--color-success-deep);">{initial}</div>'
                        )
                        with ui.element("div").style("flex:1; min-width:0;"):
                            ui.label(str(username)).style("font-size:13px; font-weight:900; color:var(--color-ink);")
                            ui.html(
                                f'<div class="mono" style="font-size:10px; color:var(--color-ink-faint); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{sid}</div>'
                            )
                        ui.button("보기", on_click=lambda: account_dialog.open()).props("flat dense").style(
                            "font-size:11px; font-weight:900; color:var(--color-ink-soft) !important; background:transparent !important; padding:2px 8px;"
                        )

                    with ui.element("div").style("display:flex; gap:8px;"):
                        ui.button("로그아웃", on_click=do_logout).props("unelevated dense").style(
                            "flex:1; background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong); font-weight:900; border-radius:10px;"
                        )

        with ui.element("main").style("flex:1; padding:40px 56px; overflow-y:auto; min-width:0; background:var(--bg-canvas);"):
            with ui.element("div").style("max-width:1400px; width:100%; margin:0 auto;"):
                if hero is not None:
                    hero()
                with ui.element("div").classes("step-rail"):
                    for i, (idx, label, path) in enumerate(steps):
                        if i > 0:
                            ui.element("div").classes("step-rail__sep")
                        is_current = idx == current_step
                        link_cls = "step-rail__link step-rail__link--active" if is_current else "step-rail__link"
                        with ui.link(target=path).classes(link_cls):
                            ui.html(
                                f'<div class="step-rail__num">{idx}</div>'
                                f'<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{label}</span>'
                            )
                render_body()


# ============ 로그인 ============
@ui.page("/login")
def login_page():
    ui.add_head_html(f"<style>{DESIGN_CSS}</style>")

    sid = app.storage.user.get("session_id")
    if not sid:
        sid = str(uuid4())
        app.storage.user["session_id"] = sid

    if sid in _AUTH_SESSIONS and app.storage.user.get("username"):
        ui.navigate.to("/")
        return

    with ui.element("div").style(
        "width:100%; min-height:100vh; background:var(--bg-canvas); display:flex; align-items:center; justify-content:center; padding:20px 12px;"
    ):
        with ui.element("div").style(
            "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-xl); "
            "box-shadow:var(--shadow-app); padding:36px 28px 40px; width:100%; max-width:460px;"
        ):
            with ui.element("div").style("text-align:center; margin-bottom:20px;"):
                ui.html(
                    '<div style="width:56px;height:56px;background:var(--color-primary-soft);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">'
                    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
                    '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>'
                )
                ui.label("Lesson Studio").style(
                    "font-size:24px; font-weight:800; letter-spacing:-0.02em; color:var(--color-ink); margin-bottom:6px;"
                )
                ui.label("로그인 또는 회원가입").style("font-size:13px; color:var(--color-ink-soft);")

            with ui.tabs().classes("w-full") as auth_tabs:
                tab_login = ui.tab("로그인")
                tab_signup = ui.tab("회원가입")

            with ui.tab_panels(auth_tabs, value=tab_login).classes("w-full"):
                with ui.tab_panel(tab_login):
                    login_status = ui.label("").style(
                        "font-size:12px; color:var(--color-danger); min-height:18px; margin:8px 0 4px; font-weight:600;"
                    )
                    user_input = ui.input("아이디").props("outlined dense").classes("w-full").style("margin-bottom:10px;")
                    pass_input = ui.input("비밀번호", password=True, password_toggle_button=True).props("outlined dense").classes("w-full")

                    def try_login():
                        u = (user_input.value or "").strip()
                        p = pass_input.value or ""
                        login_status.set_text("")
                        if verify_password(_ACCOUNTS_PATH, u, p, _ENV_USERS):
                            _on_login_success(sid, u)
                            ui.navigate.to("/")
                        else:
                            login_status.set_text("아이디 또는 비밀번호가 올바르지 않습니다.")

                    pass_input.on("keydown.enter", try_login)
                    ui.button("로그인", on_click=try_login).props("color=primary unelevated size=lg").classes("w-full").style(
                        "margin-top:16px; border-radius:12px;"
                    )

                with ui.tab_panel(tab_signup):
                    signup_status = ui.label("").style(
                        "font-size:12px; color:var(--color-danger); min-height:18px; margin:8px 0 6px; font-weight:600;"
                    )
                    su_user = ui.input("아이디 (3~32자, 한글·영문·숫자·._-)").props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_pass = ui.input("비밀번호 (8자 이상)", password=True, password_toggle_button=True).props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_pass2 = ui.input("비밀번호 확인", password=True, password_toggle_button=True).props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_name = ui.input("이름").props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_rrn = ui.input("주민등록번호 (예: 990101-1234567)").props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_phone = ui.input("전화번호 (예: 010-1234-5678)").props("outlined dense").classes("w-full").style("margin-bottom:8px;")
                    su_email = ui.input("이메일 (선택)").props("outlined dense").classes("w-full").style("margin-bottom:4px;")

                    def try_signup():
                        signup_status.set_text("")
                        ok, msg = register_new_user(
                            _ACCOUNTS_PATH,
                            (su_user.value or "").strip(),
                            su_pass.value or "",
                            su_pass2.value or "",
                            (su_name.value or "").strip(),
                            su_rrn.value or "",
                            su_phone.value or "",
                            (su_email.value or "").strip(),
                        )
                        if ok:
                            ui.notify("가입이 완료되었습니다. 「로그인」 탭에서 로그인하세요.", type="positive")
                            su_user.value = ""
                            su_pass.value = ""
                            su_pass2.value = ""
                            su_name.value = ""
                            su_rrn.value = ""
                            su_phone.value = ""
                            su_email.value = ""
                        else:
                            signup_status.set_text(msg)

                    ui.button("회원가입", on_click=try_signup).props("color=primary unelevated size=lg").classes("w-full").style(
                        "margin-top:14px; border-radius:12px;"
                    )


# ============ 1. 라이브러리 ============
@ui.page("/")
def library_page():
    if require_auth() is None: return

    # 펼침 상태는 페이지 단위로 유지 (refresh되어도 유지하기 위해 모듈 변수 사용)
    if not hasattr(library_page, "_expanded"):
        library_page._expanded = {"grades": set(), "subjects": set(), "publishers": set()}
    expanded = library_page._expanded

    # 현재 선택된 단원 폴더 경로 (선택만, 아직 state에는 안 박음)
    if not hasattr(library_page, "_selected_unit_path"):
        library_page._selected_unit_path = None

    # 드롭다운 선택 상태
    if not hasattr(library_page, "_dd_grade"):
        library_page._dd_grade = None
    if not hasattr(library_page, "_dd_subject"):
        library_page._dd_subject = None
    if not hasattr(library_page, "_dd_semester"):
        library_page._dd_semester = "전체"
    if not hasattr(library_page, "_dd_publisher"):
        library_page._dd_publisher = "전체"
    if not hasattr(library_page, "_dd_query"):
        library_page._dd_query = ""

    # 검색어
    if not hasattr(library_page, "_search_query"):
        library_page._search_query = ""

    # 최근 작업/보관함 선택 상태(페이지 내 유지)
    if not hasattr(library_page, "_recent_selected"):
        library_page._recent_selected = set()
    if not hasattr(library_page, "_archive_selected"):
        library_page._archive_selected = set()

    @ui.refreshable
    def page_content():
        session = get_session()
        full_library = _scan_library()
        # 검색 필터 적용
        library = _filter_library(full_library, library_page._search_query)
        # 검색 결과는 자동으로 모두 펼침
        if library_page._search_query:
            for g in library:
                expanded["grades"].add(g["grade_label"])
                for s in g["subjects"]:
                    expanded["subjects"].add(f"{g['grade_label']}/{s['subject']}")
                    for p in s["publishers"]:
                        expanded["publishers"].add(f"{g['grade_label']}/{s['subject']}/{p['publisher']}")

        def render_hero():
            with ui.element("div").classes("page-hero"):
                ui.label("STEP 1 / 4").style("font-size:12px; font-weight:800; color:var(--color-primary); letter-spacing:0.05em; margin-bottom:8px;")
                ui.label("자료 라이브러리").style("font-size:32px; font-weight:800; letter-spacing:-0.03em; color:var(--color-ink); margin-bottom:8px;")
                ui.label("학년·과목·출판사 폴더를 펼쳐 작업할 단원을 선택하세요.").style("font-size:15px; color:var(--color-ink-soft); line-height:1.5;")

        def render_body():
            # ── 라이브러리가 비어있을 때 ──────────────────────
            if not full_library:
                _render_empty_library_guide()
                return

            # ── 상단 2열: 최근 작업(좁음·4건) · 이 페이지 사용 설명서(넓음) — 접기/펼치기 ─
            uname = _username_for_storage()
            recent = _get_recent_units(limit=10, username=uname)
            recent_visible: list[tuple] = []
            for unit_path, entry in recent:
                u, bc = _resolve_unit_meta(full_library, unit_path)
                if u and bc:
                    recent_visible.append((unit_path, u, bc, entry))
            recent_visible = recent_visible[:10]
            recent_exp = bool(app.storage.user.get("library_recent_panel_expanded", True))
            guide_exp = bool(app.storage.user.get("library_guide_panel_expanded", True))
            archive_exp = bool(app.storage.user.get("library_archive_panel_expanded", True))

            def _toggle_recent_panel():
                app.storage.user["library_recent_panel_expanded"] = not bool(
                    app.storage.user.get("library_recent_panel_expanded", True)
                )
                page_content.refresh()

            def _toggle_guide_panel():
                app.storage.user["library_guide_panel_expanded"] = not bool(
                    app.storage.user.get("library_guide_panel_expanded", True)
                )
                page_content.refresh()

            def _toggle_archive_panel():
                app.storage.user["library_archive_panel_expanded"] = not bool(
                    app.storage.user.get("library_archive_panel_expanded", True)
                )
                page_content.refresh()

            _card_base = (
                "background:var(--bg-surface); border-radius:var(--radius-lg); border:1px solid var(--color-line-strong); "
                "box-shadow:var(--shadow-card); display:flex; flex-direction:column; overflow:hidden;"
            )

            # ── 이 페이지 사용 방법 (상단 전체 너비) ──
            with ui.element("div").style("width:100%; margin-bottom:14px;"):
                with ui.element("div").style(_card_base + "padding:12px 16px; min-height:0; width:100%;"):
                    with ui.element("div").style(
                        "display:flex; align-items:center; justify-content:space-between; gap:8px; flex-shrink:0; margin-bottom:8px;"
                    ):
                        with ui.element("div").style("display:flex; align-items:center; gap:8px; min-width:0;"):
                            ui.html('<span style="font-size:14px;">📖</span>')
                            ui.label("이 페이지 사용 방법").style(
                                "font-size:13px; font-weight:900; color:var(--color-ink); letter-spacing:-0.02em;"
                            )
                        ui.button("▼" if guide_exp else "▶", on_click=_toggle_guide_panel).props(
                            "flat dense round"
                        ).style(
                            "min-width:32px; min-height:32px; padding:0; font-size:12px; font-weight:900; "
                            "color:var(--color-ink-soft) !important; background:var(--bg-subtle) !important;"
                        )
                    if guide_exp:
                        _guide_steps = [
                            (
                                "1",
                                "범위 좁히기",
                                "아래 자료 탐색 영역 왼쪽 상단의 학년·과목·출판사 드롭다운으로 단원 목록을 좁힙니다.",
                            ),
                            (
                                "2",
                                "단원 선택",
                                "왼쪽 목록에서 작업할 단원 폴더를 클릭합니다. 가운데에 교과서·지도서·교육과정 미리보기가 열립니다.",
                            ),
                            (
                                "3",
                                "내용 확인",
                                "가운데 미리보기와 오른쪽 단원 정보에서 파일이 맞는지 확인합니다.",
                            ),
                            (
                                "4",
                                "다음 단계로",
                                "오른쪽 하단 「페이지 그룹화 진행」으로 이동합니다. (교과서가 있어야 버튼이 활성화됩니다.)",
                            ),
                            (
                                "5",
                                "API 키",
                                "왼쪽 사이드바에 Gemini API KEY를 넣어야 이후 「생성」단계에서 AI가 동작합니다.",
                            ),
                            (
                                "6",
                                "보관함",
                                "오른쪽 「자료 보관함」에서 이 계정으로 만든 PDF를 다시 받을 수 있습니다. ⌘K(또는 Ctrl+K)로 다른 단계로도 이동할 수 있어요.",
                            ),
                        ]
                        with ui.element("div").style(
                            "display:flex; flex-direction:column; gap:10px; max-height:min(320px, 38vh); overflow-y:auto; padding-right:4px;"
                        ):
                            for num, title, body in _guide_steps:
                                with ui.element("div").style(
                                    "display:flex; gap:10px; align-items:flex-start; padding:8px 10px; "
                                    "border-radius:10px; border:1px solid var(--color-line); background:var(--bg-canvas);"
                                ):
                                    ui.html(
                                        f'<div style="flex-shrink:0; width:24px; height:24px; border-radius:8px; '
                                        f'background:var(--color-primary-soft); color:var(--color-success-deep); '
                                        f'font-size:11px; font-weight:900; display:flex; align-items:center; justify-content:center;">'
                                        f"{escape(num)}</div>"
                                    )
                                    with ui.element("div").style("min-width:0; flex:1;"):
                                        ui.label(title).style(
                                            "font-size:12px; font-weight:900; color:var(--color-ink); display:block;"
                                        )
                                        ui.label(body).style(
                                            "font-size:11px; color:var(--color-ink-soft); font-weight:600; "
                                            "line-height:1.5; margin-top:2px; display:block;"
                                        )

            # (최근 작업/자료 보관함은 화면 하단으로 이동)

            async def go_next():
                # 관리자 제외: 개인 API KEY 없으면 grouping 진입 전에 안내 팝업
                if not is_admin():
                    provider, k = _effective_provider_and_key()
                    ok_key = has_gemini_key(k) if provider == "gemini" else has_api_key(k)
                    if not ok_key:
                        warn_dialog = ui.dialog()
                        with warn_dialog, ui.card().style(
                            "background:var(--bg-surface); border-radius:var(--radius-lg); padding:24px 26px; "
                            "box-shadow:var(--shadow-app); min-width:360px; max-width:min(520px, 92vw);"
                        ):
                            ui.label("개인 API KEY가 필요합니다").style(
                                "font-size:16px; font-weight:900; color:var(--color-ink);"
                            )
                            ui.label("사이드바에서 본인의 API KEY를 입력한 후 다시 진행해 주세요.").style(
                                "margin-top:8px; font-size:13px; color:var(--color-ink-soft); line-height:1.5; font-weight:700;"
                            )
                            with ui.element("div").style("margin-top:14px; display:flex; justify-content:flex-end;"):
                                ui.button("확인", on_click=lambda: warn_dialog.close()).props("unelevated").style(
                                    "border-radius:12px; font-weight:900; background:var(--bg-canvas); "
                                    "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                )
                        warn_dialog.open()
                        return

                unit = _find_unit_by_path(full_library, library_page._selected_unit_path)
                if not unit or not unit["files"]["textbook"]:
                    ui.notify("교과서 PDF가 있는 단원을 선택해 주세요.", type="warning")
                    return
                grade_label, subject_label, publisher_label = _find_unit_breadcrumb(
                    full_library, library_page._selected_unit_path
                )

                # 학년 번호 추출 (예: "5학년" → 5)
                grade_no = 0
                gm = _GRADE_RE.match(_norm(grade_label))
                if gm:
                    grade_no = int(gm.group(1))

                # 로딩 다이얼로그 표시 — 작업 3
                loading_dialog = ui.dialog().props("persistent")
                with loading_dialog, ui.card().style(
                    "background:var(--bg-surface); border-radius:var(--radius-lg); padding:32px 40px; "
                    "box-shadow:var(--shadow-app); display:flex; flex-direction:column; align-items:center; gap:18px; min-width:320px;"
                ):
                    ui.spinner(size="3em", color="primary")
                    ui.label("자료 불러오는 중…").style(
                        "font-size:15px; font-weight:700; color:var(--color-ink); margin-top:6px;"
                    )
                    ui.label(f"{grade_label} · {subject_label} ({publisher_label})").style(
                        "font-size:12px; color:var(--color-ink-soft); text-align:center;"
                    )
                    ui.label(unit["label"]).style(
                        "font-size:11px; color:var(--color-ink-faint); text-align:center;"
                    )
                loading_dialog.open()
                # 다이얼로그가 실제로 그려질 시간 확보
                await asyncio.sleep(0.05)

                try:
                    # 무거운 작업 (PDF 읽기 + 썸네일)을 별도 스레드로
                    ok = await asyncio.to_thread(
                        _load_unit_to_session, session, unit, subject_label, grade_no
                    )
                    if not ok:
                        loading_dialog.close()
                        ui.notify("자료를 읽지 못했습니다.", type="negative")
                        return
                    # 단원 사용 기록
                    _record_unit_use(library_page._selected_unit_path)
                    # 자동 매칭된 교육과정 알림
                    curr_msg = ""
                    if session.curriculum_filename:
                        unit_curr = unit["files"].get("curriculum")
                        if not unit_curr:
                            curr_msg = f" (교육과정 자동 매칭: {session.curriculum_filename})"
                    ui.notify(
                        f"{grade_label} {subject_label} ({publisher_label}) {unit['label']} 불러옴{curr_msg}",
                        type="positive",
                    )
                    loading_dialog.close()
                    ui.navigate.to("/grouping")
                except Exception as exc:
                    loading_dialog.close()
                    ui.notify(f"오류: {exc}", type="negative")
                    print(f"[go_next 오류] {exc}")

            # ── 상단: 필터 바(학년/과목/학기/출판사) — 페이지 상단(풀폭) ───────
            with ui.element("div").style(
                "display:flex; align-items:center; gap:10px; padding:10px 12px; "
                "background:var(--bg-subtle); border-radius:12px; border:1px solid var(--color-line); "
                "box-shadow:var(--shadow-card); margin-bottom:10px;"
            ):
                ui.html('<span style="font-size:14px; color:var(--color-ink-faint);">🧭</span>')

                grade_options = ["전체"] + [g["grade_label"] for g in full_library]
                if library_page._dd_grade not in grade_options:
                    library_page._dd_grade = "전체"

                # 과목 옵션(학년 전체면 전체 학년의 과목 합집합)
                subj_set = []
                if library_page._dd_grade == "전체":
                    for g in full_library:
                        for s in g["subjects"]:
                            subj_set.append(s["subject"])
                else:
                    gsel = next((g for g in full_library if g["grade_label"] == library_page._dd_grade), None)
                    for s in (gsel["subjects"] if gsel else []):
                        subj_set.append(s["subject"])
                subject_options = ["전체"] + sorted({x for x in subj_set if x})
                if library_page._dd_subject not in subject_options:
                    library_page._dd_subject = "전체"

                # 학기/출판사 옵션(학년/과목 기준 + 학기 필터 반영)
                pub_set = []
                sem_set = []
                for g in full_library:
                    if library_page._dd_grade != "전체" and g["grade_label"] != library_page._dd_grade:
                        continue
                    for s in g["subjects"]:
                        if library_page._dd_subject != "전체" and s["subject"] != library_page._dd_subject:
                            continue
                        for p in s["publishers"]:
                            sem_set.append(p.get("semester") or "")
                            if library_page._dd_semester and library_page._dd_semester != "전체":
                                if (p.get("semester") or "") != library_page._dd_semester:
                                    continue
                            pub_set.append(p.get("publisher", ""))
                semester_options = ["전체"] + sorted({x for x in sem_set if x})
                if library_page._dd_semester not in semester_options:
                    library_page._dd_semester = "전체"
                publisher_options = ["전체"] + sorted({x for x in pub_set if x})
                if library_page._dd_publisher not in publisher_options:
                    library_page._dd_publisher = "전체"

                def on_grade_change(e):
                    v = getattr(e, "value", None)
                    if v is None:
                        v = getattr(e, "args", "") or ""
                    library_page._dd_grade = str(v or "").strip() or None
                    if library_page._dd_grade not in grade_options:
                        library_page._dd_grade = "전체"
                    library_page._dd_subject = "전체"
                    library_page._dd_semester = "전체"
                    library_page._dd_publisher = "전체"
                    page_content.refresh()

                def on_subject_change(e):
                    v = getattr(e, "value", None)
                    if v is None:
                        v = getattr(e, "args", "") or ""
                    library_page._dd_subject = str(v or "").strip() or None
                    if library_page._dd_subject not in subject_options:
                        library_page._dd_subject = "전체"
                    library_page._dd_semester = "전체"
                    library_page._dd_publisher = "전체"
                    page_content.refresh()

                def on_semester_change(e):
                    v = getattr(e, "value", None)
                    if v is None:
                        v = getattr(e, "args", "") or ""
                    library_page._dd_semester = str(v or "").strip() or "전체"
                    if library_page._dd_semester not in semester_options:
                        library_page._dd_semester = "전체"
                    library_page._dd_publisher = "전체"
                    page_content.refresh()

                def on_publisher_change(e):
                    v = getattr(e, "value", None)
                    if v is None:
                        v = getattr(e, "args", "") or ""
                    library_page._dd_publisher = str(v or "").strip() or "전체"
                    if library_page._dd_publisher not in publisher_options:
                        library_page._dd_publisher = "전체"
                    page_content.refresh()

                ui.select(
                    options=grade_options or ["전체"],
                    value=library_page._dd_grade or "전체",
                    on_change=on_grade_change,
                ).props("dense outlined").style("width:170px; min-width:150px; font-size:13px;")

                ui.select(
                    options=subject_options or ["전체"],
                    value=library_page._dd_subject or "전체",
                    on_change=on_subject_change,
                ).props("dense outlined").style("width:170px; min-width:150px; font-size:13px;")

                ui.select(
                    options=semester_options or ["전체"],
                    value=library_page._dd_semester or "전체",
                    on_change=on_semester_change,
                ).props("dense outlined").style("width:150px; min-width:130px; font-size:13px;")

                ui.select(
                    options=publisher_options or ["전체"],
                    value=library_page._dd_publisher or "전체",
                    on_change=on_publisher_change,
                ).props("dense outlined").style("width:200px; min-width:180px; font-size:13px;")

                ui.element("div").style("flex:1;")

            # ── 메인: 3단(Left/Center/Right) 워크스테이션 레이아웃 ─────────
            with ui.element("div").style(
                "display:grid; grid-template-columns:320px 1fr 360px; gap:14px; "
                "background:var(--bg-surface); border-radius:var(--radius-lg); border:1px solid var(--color-line-strong); "
                "box-shadow:var(--shadow-card); padding:8px; min-height:560px; margin-bottom:20px;"
            ):
                # ── 좌측: 단원 리스트 ──
                with ui.element("div").style("display:flex; flex-direction:column; min-height:0;"):
                    # 단원 목록(검색 포함)
                    with ui.element("div").style(
                        "background:var(--bg-subtle); border-radius:12px; padding:10px 8px; "
                        "overflow-y:auto; max-height:600px; flex:1; min-height:0;"
                    ):
                        with ui.element("div").style("display:flex; align-items:center; gap:8px; padding:6px 6px 10px 6px;"):
                            ui.html('<span style="font-size:13px; color:var(--color-ink-faint);">🔎</span>')

                            @ui.refreshable
                            def render_units():
                                # 선택된 학년/과목 기준으로 unit flatten
                                units_flat: list[tuple[str, dict, str]] = []
                                for g in full_library:
                                    if library_page._dd_grade != "전체" and g["grade_label"] != library_page._dd_grade:
                                        continue
                                    for s in g["subjects"]:
                                        if library_page._dd_subject != "전체" and s["subject"] != library_page._dd_subject:
                                            continue
                                        for pub in s["publishers"]:
                                            sem = pub.get("semester") or ""
                                            if library_page._dd_semester and library_page._dd_semester != "전체":
                                                if sem != library_page._dd_semester:
                                                    continue
                                            pub_label = pub.get("publisher", "")
                                            if library_page._dd_publisher and library_page._dd_publisher != "전체":
                                                if pub_label != library_page._dd_publisher:
                                                    continue
                                            disp_pub = (f"{sem} · {pub_label}" if sem else pub_label) or "—"
                                            for unit in pub["units"]:
                                                units_flat.append((str(unit["path"]), unit, disp_pub))

                                q = (library_page._dd_query or "").strip().lower()
                                if q:
                                    def _hit(u: dict, pub_label: str) -> bool:
                                        return (q in _norm(u.get("label", "")).lower()) or (q in _norm(u.get("unit_name", "")).lower()) or (q in _norm(pub_label).lower())
                                    units_flat = [(p, u, pub) for (p, u, pub) in units_flat if _hit(u, pub)]

                                if not units_flat:
                                    ui.label("선택한 학년/과목에 단원이 없습니다.").style(
                                        "font-size:13px; color:var(--color-ink-faint); padding:24px 16px; text-align:center;"
                                    )
                                else:
                                    for upath, unit, pub_label in units_flat:
                                        is_selected = (library_page._selected_unit_path == upath)
                                        has_textbook = unit["files"]["textbook"] is not None

                                        def make_unit_click(path=upath):
                                            def _h():
                                                library_page._selected_unit_path = path
                                                page_content.refresh()
                                            return _h

                                        card = ui.element("button").on("click", lambda *_, fn=make_unit_click(): fn()).style(
                                            "width:100%; text-align:left; padding:10px 10px; border-radius:12px; "
                                            f"border:1px solid {'rgba(16,185,129,0.40)' if is_selected else 'var(--color-line)'}; "
                                            f"background:{'rgba(16,185,129,0.10)' if is_selected else 'var(--bg-surface)'}; "
                                            "cursor:pointer; font-family:inherit; margin:6px 4px; box-shadow:var(--shadow-card);"
                                        )
                                        with card:
                                            badge = "🟢" if has_textbook else "🟠"
                                            badge_txt = "교과서 OK" if has_textbook else "교과서 없음"
                                            ui.html(
                                                f"<div style='display:flex; align-items:flex-start; gap:10px; pointer-events:none;'>"
                                                f"<div style='width:28px; height:28px; border-radius:10px; background:var(--bg-canvas); border:1px solid var(--color-line); "
                                                f"display:flex; align-items:center; justify-content:center; font-weight:900; color:var(--color-ink-soft);'>{badge}</div>"
                                                f"<div style='flex:1; min-width:0;'>"
                                                f"<div style='font-size:13px; font-weight:900; color:var(--color-ink); line-height:1.25; "
                                                f"overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'>{unit.get('label','')}</div>"
                                                f"<div style='font-size:11px; color:var(--color-ink-soft); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'>"
                                                f"{pub_label} · {badge_txt}</div>"
                                                f"</div></div>"
                                            )

                            def on_dd_query(e):
                                v = getattr(e, "value", None)
                                if v is None:
                                    v = getattr(e, "args", "") or ""
                                library_page._dd_query = str(v or "")
                                # 전체 페이지를 refresh하면 input 포커스가 끊기므로 목록만 갱신
                                render_units.refresh()

                            ui.input(
                                placeholder="단원/출판사 검색…",
                                value=library_page._dd_query,
                                on_change=on_dd_query,
                            ).props("dense borderless clearable").style("flex:1; font-size:12px; font-family:inherit;")

                        render_units()

                # ── Center: 선택 단원 파일(테이블) ──
                with ui.element("div").style(
                    "padding:16px 18px; display:flex; flex-direction:column; min-width:0; overflow:hidden; "
                    "border-left:1px solid var(--color-line); border-right:1px solid var(--color-line);"
                ):
                    _render_unit_center(full_library, library_page._selected_unit_path)

                # ── Right: 인스펙터(메타/썸네일/이력) ──
                with ui.element("div").style("padding:16px 18px; display:flex; flex-direction:column; min-width:0; overflow-y:auto; max-height:600px;"):
                    _render_unit_inspector(full_library, library_page._selected_unit_path)

                    # 페이지 그룹화 CTA — 교과서 썸네일(사진) 아래에 배치
                    selected_unit = _find_unit_by_path(full_library, library_page._selected_unit_path)
                    ui.element("div").style("height:10px;")
                    next_btn = ui.button("페이지 그룹화 진행 →", on_click=go_next).props(
                        "color=primary unelevated size=lg"
                    ).style("width:100%; border-radius:12px; padding:0 18px; font-weight:900;")
                    if not (selected_unit and selected_unit["files"]["textbook"]):
                        next_btn.disable()

            # ── 최근 작업(좌) · 자료 보관함(우) — 화면 맨 아래로 이동 ─────────
            archive_rows = _user_archive_pdf_entries(uname, limit=60)
            # 최근 작업/자료 보관함 패널 높이: 기존 대비 2/3로 축소
            _lib_panel_h = "min-height:min(253px, 32vh);"
            _lib_panel_pad = "padding:12px 16px;"
            _lib_scroll = "flex:1; min-height:0; max-height:min(240px, 28vh); overflow-y:auto; display:flex; flex-direction:column;"
            with ui.element("div").style(
                "display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; margin-top:18px; align-items:stretch;"
            ):
                # ── 최근 작업 ──
                with ui.element("div").style(
                    "min-width:0; display:flex; flex-direction:column; align-self:stretch;"
                ):
                    with ui.element("div").style(
                        _card_base + _lib_panel_pad + _lib_panel_h
                        + "min-width:0; width:100%; flex:1; display:flex; flex-direction:column;"
                    ):
                        with ui.element("div").style(
                            "display:flex; align-items:center; justify-content:space-between; gap:6px; flex-shrink:0; margin-bottom:8px;"
                        ):
                            with ui.element("div").style("display:flex; align-items:center; gap:6px; min-width:0;"):
                                ui.html('<span style="font-size:13px;">⭐</span>')
                                ui.label("최근 작업").style(
                                    "font-size:13px; font-weight:900; color:var(--color-ink); letter-spacing:-0.02em;"
                                )
                            with ui.row().style("gap:6px; align-items:center;"):
                                def _delete_recent_selected():
                                    sel = list(library_page._recent_selected)
                                    n = _delete_unit_history(sel, username=uname)
                                    library_page._recent_selected.clear()
                                    ui.notify(
                                        f"최근 작업 {n}개 삭제됨" if n else "삭제할 항목이 없습니다",
                                        type="positive" if n else "warning",
                                    )
                                    page_content.refresh()

                                if library_page._recent_selected:
                                    ui.button(f"삭제 {len(library_page._recent_selected)}", on_click=_delete_recent_selected).props(
                                        "dense unelevated"
                                    ).style(
                                        "background:#EF4444; color:white !important; font-weight:900; border-radius:10px; padding:0 10px; min-height:32px;"
                                    )
                                ui.button("▼" if recent_exp else "▶", on_click=_toggle_recent_panel).props(
                                    "flat dense round"
                                ).style(
                                    "min-width:32px; min-height:32px; padding:0; font-size:12px; font-weight:900; "
                                    "color:var(--color-ink-soft) !important; background:var(--bg-subtle) !important;"
                                )
                        if recent_exp:
                            # 최근 작업은 "컴팩트 리스트"로 표시 — 쓸모 없는 공간 최소화
                            with ui.element("div").style(
                                _lib_scroll
                                + "gap:6px; padding-right:4px;"
                            ):
                                if not recent_visible:
                                    ui.label("최근 단원이 없습니다.").style(
                                        "font-size:11px; color:var(--color-ink-soft); font-weight:600; line-height:1.45; padding:2px 0;"
                                    )
                                else:
                                    for upath, u, bc, entry in recent_visible:
                                        grade_l, subj_l, pub_l = bc
                                        time_label = _format_relative_time(entry["last_used"])

                                        def make_recent_click(path=upath):
                                            def _h():
                                                library_page._selected_unit_path = path
                                                parts = Path(path).relative_to(_ASSETS_DIR).parts
                                                if len(parts) >= 1:
                                                    expanded["grades"].add(_norm(parts[0]))
                                                if len(parts) >= 2:
                                                    expanded["subjects"].add(f"{_norm(parts[0])}/{_norm(parts[1])}")
                                                if len(parts) >= 3:
                                                    expanded["publishers"].add(
                                                        f"{_norm(parts[0])}/{_norm(parts[1])}/{_norm(parts[2])}"
                                                    )
                                                page_content.refresh()

                                            return _h

                                        # 자료 보관함과 같은 "회색 줄" 컴포넌트(리스트형)
                                        with ui.element("div").style(
                                            "display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px; "
                                            "border:1px solid var(--color-line); background:var(--bg-canvas); min-width:0;"
                                        ):
                                            def _toggle_recent_select(e=None, p=upath):
                                                if p in library_page._recent_selected:
                                                    library_page._recent_selected.remove(p)
                                                else:
                                                    library_page._recent_selected.add(p)
                                                page_content.refresh()

                                            ui.checkbox(
                                                value=(upath in library_page._recent_selected),
                                                on_change=_toggle_recent_select,
                                            ).props("dense").style("transform:scale(0.9);")

                                            chip = ui.element("button").on("click", lambda *_, fn=make_recent_click(): fn()).style(
                                                "flex:1; min-width:0; text-align:left; background:transparent; border:none; "
                                                "padding:0; cursor:pointer; font-family:inherit;"
                                            )
                                            with chip:
                                                ui.html(
                                                    f'<div style="pointer-events:none;">'
                                                    f'<div style="font-size:13px; font-weight:800; color:var(--color-ink); line-height:1.2; '
                                                    f'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{escape(u["label"])}</div>'
                                                    f'<div style="font-size:11px; color:var(--color-ink-soft); margin-top:2px; font-weight:600; '
                                                    f'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">'
                                                    f"{escape(grade_l)} · {escape(subj_l)} · {escape(time_label)}"
                                                    f"</div></div>"
                                                )

                # ── 자료 보관함 (이 계정 생성 PDF) — 패널 크기·스크롤 영역 최근 작업과 동일 ──
                with ui.element("div").style(
                    "min-width:0; display:flex; flex-direction:column; align-self:stretch;"
                ):
                    with ui.element("div").style(
                        _card_base + _lib_panel_pad + _lib_panel_h
                        + "min-width:0; width:100%; flex:1; display:flex; flex-direction:column;"
                    ):
                        with ui.element("div").style(
                            "display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:8px; flex-wrap:wrap; flex-shrink:0;"
                        ):
                            with ui.element("div").style("flex:1; min-width:0;"):
                                with ui.element("div").style("display:flex; align-items:center; gap:8px; flex-wrap:wrap;"):
                                    ui.html('<span style="font-size:13px;">🗄️</span>')
                                    ui.label("자료 보관함").style(
                                        "font-size:13px; font-weight:900; color:var(--color-ink); letter-spacing:-0.02em;"
                                    )
                                    ui.button("조합", on_click=lambda: ui.navigate.to("/compose")).props("dense unelevated").style(
                                        "font-size:11px; font-weight:900; margin-left:2px; border-radius:10px; "
                                        "background:var(--color-primary) !important; color:white !important; padding:0 10px; min-height:28px;"
                                    )
                                ui.label("결과 화면에서 「보관함에 넣기」를 누른 PDF만 여기에 표시됩니다.").style(
                                    "font-size:11px; color:var(--color-ink-soft); margin-top:4px; font-weight:600; line-height:1.45; display:block;"
                                )
                            with ui.row().style("gap:6px; align-items:center; flex-shrink:0;"):
                                def _delete_archive_selected():
                                    rels = list(library_page._archive_selected)
                                    n = _archive_remove_for_user(uname, rels)
                                    library_page._archive_selected.clear()
                                    ui.notify(
                                        f"보관함 {n}개 삭제됨" if n else "삭제할 항목이 없습니다",
                                        type="positive" if n else "warning",
                                    )
                                    page_content.refresh()

                                def _delete_archive_selected_with_files():
                                    rels = list(library_page._archive_selected)
                                    if not rels:
                                        ui.notify("삭제할 항목이 없습니다", type="warning")
                                        return

                                    confirm = ui.dialog()
                                    with confirm:
                                        with ui.card().style("width:min(520px, 92vw); padding:18px;"):
                                            ui.label("파일도 함께 삭제할까요?").style(
                                                "font-size:16px; font-weight:900; color:var(--color-ink);"
                                            )
                                            ui.label(
                                                "선택한 PDF 파일을 디스크(outputs)에서 완전히 삭제합니다. 이 작업은 되돌릴 수 없습니다."
                                            ).style("font-size:12px; color:var(--color-ink-soft); margin-top:6px; line-height:1.5;")
                                            ui.element("div").style("height:10px;")
                                            ui.label(f"대상: {len(rels)}개").style(
                                                "font-size:12px; color:var(--color-ink-muted); font-weight:700;"
                                            )

                                            with ui.row().style("justify-content:flex-end; gap:10px; margin-top:14px;"):
                                                ui.button("취소", on_click=confirm.close).props("unelevated").style(
                                                    "border-radius:10px; background:var(--bg-canvas); color:var(--color-ink) !important; "
                                                    "border:1px solid var(--color-line-strong); font-weight:900;"
                                                )

                                                def _do():
                                                    # 1) 파일 삭제
                                                    ok_cnt, failed = _delete_outputs_pdfs_by_rel(rels)
                                                    # 2) 보관함 인덱스에서도 제거
                                                    _archive_remove_for_user(uname, rels)
                                                    library_page._archive_selected.clear()

                                                    # 3) 현재 세션 결과 목록에서도 제거(존재하면)
                                                    sid = _session_id()
                                                    if sid:
                                                        curr = _SESSION_RESULTS.get(sid, []) or []
                                                        kept: list[Path] = []
                                                        base = _OUTPUTS_DIR.resolve()
                                                        rel_set = set(rels)
                                                        for p in curr:
                                                            try:
                                                                rp = p.resolve().relative_to(base).as_posix()
                                                            except Exception:
                                                                continue
                                                            if rp not in rel_set:
                                                                kept.append(p)
                                                        _SESSION_RESULTS[sid] = kept

                                                    if failed:
                                                        ui.notify(
                                                            f"파일 삭제 {ok_cnt}개 완료, {len(failed)}개 실패",
                                                            type="warning",
                                                        )
                                                    else:
                                                        ui.notify(f"파일 {ok_cnt}개 삭제 완료", type="positive")
                                                    confirm.close()
                                                    page_content.refresh()

                                                ui.button("파일도 삭제", on_click=_do).props("dense unelevated").style(
                                                    "border-radius:10px; background:#EF4444; color:white !important; font-weight:900;"
                                                )

                                    confirm.open()

                                if library_page._archive_selected:
                                    ui.button(f"삭제 {len(library_page._archive_selected)}", on_click=_delete_archive_selected).props(
                                        "dense unelevated"
                                    ).style(
                                        "background:#EF4444; color:white !important; font-weight:900; border-radius:10px; padding:0 10px; min-height:32px;"
                                    )
                                    ui.button("파일도 삭제", on_click=_delete_archive_selected_with_files).props(
                                        "dense unelevated"
                                    ).style(
                                        "background:#B91C1C; color:white !important; font-weight:900; border-radius:10px; padding:0 10px; min-height:32px;"
                                    )
                                ui.button("▼" if archive_exp else "▶", on_click=_toggle_archive_panel).props(
                                    "flat dense round"
                                ).style(
                                    "min-width:32px; min-height:32px; padding:0; font-size:12px; font-weight:900; flex-shrink:0; "
                                    "color:var(--color-ink-soft) !important; background:var(--bg-subtle) !important;"
                                )
                        if archive_exp:
                            with ui.element("div").style(_lib_scroll + "gap:8px; padding-right:6px;"):
                                if not archive_rows:
                                    ui.label("아직 보관된 파일이 없습니다. 결과 화면에서 「보관함에 넣기」를 눌러 추가하세요.").style(
                                        "font-size:12px; color:var(--color-ink-muted); font-weight:600; padding:6px 0;"
                                    )
                                else:
                                    for row in archive_rows:
                                        rel = row.get("pdf_rel") or ""
                                        nm = escape(row.get("pdf_name") or Path(rel).name)
                                        subj = escape(row.get("subject") or "—")
                                        lesson = escape(row.get("lesson") or "—")
                                        ts_disp = escape(row.get("ts") or "")
                                        url = f"/download/pdf/{urllib.parse.quote(rel)}"
                                        with ui.element("div").style(
                                            "display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; "
                                            "padding:10px 12px; border-radius:12px; border:1px solid var(--color-line); background:var(--bg-canvas);"
                                        ):
                                            with ui.row().style("gap:10px; align-items:center; flex:1; min-width:0;"):
                                                def _toggle_archive_select(e=None, r=rel):
                                                    if r in library_page._archive_selected:
                                                        library_page._archive_selected.remove(r)
                                                    else:
                                                        library_page._archive_selected.add(r)
                                                    page_content.refresh()

                                                ui.checkbox(value=(rel in library_page._archive_selected), on_change=_toggle_archive_select).props(
                                                    "dense"
                                                ).style("transform:scale(0.9);")
                                                with ui.element("div").style("flex:1; min-width:0;"):
                                                    ui.label(nm).style(
                                                        "font-size:13px; font-weight:800; color:var(--color-ink); display:block;"
                                                    )
                                                    ui.label(f"{subj} · {lesson} · {ts_disp}").style(
                                                        "font-size:11px; color:var(--color-ink-soft); font-weight:600; margin-top:2px;"
                                                    )
                                            ui.link("다운로드", url, new_tab=True).style(
                                                "font-size:12px; font-weight:900; color:var(--color-primary); text-decoration:none; flex-shrink:0;"
                                            )

        app_shell(current_step=1, render_body=render_body, hero=render_hero)

    page_content()


def _resolve_unit_meta(library, path_str):
    """단원 경로로 (unit, breadcrumb) 한 번에 찾기."""
    unit = _find_unit_by_path(library, path_str)
    if not unit:
        return (None, None)
    return (unit, _find_unit_breadcrumb(library, path_str))


# ── 라이브러리 트리/상세 렌더 헬퍼 ─────────────────────────────

def _render_library_tree(library, expanded, refresh_fn):
    """좌측: 학년/과목/출판사/단원 폴더 트리."""
    for grade in library:
        is_grade_open = grade["grade_label"] in expanded["grades"]

        def toggle_grade(g_label=grade["grade_label"]):
            if g_label in expanded["grades"]:
                expanded["grades"].discard(g_label)
            else:
                expanded["grades"].add(g_label)
            refresh_fn()

        # 학년 헤더
        grade_btn = ui.element("button").on("click", lambda *_, fn=toggle_grade: fn()).style(
            "width:100%; display:flex; align-items:center; gap:8px; padding:9px 10px; "
            "background:var(--folder-grade-bg); border:none; cursor:pointer; font-family:inherit; "
            "border-radius:8px; text-align:left; box-shadow:inset 3px 0 0 var(--folder-grade-line);"
        )
        with grade_btn:
            chevron = "▾" if is_grade_open else "▸"
            grade_unit_count = _count_grade_units(grade)
            ui.html(
                f'<span style="font-size:11px; color:var(--color-ink-faint); width:12px; pointer-events:none;">{chevron}</span>'
                f'<span style="font-size:14px; pointer-events:none;">📁</span>'
                f'<span style="font-size:14px; font-weight:700; color:var(--color-ink); pointer-events:none;">{grade["grade_label"]}</span>'
                f'<span style="margin-left:auto; font-size:10px; font-weight:700; color:var(--color-ink-faint); '
                f'background:var(--bg-canvas); padding:2px 8px; border-radius:99px; pointer-events:none;">{grade_unit_count}</span>'
            )

        if not is_grade_open:
            continue

        # 과목들
        for subject in grade["subjects"]:
            subj_key = f'{grade["grade_label"]}/{subject["subject"]}'
            is_subj_open = subj_key in expanded["subjects"]

            def toggle_subject(k=subj_key):
                if k in expanded["subjects"]:
                    expanded["subjects"].discard(k)
                else:
                    expanded["subjects"].add(k)
                refresh_fn()

            subj_btn = ui.element("button").on("click", lambda *_, fn=toggle_subject: fn()).style(
                "width:100%; display:flex; align-items:center; gap:8px; padding:7px 10px 7px 28px; "
                "background:var(--folder-subject-bg); border:none; cursor:pointer; font-family:inherit; "
                "border-radius:8px; text-align:left; box-shadow:inset 3px 0 0 var(--folder-subject-line);"
            )
            with subj_btn:
                chevron = "▾" if is_subj_open else "▸"
                subj_unit_count = _count_subject_units(subject)
                ui.html(
                    f'<span style="font-size:11px; color:var(--color-ink-faint); width:12px; pointer-events:none;">{chevron}</span>'
                    f'<span style="font-size:13px; pointer-events:none;">📁</span>'
                    f'<span style="font-size:13px; font-weight:600; color:var(--color-ink-soft); pointer-events:none;">{subject["subject"]}</span>'
                    f'<span style="margin-left:auto; font-size:10px; font-weight:600; color:var(--color-ink-faint); '
                    f'background:var(--bg-canvas); padding:2px 7px; border-radius:99px; pointer-events:none;">{subj_unit_count}</span>'
                )

            if not is_subj_open:
                continue

            # 출판사들
            for publisher in subject["publishers"]:
                pub_key = f'{subj_key}/{publisher["publisher"]}'
                is_pub_open = pub_key in expanded["publishers"]

                def toggle_publisher(k=pub_key):
                    if k in expanded["publishers"]:
                        expanded["publishers"].discard(k)
                    else:
                        expanded["publishers"].add(k)
                    refresh_fn()

                pub_btn = ui.element("button").on("click", lambda *_, fn=toggle_publisher: fn()).style(
                    "width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px 6px 46px; "
                    "background:var(--folder-publisher-bg); border:none; cursor:pointer; font-family:inherit; "
                    "border-radius:8px; text-align:left; box-shadow:inset 3px 0 0 var(--folder-publisher-line);"
                )
                with pub_btn:
                    chevron = "▾" if is_pub_open else "▸"
                    pub_unit_count = len(publisher["units"])
                    ui.html(
                        f'<span style="font-size:11px; color:var(--color-ink-faint); width:12px; pointer-events:none;">{chevron}</span>'
                        f'<span style="font-size:12px; pointer-events:none;">📁</span>'
                        f'<span style="font-size:12px; font-weight:600; color:var(--color-ink-soft); pointer-events:none;">{publisher["publisher"]}</span>'
                        f'<span style="margin-left:auto; font-size:10px; font-weight:600; color:var(--color-ink-faint); '
                        f'background:var(--bg-canvas); padding:2px 7px; border-radius:99px; pointer-events:none;">{pub_unit_count}</span>'
                    )

                if not is_pub_open:
                    continue

                # 단원들
                # 최근 작업 마크는 계정별
                history_data = _history_for_user(_username_for_storage())
                for unit in publisher["units"]:
                    is_selected = (library_page._selected_unit_path == str(unit["path"]))
                    has_textbook = unit["files"]["textbook"] is not None
                    has_history = str(unit["path"]) in history_data

                    def select_unit(u_path=str(unit["path"])):
                        library_page._selected_unit_path = u_path
                        refresh_fn()

                    if is_selected:
                        unit_style = (
                            "width:100%; display:flex; align-items:center; gap:8px; padding:8px 10px 8px 64px; "
                            "background:var(--color-primary-soft); border:1px solid var(--color-primary); "
                            "cursor:pointer; font-family:inherit; border-radius:8px; text-align:left; margin-bottom:2px;"
                        )
                        text_color = "var(--color-success-deep)"
                        text_weight = "700"
                    else:
                        unit_style = (
                            "width:100%; display:flex; align-items:center; gap:8px; padding:8px 10px 8px 64px; "
                            "background:transparent; border:1px solid transparent; cursor:pointer; font-family:inherit; "
                            "border-radius:8px; text-align:left; margin-bottom:2px;"
                        )
                        text_color = "var(--color-ink)" if has_textbook else "var(--color-ink-faint)"
                        text_weight = "500"

                    unit_btn = ui.element("button").on("click", lambda *_, fn=select_unit: fn()).style(unit_style)
                    with unit_btn:
                        icon = "📂" if is_selected else "📁"
                        warn = "" if has_textbook else ' <span style="color:#D97706; font-size:11px;">⚠️</span>'
                        history_mark = (
                            ' <span style="color:var(--color-primary); font-size:11px; font-weight:700;" title="작업 이력 있음">✓</span>'
                            if has_history else ''
                        )
                        ui.html(
                            f'<span style="font-size:13px; pointer-events:none;">{icon}</span>'
                            f'<span style="font-size:13px; font-weight:{text_weight}; color:{text_color}; pointer-events:none;">{unit["label"]}{warn}{history_mark}</span>'
                        )


def _render_unit_detail(library, selected_unit_path):
    """우측: 선택된 단원의 PDF 3개 상세 + 썸네일 + 메타 + 이전 작업 이력."""
    if not selected_unit_path:
        # 선택 전 안내
        with ui.element("div").style("display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:40px 20px; text-align:center;"):
            ui.html(
                '<div style="font-size:40px; margin-bottom:12px;">👈</div>'
                '<div style="font-size:14px; color:var(--color-ink-soft); font-weight:600; line-height:1.6;">'
                '왼쪽 폴더 트리에서<br>학년 → 과목 → 출판사 → 단원 순서로 펼쳐서<br>작업할 단원을 선택해 주세요.</div>'
            )
        return

    unit = _find_unit_by_path(library, selected_unit_path)
    if not unit:
        ui.label("선택된 단원을 찾을 수 없습니다. 폴더가 변경됐을 수 있습니다.").style("font-size:13px; color:var(--color-ink-soft);")
        return

    grade_label, subject_label, publisher_label = _find_unit_breadcrumb(library, selected_unit_path)

    # 헤더
    ui.label(f"{grade_label} · {subject_label} · {publisher_label}").style("font-size:11px; font-weight:700; color:var(--color-primary); letter-spacing:0.04em; margin-bottom:6px;")
    ui.label(unit["label"]).style("font-size:18px; font-weight:800; color:var(--color-ink); margin-bottom:14px; line-height:1.3;")

    # 교과서 첫 페이지 썸네일 + 요약 메타 (가로 배치)
    textbook_pdf = unit["files"]["textbook"]
    if textbook_pdf:
        try:
            rel_thumb = textbook_pdf.relative_to(_OUTPUTS_DIR).as_posix()
            thumb_url_ok = True
        except ValueError:
            # assets 안의 PDF는 outputs 라우터로 못 보냄 — base64로 직접 인라인
            thumb_url_ok = False

        with ui.element("div").style(
            "display:flex; gap:14px; align-items:flex-start; padding:12px 14px; "
            "background:var(--bg-subtle); border-radius:12px; margin-bottom:14px;"
        ):
            # 썸네일 — assets 폴더용 별도 썸네일 라우터 사용
            quoted = urllib.parse.quote(str(textbook_pdf.relative_to(_ASSETS_DIR).as_posix()))
            ui.html(
                f'<img src="/files/asset_thumb/{quoted}?t={int(time.time())}" '
                f'style="width:100px; height:71px; object-fit:cover; border-radius:6px; '
                f'background:white; flex-shrink:0; border:1px solid var(--color-line-strong); '
                f'box-shadow:0 2px 6px rgba(0,0,0,0.08);" />'
            )
            tb_meta = _pdf_meta(textbook_pdf)
            with ui.element("div").style("flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;"):
                ui.label("교과서 미리보기").style("font-size:10px; font-weight:700; color:var(--color-ink-faint); letter-spacing:0.05em;")
                ui.label(textbook_pdf.name).style("font-size:13px; font-weight:700; color:var(--color-ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")
                meta_text = f"{tb_meta['pages']}쪽 · {tb_meta['size_kb']:.0f}KB · {tb_meta['mtime']}"
                ui.label(meta_text).style("font-size:11px; color:var(--color-ink-soft);")

    # 파일 카드 (콤팩트하게)
    file_specs = [
        ("textbook", "교과서", "필수", "📄"),
        ("guide", "지도서", "선택", "📘"),
        ("curriculum", "교육과정", "선택", "📋"),
        ("assessment", "평가문항", "선택", "📝"),
        ("lesson_plan", "수업 지도안", "선택", "🗺️"),
    ]
    # 교육과정 자동 매칭 시도
    grade_no_for_curr = 0
    gm = _GRADE_RE.match(_norm(grade_label))
    if gm:
        grade_no_for_curr = int(gm.group(1))
    auto_curriculum = _find_curriculum_pdf(grade_no_for_curr, subject_label) if grade_no_for_curr else None

    with ui.element("div").style("display:flex; flex-direction:column; gap:6px; margin-bottom:14px;"):
        for key, label, requirement, icon in file_specs:
            pdf = unit["files"][key]
            # 교육과정인데 단원 폴더에 없으면 자동 매칭 사용
            is_auto_matched = False
            if key == "curriculum" and not pdf and auto_curriculum:
                pdf = auto_curriculum
                is_auto_matched = True
            present = pdf is not None
            if present:
                bg = "var(--bg-canvas)"
                border = "1px solid var(--color-line-strong)"
                badge_bg = "var(--color-success-soft)"
                badge_color = "var(--color-success-deep)"
                badge_text = "✓"
                title_color = "var(--color-ink)"
                meta = _pdf_meta(pdf)
                sub_text = f"{meta['pages']}쪽 · {meta['size_kb']:.0f}KB"
                if is_auto_matched:
                    sub_text = f"자동 매칭 · {sub_text}"
            else:
                bg = "transparent"
                border = "1.5px dashed var(--color-line-strong)"
                if requirement == "필수":
                    badge_bg = "#FEF3C7"
                    badge_color = "#B45309"
                    badge_text = "!"
                else:
                    badge_bg = "var(--bg-muted)"
                    badge_color = "var(--color-ink-faint)"
                    badge_text = "—"
                title_color = "var(--color-ink-faint)"
                sub_text = "없음"

            with ui.element("div").style(
                f"display:flex; align-items:center; gap:12px; padding:10px 14px; "
                f"background:{bg}; border:{border}; border-radius:10px;"
            ):
                ui.html(f'<div style="font-size:18px;">{icon}</div>')
                with ui.element("div").style("flex:1; min-width:0;"):
                    ui.label(f"{label} ({requirement})").style(f"font-size:12px; font-weight:700; color:{title_color};")
                    ui.label(sub_text).style("font-size:11px; color:var(--color-ink-soft); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;")
                ui.html(
                    f'<div style="width:22px;height:22px;border-radius:50%;background:{badge_bg};color:{badge_color};'
                    f'display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;">{badge_text}</div>'
                )

    # 추가 첨부(선택) — 위 교과서 썸네일(사진) 아래쪽에 배치
    with ui.element("div").style(
        "margin-bottom:14px; padding:12px 14px; background:var(--bg-subtle); border:1px solid var(--color-line); border-radius:12px;"
    ):
        ui.label("추가 파일 첨부 (선택)").style("font-size:12px; font-weight:900; color:var(--color-ink);")
        ui.label("없어도 활동지는 생성됩니다. PDF·PNG·JPEG·WebP 모두 텍스트로 분석합니다(이미지는 Gemini 키 필요).").style(
            "font-size:11px; color:var(--color-ink-soft); margin-top:4px; font-weight:700; line-height:1.5;"
        )
        with ui.element("div").style("display:flex; flex-direction:column; gap:10px; margin-top:10px;"):
            def _mk_upload(target_name: str):
                logical_stem = Path(target_name).stem

                def _on_upload(e: events.UploadEventArguments):
                    try:
                        content = e.content.read() if hasattr(e, "content") and e.content else b""
                    except Exception:
                        content = b""
                    if not content:
                        ui.notify("업로드 실패: 파일 내용을 읽지 못했습니다.", type="negative")
                        return
                    up_name = ""
                    for attr in ("name", "file_name", "filename"):
                        v = getattr(e, attr, None)
                        if isinstance(v, str) and v.strip():
                            up_name = v.strip()
                            break
                    if not up_name:
                        fobj = getattr(e, "file", None)
                        if fobj is not None and hasattr(fobj, "name"):
                            fn = getattr(fobj, "name", "")
                            if isinstance(fn, str) and fn.strip():
                                up_name = fn.strip()
                    ok = _save_optional_unit_asset(selected_unit_path, logical_stem, content, up_name)
                    if ok:
                        ui.notify(f"{logical_stem} 저장됨", type="positive")
                        page_content.refresh()
                    else:
                        ui.notify("저장 실패: PDF/PNG/JPEG/WebP만 가능하거나 폴더에 쓸 수 없습니다.", type="negative")

                # 드래그 앤 드랍 가능한 업로더 (클릭 업로드도 가능)
                ui.upload(
                    label=f"{logical_stem} 업로드 (PDF·이미지, 드래그&드랍 가능)",
                    auto_upload=True,
                    on_upload=_on_upload,
                ).props("accept=.pdf,.png,.jpg,.jpeg,.webp max-files=1").style(
                    "width:100%;"
                )

            _mk_upload("평가문항.pdf")
            _mk_upload("수업지도안.pdf")

    # 이전 작업 이력
    history = _get_unit_history(selected_unit_path, username=_username_for_storage())
    if history:
        with ui.element("div").style(
            "padding:12px 14px; background:var(--bg-subtle); border-radius:12px; "
            "border:1px solid var(--color-line);"
        ):
            with ui.element("div").style("display:flex; align-items:center; gap:8px; margin-bottom:8px;"):
                ui.html('<span style="font-size:13px;">📝</span>')
                ui.label("이전 작업 이력").style("font-size:11px; font-weight:700; color:var(--color-ink-faint); letter-spacing:0.04em;")
                last_used_label = _format_relative_time(history.get("last_used", ""))
                ui.label(last_used_label).style("font-size:11px; color:var(--color-ink-soft); margin-left:auto;")
            count = history.get("count", 0)
            outputs = history.get("outputs", [])
            existing = [Path(p) for p in outputs if Path(p).exists()]
            ui.label(f"이 단원으로 {count}회 작업 · 결과 PDF {len(existing)}개 보존됨").style(
                "font-size:12px; color:var(--color-ink-soft); line-height:1.5;"
            )


def _render_unit_center(library, selected_unit_path):
    """Center 패널: 선택 단원의 파일 목록을 데이터 테이블로."""
    if not selected_unit_path:
        with ui.element("div").style("display:flex; flex-direction:column; justify-content:center; height:100%; padding:24px;"):
            ui.label("단원을 선택하세요").style("font-size:14px; font-weight:900; color:var(--color-ink); margin-bottom:6px;")
            ui.label("왼쪽 트리에서 단원을 클릭하면 파일 목록이 여기 표시됩니다.").style("font-size:12px; color:var(--color-ink-soft); font-weight:700;")
        return

    unit = _find_unit_by_path(library, selected_unit_path)
    if not unit:
        ui.label("선택된 단원을 찾을 수 없습니다.").style("font-size:13px; color:var(--color-ink-soft);")
        return

    grade_label, subject_label, publisher_label = _find_unit_breadcrumb(library, selected_unit_path)
    ui.label(unit["label"]).style("font-size:18px; font-weight:900; letter-spacing:-0.02em; color:var(--color-ink); margin-bottom:4px;")
    ui.label(f"{grade_label} · {subject_label} · {publisher_label}").style(
        "font-size:11px; font-weight:900; color:var(--color-ink-faint); letter-spacing:0.08em; margin-bottom:14px; text-transform:uppercase;"
    )

    file_specs = [
        ("textbook", "교과서", "필수"),
        ("guide", "지도서", "선택"),
        ("curriculum", "교육과정", "선택"),
        ("assessment", "평가문항", "선택"),
        ("lesson_plan", "수업 지도안", "선택"),
    ]

    grade_no_for_curr = 0
    gm = _GRADE_RE.match(_norm(grade_label))
    if gm:
        grade_no_for_curr = int(gm.group(1))
    auto_curriculum = _find_curriculum_pdf(grade_no_for_curr, subject_label) if grade_no_for_curr else None

    rows = []
    for key, label, requirement in file_specs:
        display_label = label
        pdf = unit["files"][key]
        is_auto = False
        if key == "curriculum" and not pdf and auto_curriculum:
            pdf = auto_curriculum
            is_auto = True

        if pdf:
            meta = _pdf_meta(pdf)
            status = '<span class="pill ok">🟢 READY</span>'
            if is_auto:
                status = '<span class="pill ok" title="학년군/과목으로 자동 매칭됨">🟢 AUTO</span>'
            pages = f'{meta["pages"]}쪽' if meta["pages"] else "—"
            size = f'{meta["size_kb"]:.0f}KB' if meta["size_kb"] else "—"
            mtime = meta["mtime"] or "—"
            name = pdf.name
        else:
            status = '<span class="pill warn">🟠 MISSING</span>' if requirement == "필수" else '<span class="pill">—</span>'
            pages, size, mtime, name = "—", "—", "—", "없음"

        rows.append(
            "<tr>"
            f'<td class="name">{display_label}</td>'
            f'<td class="muted">{requirement}</td>'
            f'<td class="mono right">{pages}</td>'
            f'<td class="mono right">{size}</td>'
            f'<td class="mono">{mtime}</td>'
            f'<td class="mono faint">{name}</td>'
            f"<td>{status}</td>"
            "</tr>"
        )

    ui.html(
        '<table class="data-table">'
        "<thead><tr>"
        "<th>ITEM</th><th>REQ</th><th class='right'>PAGES</th><th class='right'>SIZE</th><th>MTIME</th><th>FILENAME</th><th>STATUS</th>"
        "</tr></thead>"
        "<tbody>"
        + "".join(rows) +
        "</tbody></table>"
    ).style("flex:1; min-height:0; overflow:auto;")

    # 추가 첨부(선택) — 표 아래(가운데 칼럼)에서 바로 업로드/드래그&드랍
    with ui.element("div").style(
        "margin-top:12px; background:var(--bg-surface); border:1px solid var(--color-line-strong); "
        "border-radius:var(--radius-md); padding:12px 12px;"
    ):
        ui.label("첨부 (선택)").style(
            "font-size:10px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint); margin-bottom:8px;"
        )
        ui.label("평가문항·수업 지도안: PDF 또는 PNG/JPEG/WebP. 이미지·스캔 PDF는 Gemini 키로 OCR합니다.").style(
            "font-size:11px; color:var(--color-ink-soft); font-weight:700; line-height:1.45;"
        )

        def _mk_upload(target_name: str):
            logical_stem = Path(target_name).stem

            def _on_upload(e: events.UploadEventArguments):
                try:
                    content = e.content.read() if hasattr(e, "content") and e.content else b""
                except Exception:
                    content = b""
                if not content:
                    ui.notify("업로드 실패: 파일 내용을 읽지 못했습니다.", type="negative")
                    return
                up_name = ""
                for attr in ("name", "file_name", "filename"):
                    v = getattr(e, attr, None)
                    if isinstance(v, str) and v.strip():
                        up_name = v.strip()
                        break
                if not up_name:
                    fobj = getattr(e, "file", None)
                    if fobj is not None and hasattr(fobj, "name"):
                        fn = getattr(fobj, "name", "")
                        if isinstance(fn, str) and fn.strip():
                            up_name = fn.strip()
                ok = _save_optional_unit_asset(selected_unit_path, logical_stem, content, up_name)
                if ok:
                    ui.notify(f"{logical_stem} 저장됨", type="positive")
                    # unit 파일 목록/테이블 갱신
                    ui.navigate.to("/")  # 센터/우측 전체 리렌더 유도
                else:
                    ui.notify("저장 실패: PDF/PNG/JPEG/WebP만 가능하거나 폴더에 쓸 수 없습니다.", type="negative")

            ui.upload(
                label=f"{logical_stem} 업로드 (PDF·이미지)",
                auto_upload=True,
                on_upload=_on_upload,
            ).props("accept=.pdf,.png,.jpg,.jpeg,.webp max-files=1").style("width:100%; margin-top:8px;")

        _mk_upload("평가문항.pdf")
        _mk_upload("수업지도안.pdf")


def _render_unit_inspector(library, selected_unit_path):
    """Right 패널: 썸네일/이력 등 메타 중심 인스펙터."""
    if not selected_unit_path:
        with ui.element("div").style("display:flex; flex-direction:column; justify-content:center; height:100%; padding:24px; text-align:center;"):
            ui.html('<div style="font-size:36px; margin-bottom:10px;">🧭</div>')
            ui.label("Inspector").style("font-size:14px; font-weight:900; color:var(--color-ink);")
            ui.label("선택 항목의 상세 메타가 여기 표시됩니다.").style("font-size:12px; color:var(--color-ink-soft); margin-top:6px; font-weight:700;")
        return

    unit = _find_unit_by_path(library, selected_unit_path)
    if not unit:
        ui.label("선택된 단원을 찾을 수 없습니다.").style("font-size:13px; color:var(--color-ink-soft);")
        return

    grade_label, subject_label, publisher_label = _find_unit_breadcrumb(library, selected_unit_path)

    with ui.element("div").style(
        "background:var(--bg-subtle); border:1px solid var(--color-line); border-radius:var(--radius-md); padding:12px 12px; margin-bottom:12px;"
    ):
        ui.label("BREADCRUMB").style("font-size:10px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint); margin-bottom:6px;")
        ui.label(grade_label).style("font-size:12px; font-weight:900; color:var(--color-ink);")
        ui.label(f"{subject_label} · {publisher_label}").style("font-size:12px; color:var(--color-ink-soft); font-weight:800; margin-top:2px;")
        ui.label(unit["label"]).style("font-size:13px; color:var(--color-ink); font-weight:900; margin-top:8px; line-height:1.3;")

    textbook_pdf = unit["files"]["textbook"]
    if textbook_pdf:
        quoted = urllib.parse.quote(str(textbook_pdf.relative_to(_ASSETS_DIR).as_posix()))
        ui.html(
            f'<img src="/files/asset_thumb/{quoted}?t={int(time.time())}" '
            f'style="width:100%; height:190px; object-fit:cover; border-radius:var(--radius-md); '
            f'background:white; border:1px solid var(--color-line-strong); box-shadow:0 6px 16px rgba(0,0,0,0.08);" />'
        ).style("margin-bottom:12px;")

    history = _get_unit_history(selected_unit_path, username=_username_for_storage())
    with ui.element("div").style(
        "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-md); padding:12px 12px;"
    ):
        ui.label("ACTIVITY").style("font-size:10px; font-weight:900; letter-spacing:0.08em; color:var(--color-ink-faint); margin-bottom:8px;")
        if history:
            last_used_label = _format_relative_time(history.get("last_used", ""))
            count = history.get("count", 0)
            ui.html(
                f'<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">'
                f'<div style="font-size:12px; font-weight:900; color:var(--color-ink);">최근 사용</div>'
                f'<div class="mono" style="font-size:12px; font-weight:900; color:var(--color-ink-soft);">{last_used_label}</div>'
                f"</div>"
            )
            ui.html(
                f'<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:8px;">'
                f'<div style="font-size:12px; font-weight:900; color:var(--color-ink);">누적 작업</div>'
                f'<div class="mono" style="font-size:12px; font-weight:900; color:var(--color-success-deep);">{count}회</div>'
                f"</div>"
            )
        else:
            ui.label("이 단원 작업 이력이 없습니다.").style("font-size:12px; color:var(--color-ink-soft); font-weight:800;")


def _render_empty_library_guide():
    """라이브러리가 완전히 비었을 때의 가이드."""
    with ui.element("div").style(
        "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:var(--radius-lg); "
        "box-shadow:var(--shadow-card); padding:40px 44px; text-align:center;"
    ):
        ui.html('<div style="font-size:48px; margin-bottom:16px;">📂</div>')
        ui.label("자료 라이브러리가 비어있습니다").style("font-size:20px; font-weight:800; color:var(--color-ink); margin-bottom:10px;")
        ui.label("아래 폴더 구조에 맞춰 PDF를 넣고 페이지를 새로고침하세요.").style("font-size:14px; color:var(--color-ink-soft); margin-bottom:24px; line-height:1.6;")

        # 폴더 구조 가이드
        with ui.element("div").style(
            "background:var(--bg-subtle); border:1px solid var(--color-line); border-radius:12px; "
            "padding:18px 22px; text-align:left; max-width:540px; margin:0 auto;"
        ):
            ui.label("폴더 구조 예시").style("font-size:11px; font-weight:700; color:var(--color-ink-faint); letter-spacing:0.05em; margin-bottom:10px;")
            ui.html(
                '<pre style="font-family:ui-monospace, SFMono-Regular, Consolas, monospace; font-size:12px; '
                'color:var(--color-ink); line-height:1.65; margin:0; white-space:pre;">'
                'assets/\n'
                '├── 5학년/\n'
                '│   └── 사회/\n'
                '│       └── 비상교육/                  (출판사)\n'
                '│           └── 2단원_우리 국토의 자연환경/\n'
                '│               ├── 교과서.pdf    (필수)\n'
                '│               └── 지도서.pdf    (선택)\n'
                '│\n'
                '└── _curriculum/                    (교육과정 전용)\n'
                '    ├── 1-2학년군/\n'
                '    │   ├── 국어.pdf\n'
                '    │   └── 수학.pdf\n'
                '    ├── 3-4학년군/\n'
                '    │   ├── 사회.pdf\n'
                '    │   └── 과학.pdf\n'
                '    └── 5-6학년군/\n'
                '        ├── 사회.pdf\n'
                '        └── 과학.pdf'
                '</pre>'
            )
            ui.label(
                "💡 교육과정 PDF는 학년·과목으로 자동 매칭됩니다. "
                "예: 5학년 사회 → _curriculum/5-6학년군/사회.pdf"
            ).style("font-size:11px; color:var(--color-ink-soft); margin-top:14px; line-height:1.5; padding:0 4px;")

        with ui.element("div").style("margin-top:22px; display:flex; gap:8px; justify-content:center;"):
            ui.button("폴더 새로고침", on_click=lambda: ui.navigate.reload()).props("color=primary unelevated").style("border-radius:10px;")


def _find_unit_by_path(library, path_str):
    """단원 경로 문자열로 단원 dict 찾기."""
    if not path_str:
        return None
    for grade in library:
        for subject in grade["subjects"]:
            for publisher in subject["publishers"]:
                for unit in publisher["units"]:
                    if str(unit["path"]) == path_str:
                        return unit
    return None


def _find_unit_breadcrumb(library, path_str):
    """단원 경로의 (학년, 과목, 출판사) 라벨."""
    if not path_str:
        return ("", "", "")
    for grade in library:
        for subject in grade["subjects"]:
            for publisher in subject["publishers"]:
                for unit in publisher["units"]:
                    if str(unit["path"]) == path_str:
                        return (grade["grade_label"], subject["subject"], publisher["publisher"])
    return ("", "", "")


def _load_unit_to_session(session, unit, subject_label, grade_no: int = 0) -> bool:
    """선택된 단원의 PDF를 세션에 로드. 성공 시 True.
    교육과정 PDF가 단원 폴더에 없으면 _curriculum/{학년군}/{과목}.pdf에서 자동 매칭."""
    try:
        textbook_path = unit["files"]["textbook"]
        if not textbook_path:
            return False
        tb_data = textbook_path.read_bytes()
        session.subject = subject_label
        # 학년 정보도 세션에 박아둠 (작업 7 — 학년 미배운 개념 필터용)
        # state.Session에 grade 필드가 없을 수 있으니 안전 처리
        try:
            object.__setattr__(session, "grade", int(grade_no) if grade_no else None)
        except Exception:
            pass
        session.textbook_filename = textbook_path.name
        session.textbook_bytes = tb_data
        session.pages = pdf_to_thumbnails(tb_data)

        guide_path = unit["files"]["guide"]
        if guide_path:
            session.guide_filename = guide_path.name
            session.guide_bytes = guide_path.read_bytes()
        else:
            session.guide_filename = None
            session.guide_bytes = None

        # 교육과정: (1) 단원 폴더에 있으면 우선 사용, (2) 없으면 학년군 폴더에서 자동 매칭
        curr_path = unit["files"]["curriculum"]
        if not curr_path and grade_no > 0:
            curr_path = _find_curriculum_pdf(grade_no, subject_label)
        if curr_path:
            session.curriculum_filename = curr_path.name
            session.curriculum_bytes = curr_path.read_bytes()
        else:
            session.curriculum_filename = None
            session.curriculum_bytes = None

        # 품질 보조 자료(선택): 평가문항 / 수업지도안
        ass_path = unit["files"].get("assessment")
        if ass_path:
            session.assessment_filename = ass_path.name
            session.assessment_bytes = ass_path.read_bytes()
        else:
            session.assessment_filename = None
            session.assessment_bytes = None

        lp_path = unit["files"].get("lesson_plan")
        if lp_path:
            session.lesson_plan_filename = lp_path.name
            session.lesson_plan_bytes = lp_path.read_bytes()
        else:
            session.lesson_plan_filename = None
            session.lesson_plan_bytes = None
        return True
    except Exception as exc:
        print(f"[라이브러리 로드 실패] {exc}")
        return False


# ============ 2. 페이지 그룹화 ============
@ui.page("/grouping")
def grouping_page():
    if require_auth() is None: return
    session = get_session()
    if not session.is_ready_for_grouping():
        ui.navigate.to("/")
        return
    if not session.buckets:
        session.add_bucket()
        session.add_bucket()

    def render_hero():
        with ui.element("div").classes("page-hero"):
            ui.label("STEP 2 / 4").style("font-size:12px; font-weight:800; color:var(--color-primary); letter-spacing:0.05em; margin-bottom:8px;")
            ui.label("학습지 차시 구성").style("font-size:32px; font-weight:800; letter-spacing:-0.03em; color:var(--color-ink); margin-bottom:8px;")
            ui.label(f"교과서 {len(session.pages)}쪽 중 이번 차시에 포함할 페이지를 묶어주세요.").style("font-size:15px; color:var(--color-ink-soft); line-height:1.5;")

    def render_body():
        with ui.element("div").style("display:grid; grid-template-columns:1fr 340px; gap:24px; height:calc(100vh - 240px); min-height:500px;"):
            with ui.element("div").style("background:var(--bg-surface); border-radius:var(--radius-lg); border:1px solid var(--color-line-strong); box-shadow:var(--shadow-card); padding:24px; display:flex; flex-direction:column; min-height:0;"):
                with ui.element("div").style("display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;"):
                    ui.label("교과서 페이지").style("font-size:16px; font-weight:800; color:var(--color-ink);")
                    selection_label = ui.label("").style("font-size:13px; font-weight:700; color:var(--color-success-deep); background:var(--color-success-soft); padding:6px 12px; border-radius:8px;")
                
                with ui.scroll_area().classes("w-full flex-1").style("min-height:0; padding-right:8px;"):
                    grid = ui.row().classes("gap-4 flex-wrap")
                    page_cards: dict[int, ui.element] = {}
                    with grid:
                        for page in session.pages:
                            card = _render_page_card(session, page, selection_label)
                            page_cards[page.index] = card

            with ui.element("div").style("display:flex; flex-direction:column; gap:16px; min-height:0;"):
                with ui.element("div").style("background:var(--bg-surface); border-radius:var(--radius-lg); border:1px solid var(--color-line-strong); box-shadow:var(--shadow-card); padding:24px; display:flex; flex-direction:column; flex:1; min-height:0;"):
                    ui.label("생성할 차시 목록").style("font-size:16px; font-weight:800; color:var(--color-ink); margin-bottom:16px;")
                    with ui.scroll_area().classes("flex-1").style("min-height:0; margin-bottom:16px; padding-right:4px;"):
                        buckets_container = ui.column().classes("w-full gap-3")
                    _render_buckets(session, buckets_container, page_cards, selection_label)

                    def add_bucket():
                        session.add_bucket()
                        _render_buckets(session, buckets_container, page_cards, selection_label)

                    ui.button("+ 새 차시 추가", on_click=add_bucket).style("width:100%; padding:12px; background:var(--bg-canvas); border:1.5px dashed var(--color-line-strong); border-radius:12px; color:var(--color-ink-soft) !important; font-size:14px; font-weight:700; cursor:pointer; transition:all 0.2s;")

                # 관리자: 실제 생성 + 목업(무API) 생성 버튼 제공
                btn_row = ui.element("div").style("display:flex; gap:10px;")
                with btn_row:
                    run_btn = ui.button("▶ 학습지 생성 시작", on_click=lambda: ui.navigate.to("/run")).props("color=primary unelevated size=lg").style(
                        "flex:1; border-radius:16px; padding:16px 0; font-size:15px; font-weight:800; box-shadow:0 8px 24px rgba(16,185,129,0.25);"
                    )
                    mock_btn = None
                    if is_admin():
                        mock_btn = ui.button("🧪 목업 생성", on_click=lambda: ui.navigate.to("/mock_run")).props("unelevated").style(
                            "flex:0.9; border-radius:16px; padding:16px 0; font-size:14px; font-weight:900; "
                            "background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                        )
                if is_admin():
                    app.storage.user.setdefault("admin_fast_pipeline", False)

                    def _on_admin_fast(e):
                        app.storage.user["admin_fast_pipeline"] = bool(getattr(e, "value", False))

                    ui.checkbox(
                        "관리자 빠른 생성 (API 재시도 최대 3회, PDF 레이아웃 보정 1회 — 반복 테스트용, 품질은 다소 낮을 수 있음)",
                        value=bool(app.storage.user.get("admin_fast_pipeline")),
                        on_change=_on_admin_fast,
                    ).props("dense").style(
                        "margin-top:6px; font-size:12px; font-weight:600; color:var(--color-ink-soft);"
                    )

                def _refresh_run_state():
                    ok = session.is_ready_to_run()
                    if ok:
                        run_btn.enable()
                        if mock_btn: mock_btn.enable()
                    else:
                        run_btn.disable()
                        if mock_btn: mock_btn.disable()

                ui.timer(0.3, _refresh_run_state)
                _update_selection_label(session, selection_label)

    app_shell(current_step=2, render_body=render_body, hero=render_hero)

def _update_selection_label(session, label):
    n = len(session.selected_page_indices)
    if n == 0: label.set_text("페이지를 클릭하세요")
    else: label.set_text(f"{n}장 선택됨")

def _bucket_color(bucket_id):
    palette = ["#10B981", "#3B82F6", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4", "#F97316", "#EC4899"]
    try: idx = int(bucket_id.split("-")[1]) - 1
    except (IndexError, ValueError): idx = 0
    return palette[idx % len(palette)]

def _render_page_card(session, page, selection_label):
    def on_click():
        session.toggle_page(page.index)
        _apply_card_style(card, session, page)
        _update_selection_label(session, selection_label)
    
    # width/box-sizing을 고정해서 선택 효과(테두리)로 인한 줄바꿈/재배치 방지
    card = ui.element("div").on("click", on_click).style("transition:all 0.2s; width:140px; box-sizing:border-box;")
    with card:
        img_container = ui.element("div").style("width:140px; height:190px; background:#F8FAFC; border-radius:10px 10px 0 0; overflow:hidden; display:flex; align-items:center; justify-content:center;")
        with img_container:
            ui.image(page.thumbnail_b64).style("width:100%; height:100%; object-fit:contain;")
        with ui.element("div").style("display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:white; border-radius:0 0 10px 10px; border-top:1px solid var(--color-line-strong);"):
            ui.label(f"p. {page.page_number}").style("font-size:13px; font-weight:700; color:var(--color-ink-soft);")
            card._dot = ui.element("div").style("width:10px; height:10px; border-radius:50%; background:var(--color-line);")
    _apply_card_style(card, session, page)
    return card

def _apply_card_style(card, session, page):
    is_selected = page.index in session.selected_page_indices
    bucket = session.bucket_of_page(page.index)
    if is_selected:
        # border 두께를 바꾸면 레이아웃이 밀릴 수 있으니 outline로 강조
        card.style(
            "cursor:pointer; border:1px solid var(--color-line-strong); border-radius:12px; "
            "outline:3px solid rgba(16,185,129,0.75); outline-offset:0px; "
            "box-shadow:0 8px 16px rgba(16,185,129,0.15); transform:translateY(-2px);"
        )
    else:
        card.style(
            "cursor:pointer; border:1px solid var(--color-line-strong); border-radius:12px; "
            "outline:0; box-shadow:0 2px 8px rgba(0,0,0,0.04); transform:none;"
        )
    if hasattr(card, "_dot"):
        if bucket: card._dot.style(f"background:{_bucket_color(bucket.id)}; box-shadow: 0 0 0 3px {_bucket_color(bucket.id)}30;")
        else: card._dot.style("background:var(--color-line-strong); box-shadow:none;")

def _render_buckets(session, container, page_cards, selection_label):
    container.clear()
    with container:
        for bucket in session.buckets:
            color = _bucket_color(bucket.id)
            page_numbers = [session.pages[i].page_number for i in bucket.page_indices]
            pages_str = " · ".join(f"p.{n}" for n in page_numbers) if page_numbers else "페이지를 선택하고 이곳을 클릭"
            
            bucket_card = ui.element("div").style(
                f"background:var(--bg-canvas); border-radius:12px; border:1px solid var(--color-line-strong); "
                f"border-left:4px solid {color}; padding:14px 16px; cursor:pointer; transition:all 0.2s;"
            )

            def make_assign(b_id=bucket.id):
                def _assign():
                    if not session.selected_page_indices: return ui.notify("먼저 좌측에서 페이지를 클릭하세요", type="warning")
                    session.assign_selected_to(b_id)
                    for page in session.pages:
                        if page.index in page_cards: _apply_card_style(page_cards[page.index], session, page)
                    _update_selection_label(session, selection_label)
                    _render_buckets(session, container, page_cards, selection_label)
                return _assign

            def make_remove(b_id=bucket.id):
                def _remove():
                    session.remove_bucket(b_id)
                    for page in session.pages:
                        if page.index in page_cards: _apply_card_style(page_cards[page.index], session, page)
                    _render_buckets(session, container, page_cards, selection_label)
                return _remove

            bucket_card.on("click", make_assign())
            with bucket_card:
                with ui.element("div").style("display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;"):
                    ui.label(bucket.name).style(f"font-size:14px; font-weight:800; color:{color};")
                    ui.button("삭제", on_click=make_remove()).props("flat dense").style("color:var(--color-ink-soft) !important; font-size:11px; font-weight:700; padding:4px 8px; background:var(--bg-muted); border-radius:6px;")
                ui.label(pages_str).style("font-size:12px; font-weight:600; color:var(--color-ink-soft); line-height:1.4;")


# ============ 3. 생성 (터미널 에러 보존 패치 적용) ============
THREED_HTML = """
<div id="sphere-container" style="width: 100%; height: 100%; position: relative;">
  <canvas id="sphere-canvas"></canvas>
  <div id="brain-hud" style="position:absolute; inset:0; pointer-events:none;">
    <div style="position:absolute; top:16px; left:16px; right:16px; display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="display:inline-flex; align-items:center; gap:10px; padding:8px 10px; border-radius:12px; background:rgba(15,20,17,0.65); border:1px solid rgba(52,211,153,0.22);">
          <div style="width:10px; height:10px; border-radius:50%; background:#34D399; box-shadow:0 0 18px rgba(52,211,153,0.85);"></div>
          <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:11px; font-weight:900; letter-spacing:0.08em; color:#A7F3D0;">
            NEURAL CORE · ONLINE
          </div>
        </div>
        <div id="brain-metrics" style="display:flex; gap:8px; flex-wrap:wrap;"></div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
        <div style="padding:8px 10px; border-radius:12px; background:rgba(5,7,6,0.55); border:1px solid rgba(148,163,184,0.18);">
          <div style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:10px; font-weight:900; color:rgba(226,232,240,0.85);">
            ⌁ compiling…
          </div>
          <div id="brain-status" style="margin-top:4px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:11px; font-weight:900; color:#34D399;">
            boot sequence
          </div>
        </div>
      </div>
    </div>

  </div>
</div>
"""

THREED_SCRIPT = """
  (function initSphere() {
    const container = document.getElementById('sphere-container');
    const canvas = document.getElementById('sphere-canvas');
    if (!container || !canvas) { setTimeout(initSphere, 100); return; }
    if(window._sphereInited) return;
    window._sphereInited = true;

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: false, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x0A0E0D, 1);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.z = 7.0; 

    // Lights (AI brain vibe)
    scene.add(new THREE.AmbientLight(0x0B1410, 1.2));
    const key = new THREE.PointLight(0x34D399, 1.6, 50);
    key.position.set(6, 4, 10);
    scene.add(key);
    const rim = new THREE.PointLight(0x60A5FA, 0.9, 50);
    rim.position.set(-8, -2, -6);
    scene.add(rim);

    const groupOuter = new THREE.Group();
    const groupMid = new THREE.Group();
    const groupInner = new THREE.Group();
    scene.add(groupOuter); scene.add(groupMid); scene.add(groupInner);

    const radii = [2.45, 1.62, 0.82];
    const geometries = radii.map(r => new THREE.IcosahedronGeometry(r, 2));
    const materialOuter = new THREE.LineBasicMaterial({ color: 0x2A7A5C, transparent: true, opacity: 0.55 });
    const materialMid = new THREE.LineBasicMaterial({ color: 0x4A524E, transparent: true, opacity: 0.40 });
    const materialInner = new THREE.LineBasicMaterial({ color: 0x34D399, transparent: true, opacity: 0.75 });
    const pointsOuter = new THREE.PointsMaterial({ color: 0xA7F3D0, size: 0.045 });
    const pointsInner = new THREE.PointsMaterial({ color: 0xFFFFFF, size: 0.055 });

    const groups = [groupOuter, groupMid, groupInner];
    geometries.forEach((geo, i) => {
        const wf = new THREE.WireframeGeometry(geo);
        const lineMat = (i === 0) ? materialOuter : (i === 1 ? materialMid : materialInner);
        const ptsMat = (i === 2) ? pointsInner : pointsOuter;
        groups[i].add(new THREE.LineSegments(wf, lineMat));
        groups[i].add(new THREE.Points(geo, ptsMat));
    });

    // Neural particles orbiting
    const particleGeo = new THREE.BufferGeometry();
    const particleCount = 900;
    const pos = new Float32Array(particleCount * 3);
    const vel = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      const r = 2.9 + Math.random() * 1.6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i*3+0] = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
      vel[i] = 0.002 + Math.random() * 0.004;
    }
    particleGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const particleMat = new THREE.PointsMaterial({ color: 0x60A5FA, size: 0.018, transparent: true, opacity: 0.55 });
    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    // HUD refs
    const statusEl = document.getElementById('brain-status');
    const metricsEl = document.getElementById('brain-metrics');
    function metricPill(label, value, color) {
      return `<span style="display:inline-flex; align-items:center; gap:8px; padding:6px 8px; border-radius:999px; background:rgba(15,20,17,0.55); border:1px solid rgba(148,163,184,0.14);">
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:10px; font-weight:900; letter-spacing:0.06em; color:rgba(226,232,240,0.65);">${label}</span>
        <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:10px; font-weight:900; color:${color};">${value}</span>
      </span>`;
    }

    // Exec trace samples are used by right-side terminal (python UI)
    const traceSamples = [
      "load_pdf_pages(pages=...)",
      "extract_outline() -> sections",
      "match_curriculum(grade_band) ✓",
      "plan_blocks(phase=intro/develop/wrap)",
      "render_html(template=v14.1)",
      "verify_output(pdf_integrity) ✓",
      "retry_on_error(attempt++)",
      "token_budget.check()",
      "sanitize_html(DOMPurify) ✓",
      "cache.thumb.write()",
    ];
    let tok = 0;

    // Pulse hook: increase "brain activity" for ~1.2s
    let activity = 0;
    window.__lessonBrainPulse = function(stepLabel) {
      activity = 1.0;
      if (statusEl) statusEl.textContent = stepLabel || "processing…";
    }

    let time_t = 0;
    function animate() {
        requestAnimationFrame(animate);
        time_t += 0.016;
        // activity decay
        activity = Math.max(0, activity - 0.012);
        const basePulse = (Math.sin(time_t * 2) * 0.5 + 0.5);
        const brainPulse = (0.010 + basePulse * 0.010) + activity * 0.030;

        groupOuter.rotation.y += 0.004 + brainPulse * 0.35;
        groupOuter.rotation.x += 0.002 + brainPulse * 0.22;
        groupMid.rotation.y -= (0.007 + brainPulse * 0.30);
        groupMid.rotation.z += (0.005 + brainPulse * 0.22);
        groupInner.rotation.x -= (0.011 + brainPulse * 0.65);
        groupInner.rotation.y += (0.010 + brainPulse * 0.55);

        // particles swirl
        const p = particleGeo.attributes.position.array;
        for (let i=0;i<particleCount;i++){
          const ix = i*3;
          const x = p[ix], y = p[ix+1], z = p[ix+2];
          // rotate around Y with per-particle velocity
          const ang = vel[i] + activity * 0.010;
          const cx = Math.cos(ang), sx = Math.sin(ang);
          p[ix] = x*cx + z*sx;
          p[ix+2] = -x*sx + z*cx;
          // small breathing
          p[ix+1] = y + Math.sin(time_t*0.8 + i*0.01) * 0.0008;
        }
        particleGeo.attributes.position.needsUpdate = true;

        // materials breathe
        materialInner.opacity = 0.55 + basePulse*0.25 + activity*0.25;
        materialOuter.opacity = 0.30 + basePulse*0.18 + activity*0.10;
        particleMat.opacity = 0.35 + basePulse*0.15 + activity*0.30;
        key.intensity = 1.2 + basePulse*0.6 + activity*1.4;

        // metrics + token rate (fake but convincing)
        tok += (8 + basePulse*18 + activity*60);
        if (metricsEl) {
          const mem = (512 + basePulse*180 + activity*420).toFixed(0);
          const lat = (95 + (1-basePulse)*35 + activity*25).toFixed(0);
          const thr = (1.2 + basePulse*0.9 + activity*1.4).toFixed(1);
          metricsEl.innerHTML = [
            metricPill("TOK", `${Math.floor(tok)}`, "#A7F3D0"),
            metricPill("LAT", `${lat}ms`, "#93C5FD"),
            metricPill("MEM", `${mem}MB`, "#FDE68A"),
            metricPill("THR", `${thr}x`, "#34D399"),
          ].join("");
        }

        renderer.render(scene, camera);
    }
    animate();

    // Resize handling
    window.addEventListener('resize', () => {
      if(!container) return;
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
  })();
"""

@ui.page("/run")
async def run_page():
    if require_auth() is None: return
    session = get_session()
    if not session.is_ready_to_run():
        ui.navigate.to("/grouping")
        return

    def render_hero():
        with ui.element("div").classes("page-hero").style("text-align:center;"):
            ui.label("AI ENGINE COMPILING").style("font-size:12px; font-weight:800; color:var(--color-primary); letter-spacing:0.15em; margin-bottom:8px;")
            ui.label("학습지 자동 컴파일 진행").style("font-size:32px; font-weight:800; letter-spacing:-0.03em; color:var(--color-ink); margin-bottom:8px;")
            ui.label("AI 비서가 문서를 분석하고 활동을 설계하고 있습니다.").style("font-size:15px; color:var(--color-ink-soft);")

    def render_body():
        with ui.element("div").style("display:flex; flex-direction:row; height:650px; background:var(--bg-surface); border-radius:var(--radius-lg); border:1px solid var(--color-line-strong); box-shadow:var(--shadow-card); overflow:hidden; margin-bottom:24px;"):
            
            with ui.element("div").style("flex:1.4; position:relative; background:#0A0E0D; box-shadow:inset 0 0 40px rgba(0,0,0,0.9);"):
                ui.html(THREED_HTML).style("width:100%; height:100%;")
                ui.run_javascript(THREED_SCRIPT)

            with ui.element("div").style("flex:1; display:flex; flex-direction:column; border-left:1px solid var(--color-line-strong); background:#0A0E0D;"):
                with ui.element("div").style("padding:16px 20px; border-bottom:1px solid #1F2622; background:#0F1411; display:flex; align-items:center; gap:10px;"):
                    ui.html('<div style="width:10px;height:10px;border-radius:50%;background:#10B981;"></div>')
                    ui.label("Exec Trace").style("font-size:13px; font-weight:800; color:#10B981; letter-spacing:0.05em;")
                
                with ui.element("div").style("flex:1; padding:20px; background:#050706; overflow:hidden; display:flex; flex-direction:column;"):
                    exec_trace_log = ui.log(max_lines=2500).classes("w-full h-full").style(
                        "background: transparent; color: #34D399; "
                        "font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 13px; "
                        "border: none; padding: 0; line-height: 1.6; resize: none; outline: none;"
                    )

        status_label_line = ui.label("엔진 예열 중...").style("font-size:14px; font-weight:700; color:var(--color-primary); text-align:center; display:block;")

        admin_fast = bool(is_admin() and app.storage.user.get("admin_fast_pipeline"))
        max_retry_ui = 3 if admin_fast else 8

        def update_step(progress: StepProgress):
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            step_kor = {
                "analyze_lesson": "교과서 분석",
                "review_analysis": "분석 검토",
                "match_curriculum": "교육과정 매칭",
                "plan_activities": "활동 설계",
                "review_activities": "활동 검토",
                "render_html": "HTML 렌더링",
                "verify_output": "출력물 검증",
            }.get(progress.step, progress.step)

            # 좌측 구체 HUD에 "AI 뇌가 활성화"되는 펄스 트리거
            try:
                ui.run_javascript(f"window.__lessonBrainPulse && window.__lessonBrainPulse({step_kor!r});")
            except Exception:
                pass

            if progress.status == "running":
                attempt_txt = f" [재시도 {progress.attempt}/{max_retry_ui}]" if progress.attempt > 1 else ""
                exec_trace_log.push(f"[{ts}] step({progress.step}) · {step_kor} 시작{attempt_txt}")
            elif progress.status == "success":
                msg = progress.thinking if progress.thinking else "정상 처리됨."
                exec_trace_log.push(f"[{ts}] ✓ {step_kor} 완료 · {msg}")
            elif progress.status == "error":
                exec_trace_log.push(f"[{ts}] ✕ {step_kor} 실패 · {progress.message}")
            
            if progress.status == "streaming":
                if progress.thinking_partial:
                    text_to_show = progress.thinking_partial.replace("\n", " ")
                    if len(text_to_show) > 100:
                        text_to_show = "..." + text_to_show[-100:]
                    status_label_line.set_text(f"▶ {text_to_show}")
                    # 스트리밍 중에도 trace에 간단히 남김(너무 길면 자동 줄임)
                    clipped = text_to_show[-160:] if len(text_to_show) > 160 else text_to_show
                    exec_trace_log.push(f"[{ts}] … {clipped}")
            else:
                status_label_line.set_text(f"[{progress.bucket_name}] {progress.message}")

        async def run_all():
            try:
                provider, api_key = _effective_provider_and_key()
                # 관리자(winmouse1111/dev) 외에는 개인 키가 없으면 실행 불가
                if not is_admin():
                    ok = has_gemini_key(api_key) if provider == "gemini" else has_api_key(api_key)
                    if not ok:
                        ui.notify("개인 API KEY를 사이드바에 입력해야 생성할 수 있습니다.", type="warning")
                        return
                gem_vk = (app.storage.user.get("gemini_api_key") or "").strip()
                results = await run_pipeline(
                    session,
                    on_progress=update_step,
                    api_key=api_key or None,
                    provider=provider,
                    admin_fast=admin_fast,
                    supplement_vision_key=gem_vk or None,
                )
                session_store = _SESSION_RESULTS.setdefault(_session_id(), [])
                session_store.clear()
                session_store.extend(results)
                
                # 🚨 에러가 발생해서 결과물이 0개면, 절대 결과 화면으로 이동하지 않고 터미널에 멈춰있습니다!
                if len(results) > 0:
                    status_label_line.set_text(f"✓ 완료. {len(results)}개 PDF 생성. 결과 화면으로 이동합니다...")
                    await asyncio.sleep(1.5)
                    ui.navigate.to("/results")
                else:
                    status_label_line.set_text("✕ 생성 실패. 위의 터미널 로그를 확인해주세요.")
                    exec_trace_log.push(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [SYS] 생성된 파일이 0개입니다. 자동 이동을 멈추고 로그를 유지합니다.")
                    
            except Exception as exc:
                err_msg = traceback.format_exc()
                exec_trace_log.push(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] [CRITICAL] 파이프라인 치명적 오류:\n{err_msg}")
                status_label_line.set_text(f"✕ 시스템 오류 발생. 위 터미널 로그를 확인하세요.")

        ui.timer(0.5, run_all, once=True)

    app_shell(current_step=3, render_body=render_body, hero=render_hero)


@ui.page("/mock_run")
def mock_run_page():
    """관리자용 목업 생성: API 호출 없이 샘플 PDF를 복제해 결과 화면으로 이동."""
    if require_auth() is None: return
    if not is_admin():
        ui.navigate.to("/grouping")
        return

    session = get_session()
    if not session.is_ready_to_run():
        ui.navigate.to("/grouping")
        return

    # 샘플 PDF: 프로젝트에 포함된 파일을 사용
    sample_candidates = [
        Path(__file__).parent / "sample_output.pdf",
        Path(__file__).parent / "_sample_preview.pdf",
    ]
    sample_pdf = next((p for p in sample_candidates if p.exists() and p.is_file()), None)
    if not sample_pdf:
        ui.notify("목업용 샘플 PDF를 찾지 못했습니다 (sample_output.pdf).", type="warning")
        ui.navigate.to("/grouping")
        return

    from uuid import uuid4
    import shutil
    run_id = uuid4().hex[:8]
    out_dir = _OUTPUTS_DIR / f"{session.subject}_mock_{run_id}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 페이지가 배정된 차시만 생성 (실제 파이프라인과 동일한 개념)
    non_empty = [b for b in session.buckets if b.page_indices]
    results: list[Path] = []
    for b in non_empty:
        safe_name = b.name.replace("/", "_").replace("\\", "_").strip()
        out_path = out_dir / f"{session.subject}_{safe_name}.pdf"
        try:
            shutil.copyfile(sample_pdf, out_path)
            results.append(out_path)
        except Exception:
            pass

    if not results:
        ui.notify("목업 생성 실패: 생성할 차시가 없습니다.", type="warning")
        ui.navigate.to("/grouping")
        return

    session_store = _SESSION_RESULTS.setdefault(_session_id(), [])
    session_store.clear()
    session_store.extend(results)
    ui.notify(f"목업 생성 완료: {len(results)}개 PDF", type="positive")
    ui.navigate.to("/results")


# ============ 4. 결과 ============
_SESSION_RESULTS: dict[str, list[Path]] = {}

def _session_id(): return app.storage.user.get("session_id", "")


def _safe_outputs_pdf_rel(rel: str) -> Path | None:
    """outputs 하위 PDF만 허용 (경로 탈출 방지)."""
    rel = (rel or "").strip().replace("\\", "/").lstrip("/")
    if not rel or not rel.lower().endswith(".pdf"):
        return None
    if any(part == ".." for part in rel.split("/")):
        return None
    base = _OUTPUTS_DIR.resolve()
    try:
        p = (base / rel).resolve()
        p.relative_to(base)
    except Exception:
        return None
    return p if p.is_file() else None


def _delete_outputs_pdfs_by_rel(pdf_rels: list[str]) -> tuple[int, list[str]]:
    """outputs 하위 PDF 파일을 실제로 삭제. (성공 개수, 실패 rel 리스트)"""
    ok = 0
    failed: list[str] = []
    for rel in pdf_rels or []:
        p = _safe_outputs_pdf_rel(rel)
        if not p:
            failed.append(rel)
            continue
        try:
            p.unlink(missing_ok=True)
            ok += 1
        except Exception:
            failed.append(rel)
    return ok, failed


def _compose_source_pdfs() -> list[Path]:
    """조합 출처: **현재 작업 중인 세션 생성물만**.

    사용자가 요청한 정책: '페이지 조합 학습지'는 보관함(과거 PDF)까지 섞지 않고,
    지금 생성한(현재 세션) PDF 내부에서만 조합한다.
    """
    seen: set[str] = set()
    ordered: list[Path] = []
    for p in _SESSION_RESULTS.get(_session_id(), []) or []:
        try:
            if not isinstance(p, Path) or not p.is_file():
                continue
            r = str(p.resolve())
            if r not in seen:
                seen.add(r)
                ordered.append(p)
        except Exception:
            continue
    return ordered


@ui.page("/share/{sid}")
def share_download_page(sid: str):
    """휴대폰 공유 다운로드 페이지 (QR로 진입)."""
    pdfs = _SESSION_RESULTS.get(sid, []) or []
    # 만료/초기화 등으로 비어있으면 안내만
    ui.add_head_html(f"<style>{DESIGN_CSS}</style>")
    with ui.element("div").style("min-height:100vh; background:var(--bg-canvas); padding:24px 16px;"):
        with ui.element("div").style("max-width:720px; margin:0 auto;"):
            ui.label("휴대폰 다운로드").style("font-size:22px; font-weight:900; color:var(--color-ink); margin-bottom:6px;")
            ui.label("다운로드할 파일을 눌러 바로 저장하세요.").style("font-size:13px; color:var(--color-ink-soft); margin-bottom:16px;")

            if not pdfs:
                with ui.element("div").style(
                    "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:14px; "
                    "padding:16px; box-shadow:var(--shadow-card);"
                ):
                    ui.label("다운로드할 파일이 없거나 공유가 만료되었습니다.").style(
                        "font-size:13px; color:var(--color-ink-soft); font-weight:800;"
                    )
                return

            # 파일 목록
            with ui.element("div").style("display:flex; flex-direction:column; gap:10px;"):
                for pdf_path in pdfs:
                    try:
                        if not pdf_path.exists():
                            continue
                        rel = pdf_path.relative_to(_OUTPUTS_DIR).as_posix()
                    except Exception:
                        continue
                    name = pdf_path.name
                    url = f"/download/pdf/{urllib.parse.quote(rel)}"
                    btn = ui.element("a").props(f'href="{url}" download').style(
                        "display:flex; align-items:center; justify-content:space-between; gap:10px; "
                        "background:var(--bg-surface); border:1px solid var(--color-line-strong); border-radius:14px; "
                        "padding:14px 14px; text-decoration:none; box-shadow:var(--shadow-card);"
                    )
                    with btn:
                        ui.html(
                            f"<div style='display:flex; flex-direction:column; gap:2px;'>"
                            f"<div style='font-size:14px; font-weight:900; color:var(--color-ink);'>{name}</div>"
                            f"<div style='font-size:11px; font-weight:800; color:var(--color-ink-faint);'>tap to download</div>"
                            f"</div>"
                        )
                        ui.html("<div style='font-size:14px; font-weight:900; color:var(--color-primary);'>↓</div>")


@ui.page("/compose")
def compose_page():
    """현재 세션(현재 작업 중인 학습지) PDF에서 페이지만 골라 합칩니다."""
    if require_auth() is None:
        return
    sources = _compose_source_pdfs()
    queue_state: list[dict] = []
    from uuid import uuid4 as _compose_qid

    def render_hero():
        with ui.element("div").classes("page-hero"):
            ui.label("도구").style(
                "font-size:12px; font-weight:800; color:var(--color-primary); letter-spacing:0.08em; margin-bottom:8px;"
            )
            ui.label("페이지 조합 학습지").style(
                "font-size:32px; font-weight:800; letter-spacing:-0.03em; color:var(--color-ink); margin-bottom:8px;"
            )
            ui.label("만들어진 PDF에서 필요한 페이지만 골라 순서대로 한 파일로 합칩니다.").style(
                "font-size:15px; color:var(--color-ink-soft); line-height:1.5;"
            )

    def render_body():
        if not sources:
            ui.label("조합할 PDF가 없습니다. 생성을 완료하거나 보관함에 파일이 있어야 합니다.").style(
                "font-size:14px; color:var(--color-ink-soft); font-weight:600; margin-bottom:16px;"
            )
            ui.button("라이브러리로", on_click=lambda: ui.navigate.to("/")).props("unelevated").style(
                "font-weight:800; margin-right:8px;"
            )
            ui.button("결과 화면", on_click=lambda: ui.navigate.to("/results")).props("unelevated color=primary").style(
                "font-weight:800;"
            )
            return

        @ui.refreshable
        def queue_panel():
            with ui.element("div").style(
                "display:flex; flex-direction:column; gap:8px; min-height:100px; max-height:min(48vh, 420px); overflow-y:auto;"
            ):
                if not queue_state:
                    ui.label("아래 썸네일을 누르면 이 목록 맨 아래에 순서대로 쌓입니다.").style(
                        "font-size:12px; color:var(--color-ink-muted); font-weight:600; padding:8px 4px;"
                    )
                for i, item in enumerate(queue_state):
                    qid = item.get("id") or ""
                    with ui.element("div").style(
                        "display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px; "
                        "border:1px solid var(--color-line-strong); background:var(--bg-canvas);"
                    ):
                        ui.label(f"{i + 1}. {item['title']}").style(
                            "flex:1; min-width:0; font-size:12px; font-weight:800; color:var(--color-ink); "
                            "overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                        )

                        def mk_up(uid=qid):
                            def _():
                                try:
                                    idx = next(j for j, x in enumerate(queue_state) if x.get("id") == uid)
                                except StopIteration:
                                    return
                                if idx > 0:
                                    queue_state[idx - 1], queue_state[idx] = queue_state[idx], queue_state[idx - 1]
                                    queue_panel.refresh()

                            return _

                        def mk_dn(uid=qid):
                            def _():
                                try:
                                    idx = next(j for j, x in enumerate(queue_state) if x.get("id") == uid)
                                except StopIteration:
                                    return
                                if idx < len(queue_state) - 1:
                                    queue_state[idx + 1], queue_state[idx] = queue_state[idx], queue_state[idx + 1]
                                    queue_panel.refresh()

                            return _

                        def mk_rm(uid=qid):
                            def _():
                                kept = [x for x in queue_state if x.get("id") != uid]
                                queue_state.clear()
                                queue_state.extend(kept)
                                queue_panel.refresh()

                            return _

                        ui.button("↑", on_click=mk_up()).props("dense flat round").style(
                            "min-width:32px; font-weight:900; color:var(--color-ink-soft) !important;"
                        )
                        ui.button("↓", on_click=mk_dn()).props("dense flat round").style(
                            "min-width:32px; font-weight:900; color:var(--color-ink-soft) !important;"
                        )
                        ui.button("✕", on_click=mk_rm()).props("dense flat round").style(
                            "min-width:32px; font-weight:900; color:var(--color-danger) !important;"
                        )

        def clear_queue():
            queue_state.clear()
            queue_panel.refresh()

        def do_merge():
            picks: list[tuple[Path, int]] = []
            for item in queue_state:
                p = _safe_outputs_pdf_rel(item["rel"])
                if p:
                    picks.append((p, int(item["page"])))
            if not picks:
                ui.notify("조합할 페이지가 없습니다.", type="warning")
                return
            try:
                from uuid import uuid4

                u = _username_for_storage() or "user"
                safe_u = "".join((c if (c.isalnum() or c in "-_") else "_") for c in u)[:20]
                out_name = f"조합_{safe_u}_{uuid4().hex[:8]}.pdf"
                out_path = _OUTPUTS_DIR / out_name
                merge_pdf_pages_from_pick_list(picks, out_path)
            except Exception as exc:
                ui.notify(f"합치기 실패: {exc}", type="negative")
                return
            store = _SESSION_RESULTS.setdefault(_session_id(), [])
            if out_path not in store:
                store.append(out_path)
            rel = out_path.relative_to(_OUTPUTS_DIR).as_posix()
            ui.notify("조합 PDF가 저장되었습니다. 다운로드가 시작됩니다.", type="positive")
            ui.run_javascript(f"window.location.href = '/download/pdf/{urllib.parse.quote(rel)}';")

        with ui.element("div").style(
            "display:grid; grid-template-columns:minmax(0, 1fr) 300px; gap:20px; align-items:start;"
        ):
            with ui.element("div").style("min-width:0;"):
                ui.label("출처 PDF · 페이지 선택").style(
                    "font-size:13px; font-weight:900; color:var(--color-ink); margin-bottom:12px;"
                )
                for pdf_path in sources:
                    rel = pdf_path.relative_to(_OUTPUTS_DIR).as_posix()
                    disp = pdf_path.name if len(pdf_path.name) <= 40 else pdf_path.name[:37] + "…"
                    try:
                        n_pages = pdf_page_count(pdf_path)
                    except Exception:
                        n_pages = 0
                    if n_pages <= 0:
                        continue
                    with ui.element("div").style(
                        "margin-bottom:16px; padding:14px 14px 16px; border:1px solid var(--color-line-strong); "
                        "border-radius:12px; background:var(--bg-surface); box-shadow:var(--shadow-card);"
                    ):
                        ui.label(disp).style(
                            "font-size:13px; font-weight:900; color:var(--color-ink); margin-bottom:10px; display:block;"
                        )
                        ui.label(f"{n_pages}쪽 · 썸네일을 눌러 조합에 추가").style(
                            "font-size:11px; color:var(--color-ink-soft); font-weight:600; margin-bottom:8px;"
                        )
                        with ui.element("div").style("overflow-x:auto; width:100%; max-height:240px; padding-bottom:6px;"):
                            with ui.row().classes("gap-2").style("flex-wrap:nowrap; padding:4px 2px 8px;"):
                                for pidx in range(n_pages):
                                    qrel = urllib.parse.quote(rel)
                                    thumb_url = f"/files/thumb/{qrel}?page={pidx}&t={int(time.time())}"

                                    def mk_add(r=rel, pi=pidx, dn=disp):
                                        def _():
                                            queue_state.append(
                                                {
                                                    "id": _compose_qid().hex,
                                                    "rel": r,
                                                    "page": pi,
                                                    "title": f"{dn} · {pi + 1}쪽",
                                                }
                                            )
                                            queue_panel.refresh()

                                        return _

                                    with ui.element("button").on("click", mk_add()).style(
                                        "flex-shrink:0; width:92px; padding:6px; border-radius:10px; cursor:pointer; "
                                        "border:1px solid var(--color-line-strong); background:var(--bg-canvas); "
                                        "font-family:inherit; text-align:center;"
                                    ):
                                        ui.html(
                                            f'<img src="{thumb_url}" alt="" '
                                            'style="width:80px;height:56px;object-fit:cover;border-radius:6px;'
                                            'background:#fff;border:1px solid var(--color-line);pointer-events:none;"/>'
                                            f'<div style="margin-top:4px;font-size:10px;font-weight:900;color:var(--color-ink-soft);">'
                                            f"{pidx + 1}쪽</div>"
                                        )

            with ui.element("div").style(
                "position:sticky; top:12px; padding:16px; border-radius:12px; border:1px solid var(--color-line-strong); "
                "background:var(--bg-surface); box-shadow:var(--shadow-card);"
            ):
                ui.label("조합 순서").style(
                    "font-size:13px; font-weight:900; color:var(--color-ink); margin-bottom:10px;"
                )
                queue_panel()
                with ui.element("div").style("display:flex; flex-direction:column; gap:8px; margin-top:12px;"):
                    ui.button("선택 순서대로 PDF 합치기", on_click=do_merge).props("color=primary unelevated").style(
                        "width:100%; font-weight:900; border-radius:10px; padding:12px 8px;"
                    )
                    ui.button("목록 비우기", on_click=clear_queue).props("flat dense").style(
                        "width:100%; font-weight:800; color:var(--color-ink-soft) !important;"
                    )
                    ui.button("← 결과 화면", on_click=lambda: ui.navigate.to("/results")).props("unelevated dense").style(
                        "width:100%; font-weight:800; border-radius:10px; "
                        "background:var(--bg-canvas); color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                    )

    app_shell(current_step=4, render_body=render_body, hero=render_hero)


@ui.page("/results")
def results_page():
    if require_auth() is None: return
    pdfs = _SESSION_RESULTS.get(_session_id(), [])
    
    # 결과 PDF가 있으면 현재 선택된 단원의 이력에 묶어서 갱신 (계정별)
    if pdfs:
        try:
            unit_path = getattr(library_page, "_selected_unit_path", None)
            if unit_path and Path(unit_path).exists():
                _record_unit_use(unit_path, output_pdfs=pdfs, username=_username_for_storage())
        except Exception as exc:
            print(f"[history 갱신 실패] {exc}")

    def render_hero():
        with ui.element("div").classes("page-hero"):
            ui.label("STEP 4 / 4").style("font-size:12px; font-weight:800; color:var(--color-primary); letter-spacing:0.05em; margin-bottom:8px;")
            ui.label("자료 생성 완료!").style("font-size:32px; font-weight:800; letter-spacing:-0.03em; color:var(--color-ink); margin-bottom:8px;")
            if pdfs:
                ui.label(f"성공적으로 {len(pdfs)}개의 학습지가 만들어졌습니다.").style("font-size:15px; color:var(--color-ink-soft);")

    def render_body():
        if not pdfs:
            ui.button("← 처음으로", on_click=lambda: ui.navigate.to("/")).props("flat")
            return

        side_refs: dict[str, dict] = {}
        current = {"pdf": pdfs[0]}

        with ui.element("div").style("display:grid; grid-template-columns:320px 1fr; gap:24px; height:calc(100vh - 240px); min-height:600px;"):
            with ui.element("div").style("background:var(--bg-surface); border-radius:var(--radius-lg); box-shadow:var(--shadow-card); padding:20px; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--color-line-strong);"):
                ui.label("생성된 차시 목록").style("font-size:14px; font-weight:800; color:var(--color-ink); margin-bottom:16px;")
                with ui.scroll_area().style("flex:1; min-height:0; padding-right:8px;"):
                    cards_col = ui.column().style("gap:12px; width:100%;")
                    with cards_col:
                        for idx, pdf_path in enumerate(pdfs):
                            is_first = (idx == 0)
                            card_classes = "pdf-card active" if is_first else "pdf-card"
                            card = ui.element("button").classes(card_classes).style(
                                f"padding:12px; border-radius:12px; cursor:pointer; text-align:left; display:flex; gap:12px; align-items:center; font-family:inherit; width:100%;"
                            )
                            with card:
                                rel_pdf_path = pdf_path.relative_to(_OUTPUTS_DIR).as_posix()
                                thumb_url = f"/files/thumb/{urllib.parse.quote(rel_pdf_path)}?t={int(time.time())}"
                                ui.html(f'<img src="{thumb_url}" style="width:64px; height:46px; object-fit:cover; border-radius:6px; background:white; flex-shrink:0; pointer-events:none; border:1px solid var(--color-line-strong);" />')
                                with ui.element("div").style("flex:1; min-width:0; pointer-events:none;"):
                                    display_name = pdf_path.stem.split('_')[-1] if '_' in pdf_path.stem else pdf_path.stem
                                    ui.label(display_name).classes("card-title").style("font-size:14px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:2px;")
                                    size_kb = pdf_path.stat().st_size / 1024
                                    ui.label(f"{size_kb:.0f} KB · PDF").classes("card-sub").style("font-size:11px; display:block;")
                            side_refs[pdf_path.name] = {"card": card, "pdf": pdf_path}

                with ui.element("div").style("padding-top:16px; border-top:1px solid var(--color-line-strong); margin-top:12px; display:flex; flex-direction:column; gap:10px;"):
                    def trigger_download():
                        rel_current = current['pdf'].relative_to(_OUTPUTS_DIR).as_posix()
                        url = f"/download/pdf/{urllib.parse.quote(rel_current)}"
                        ui.run_javascript(f"window.location.href = '{url}';")
                    
                    def trigger_zip_download():
                        ui.notify(f"{len(pdfs)}개 PDF를 ZIP으로 다운로드합니다…", type="info")
                        ui.run_javascript("window.location.href = '/download/zip/current';")

                    ui.button("현재 PDF 다운로드", on_click=trigger_download).props("color=primary unelevated size=lg").style("border-radius:12px; font-size:14px;")

                    def add_current_to_archive():
                        un = _username_for_storage()
                        p = current.get("pdf")
                        if not un:
                            ui.notify("로그인이 필요합니다.", type="warning")
                            return
                        if not isinstance(p, Path) or not p.is_file():
                            ui.notify("현재 PDF가 없습니다.", type="warning")
                            return
                        ok = _archive_add_pdf_for_user(un, p)
                        ui.notify("자료 보관함에 추가됨" if ok else "보관함 추가 실패", type="positive" if ok else "negative")

                    ui.button("자료보관함에 넣기", on_click=add_current_to_archive).props("unelevated").style(
                        "border-radius:12px; font-size:13px; background:var(--color-primary); "
                        "color:white !important; border:1px solid var(--color-line-strong); "
                        "font-weight:900; padding:10px 12px;"
                    )

                    ui.button("페이지 골라 조합하기", on_click=lambda: ui.navigate.to("/compose")).props("unelevated").style(
                        "border-radius:12px; font-size:13px; background:var(--bg-canvas); "
                        "color:var(--color-ink) !important; border:1px solid var(--color-line-strong); "
                        "font-weight:900; padding:10px 12px;"
                    )

                    # 차시가 2개 이상일 때만 ZIP 일괄 다운로드 노출
                    if len(pdfs) >= 2:
                        zip_btn_label = f"전체 {len(pdfs)}개 PDF · ZIP 다운로드"
                        ui.button(zip_btn_label, on_click=trigger_zip_download).props("unelevated").style(
                            "border-radius:12px; font-size:13px; background:var(--bg-canvas); "
                            "color:var(--color-ink) !important; border:1px solid var(--color-line-strong); "
                            "font-weight:700; padding:8px 12px;"
                        )

                    # QR 공유 다운로드
                    share_dialog = ui.dialog()
                    with share_dialog:
                        with ui.element("div").style("padding:18px 18px; width:min(520px, 92vw);"):
                            ui.label("휴대폰으로 다운로드").style("font-size:16px; font-weight:900; color:var(--color-ink);")
                            ui.label("QR을 스캔하면 파일 목록 페이지가 열립니다.").style("font-size:12px; color:var(--color-ink-soft); margin-top:4px;")
                            ui.element("div").style("height:12px;")
                            sid_for_share = _session_id()
                            share_url = f"/share/{urllib.parse.quote(sid_for_share)}"
                            ui.html(
                                '<div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap;">'
                                '<div style="background:white; border:1px solid var(--color-line-strong); border-radius:14px; padding:12px; box-shadow:var(--shadow-card);">'
                                f'<img alt="QR" width="220" height="220" style="display:block;" src="/share/qr/{urllib.parse.quote(sid_for_share)}.png?t={int(time.time())}" />'
                                '</div>'
                                '<div style="flex:1; min-width:220px;">'
                                '<div style="font-size:12px; font-weight:900; color:var(--color-ink-faint); letter-spacing:0.08em;">LINK</div>'
                                f'<div class="mono" style="margin-top:8px; font-size:12px; color:var(--color-ink); word-break:break-all; background:white; border:1px solid var(--color-line-strong); border-radius:12px; padding:10px 10px;">'
                                f'{share_url}'
                                '</div>'
                                '</div>'
                                '</div>'
                            )
                            with ui.element("div").style("margin-top:12px; display:flex; gap:10px; justify-content:flex-end;"):
                                def copy_link():
                                    ui.run_javascript(
                                        f"""
                                        (async function(){{
                                          const url = window.location.origin + {share_url!r};
                                          try {{ await navigator.clipboard.writeText(url); }}
                                          catch(e) {{
                                            const ta=document.createElement('textarea'); ta.value=url; document.body.appendChild(ta);
                                            ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                                          }}
                                        }})();
                                        """
                                    )
                                    ui.notify("링크 복사됨", type="positive")

                                ui.button("링크 복사", on_click=copy_link).props("unelevated").style(
                                    "border-radius:12px; font-weight:900; background:var(--bg-canvas); "
                                    "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                )
                                def close_share_dialog():
                                    ui.notify("닫힘", type="info")
                                    try:
                                        share_dialog.close()
                                    except Exception:
                                        pass
                                    # JS fallback: ESC로도 닫기 시도
                                    ui.run_javascript(
                                        "try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));}catch(e){}"
                                    )

                                ui.button("닫기", on_click=close_share_dialog).props("unelevated").style(
                                    "border-radius:12px; font-weight:900; background:transparent; "
                                    "color:var(--color-ink) !important; border:1px solid var(--color-line-strong);"
                                )

                    def open_share_qr():
                        share_dialog.open()
                        pass

                    ui.button("QR로 휴대폰 다운로드", on_click=open_share_qr).props("unelevated").style(
                        "border-radius:12px; font-size:13px; background:var(--bg-canvas); "
                        "color:var(--color-ink) !important; border:1px solid var(--color-line-strong); "
                        "font-weight:900; padding:10px 12px;"
                    )
                    
                    ui.button("새로 만들기", on_click=lambda: (_reset_session(), ui.navigate.to("/"))).style("background:var(--bg-canvas); color:var(--color-ink-soft) !important; border:1px solid var(--color-line-strong); border-radius:12px; padding:10px; box-shadow:none; font-weight:700; font-size:14px; cursor:pointer;")

            with ui.element("div").style("background:var(--bg-surface); border-radius:var(--radius-lg); box-shadow:var(--shadow-card); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--color-line-strong);"):
                with ui.element("div").style("padding:14px 20px; border-bottom:1px solid var(--color-line-strong); display:flex; align-items:center; gap:12px; background:var(--bg-canvas);"):
                    ui.html('<div style="display:flex; gap:6px;"><div style="width:10px;height:10px;border-radius:50%;background:#EF4444;"></div><div style="width:10px;height:10px;border-radius:50%;background:#F59E0B;"></div><div style="width:10px;height:10px;border-radius:50%;background:#10B981;"></div></div>')
                    current_name_label = ui.label(pdfs[0].name).style("font-size:14px; font-weight:700; color:var(--color-ink); margin-left:8px;")
                with ui.element("div").style("flex:1; background:#E2E8F0; position:relative; min-height:0; overflow:hidden;"):
                    initial_preview = _build_preview_html(pdfs[0], int(time.time()))
                    preview_container = ui.html(
                        f'<div id="preview-images-wrap" style="height:100%; width:100%;">{initial_preview}</div>'
                    ).style("width:100%; height:100%;")

        def make_card_click(pdf_path):
            def handler():
                current["pdf"] = pdf_path
                for name, r in side_refs.items():
                    if r["pdf"] == pdf_path:
                        r["card"].classes(add="active")
                    else:
                        r["card"].classes(remove="active")
                # 이미지 리스트 HTML 재생성 → JS로 innerHTML 교체
                # (JS로 직접 innerHTML을 쓰면 DOMPurify를 거치지 않지만,
                #  어차피 img만 들어있으므로 sanitize해도 모두 통과함. 안전.)
                new_inner = _build_preview_html(pdf_path, int(time.time()))
                # JS 템플릿 리터럴에 안전하게 넣기 위해 backtick과 백슬래시 이스케이프
                safe = (
                    new_inner
                    .replace('\\', '\\\\')
                    .replace('`', '\\`')
                    .replace('$', '\\$')
                )
                ui.run_javascript(
                    f"const w=document.getElementById('preview-images-wrap');"
                    f"if(w){{w.innerHTML=`{safe}`;}}"
                )
                current_name_label.set_text(pdf_path.name)
            return handler

        for name, ref in side_refs.items():
            ref["card"].on("click", make_card_click(ref["pdf"]))

    app_shell(current_step=4, render_body=render_body, hero=render_hero)

def _reset_session():
    sid = _session_id()
    _SESSIONS.pop(sid, None)
    _SESSION_RESULTS.pop(sid, None)


def _resolve_listen_port(host: str, preferred: int, span: int = 50) -> int:
    """PORT가 이미 사용 중이면 preferred+1 … 순으로 비어 있는 포트를 고른다."""
    import socket

    for port in range(preferred, preferred + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"포트 {preferred}~{preferred + span - 1}이(가) 모두 사용 중입니다. "
        "다른 python app.py를 종료하거나 PORT 환경변수로 비어 있는 포트를 지정하세요."
    )


if __name__ in {"__main__", "__mp_main__"}:
    if os.environ.get("CLASSROOM_INTEGRATED") == "1":
        from classroom_sso import install_classroom_sso

        install_classroom_sso(ui, app, _on_login_success, uuid4)

    _host = os.environ.get("HOST", "0.0.0.0")
    _preferred_port = int(os.environ.get("PORT", "8080"))
    _cloud = bool(
        os.environ.get("FLY_APP_NAME")
        or os.environ.get("RAILWAY_ENVIRONMENT")
        or os.environ.get("RENDER")
        or os.environ.get("K_SERVICE")
    )
    if os.environ.get("CLASSROOM_INTEGRATED") == "1" and os.environ.get("PORT"):
        _host = os.environ.get("HOST", "127.0.0.1")
        _port = int(os.environ["PORT"])
    elif _cloud and os.environ.get("PORT"):
        _port = int(os.environ["PORT"])
    else:
        _port = _resolve_listen_port(_host, _preferred_port)
        if _port != _preferred_port:
            print(f"[lesson-app] 포트 {_preferred_port} 사용 중 → {_port} 로 시작합니다.", flush=True)
    _run_kwargs = dict(
        title="수업준비 · Lesson Studio",
        host=_host,
        port=_port,
        storage_secret=os.environ.get("STORAGE_SECRET", "lesson_studio_secret_key_2026"),
        reload=False,
    )
    _root = (os.environ.get("LESSON_ROOT_PATH") or "").strip()
    if _root:
        _run_kwargs["root_path"] = _root
    ui.run(**_run_kwargs)