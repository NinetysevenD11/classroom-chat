"""로컬 회원 계정 저장 (data/accounts.json). 비밀번호는 bcrypt 해시만 저장."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

_lock = threading.RLock()

# Python 3: \w 는 유니코드 글자(한글 아이디 등)를 포함
_RE_USER = re.compile(r"^[\w.-]{3,32}$", re.UNICODE)
_RE_RRN = re.compile(r"^\d{6}-?\d{7}$")
_RE_PHONE = re.compile(r"^0\d{1,2}-?\d{3,4}-?\d{4}$")


def _norm_rrn(s: str) -> str:
    s = (s or "").strip().replace(" ", "")
    if len(s) == 13 and s.isdigit():
        return f"{s[:6]}-{s[6:]}"
    return s


def _norm_phone(s: str) -> str:
    return (s or "").strip().replace(" ", "")


def validate_signup(
    username: str,
    password: str,
    password2: str,
    name: str,
    resident_id: str,
    phone: str,
    email: str,
) -> tuple[bool, str]:
    u = (username or "").strip()
    if not _RE_USER.match(u):
        return False, "아이디는 3~32자, 영문·숫자·._- 만 사용할 수 있습니다."
    if len(password or "") < 8:
        return False, "비밀번호는 8자 이상이어야 합니다."
    if password != password2:
        return False, "비밀번호 확인이 일치하지 않습니다."
    if not (name or "").strip():
        return False, "이름을 입력하세요."
    rid = _norm_rrn(resident_id)
    if not _RE_RRN.match(rid):
        return False, "주민등록번호 형식을 확인하세요. (예: 990101-1234567)"
    ph = _norm_phone(phone)
    if not _RE_PHONE.match(ph):
        return False, "전화번호 형식을 확인하세요. (예: 010-1234-5678)"
    em = (email or "").strip()
    if em and "@" not in em:
        return False, "이메일 형식이 올바르지 않습니다."
    return True, ""


def load_accounts(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        users = raw.get("users") if isinstance(raw, dict) else None
        if not isinstance(users, dict):
            return {}
        out: dict[str, dict] = {}
        for k, v in users.items():
            if isinstance(k, str) and isinstance(v, dict) and "password_hash" in v:
                out[k] = v
        return out
    except Exception:
        return {}


def save_accounts(path: Path, users: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"users": users}
    tmp = path.with_suffix(".tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    with _lock:
        tmp.write_text(data, encoding="utf-8")
        tmp.replace(path)


def verify_password(
    path: Path, username: str, password: str, env_plain: dict[str, str]
) -> bool:
    """LESSON_APP_USERS(평문) 우선, 없으면 accounts.json의 bcrypt."""
    u = (username or "").strip()
    if env_plain.get(u) == password:
        return True
    import bcrypt

    row = load_accounts(path).get(u)
    if not row:
        return False
    h = row.get("password_hash")
    if not h or not isinstance(h, str):
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), h.encode("ascii"))
    except Exception:
        return False


def register_new_user(
    path: Path,
    username: str,
    password: str,
    password2: str,
    name: str,
    resident_id: str,
    phone: str,
    email: str,
) -> tuple[bool, str]:
    ok, err = validate_signup(
        username, password, password2, name, resident_id, phone, email
    )
    if not ok:
        return False, err
    import bcrypt

    u = (username or "").strip()
    with _lock:
        users = load_accounts(path)
        if u in users:
            return False, "이미 사용 중인 아이디입니다."
        phash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode(
            "ascii"
        )
        users[u] = {
            "password_hash": phash,
            "name": (name or "").strip(),
            "resident_registration_number": _norm_rrn(resident_id),
            "phone": _norm_phone(phone),
            "email": (email or "").strip(),
        }
        save_accounts(path, users)
    return True, ""


def delete_user(path: Path, username: str) -> tuple[bool, str]:
    """accounts.json에서 사용자 삭제. (환경변수 계정은 삭제 불가)"""
    u = (username or "").strip()
    if not u:
        return False, "아이디가 비어 있습니다."
    with _lock:
        users = load_accounts(path)
        if u not in users:
            return False, "해당 사용자는 accounts.json에 없습니다."
        users.pop(u, None)
        save_accounts(path, users)
    return True, ""
