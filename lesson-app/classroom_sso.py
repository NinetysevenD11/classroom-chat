"""교실도구(Node) 로그인과 SSO 연동."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Callable


def verify_classroom_sso_token(token: str) -> str | None:
    secret = (os.environ.get("CLASSROOM_SSO_SECRET") or "").strip()
    if not secret or not token or "." not in token:
        return None

    payload_b64, sig = token.split(".", 1)
    expected = hmac.new(
        secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).digest()
    expected_sig = base64.urlsafe_b64encode(expected).decode("ascii").rstrip("=")
    if not hmac.compare_digest(sig, expected_sig):
        return None

    pad = "=" * (-len(payload_b64) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload_b64 + pad)
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return None

    user_id = str(data.get("userId") or "").strip()
    exp = int(data.get("exp") or 0)
    if not user_id or exp < int(time.time() * 1000):
        return None
    return user_id


def install_classroom_sso(
    ui,
    app,
    on_login_success: Callable[[str, str], None],
    uuid4,
) -> None:
    @ui.page("/classroom-sso")
    def classroom_sso_page(token: str = ""):
        user_id = verify_classroom_sso_token(token)
        sid = app.storage.user.get("session_id")
        if not sid:
            sid = str(uuid4())
            app.storage.user["session_id"] = sid

        if user_id:
            on_login_success(sid, user_id)
            ui.navigate.to("/")
            return

        with ui.column().classes("w-full items-center justify-center").style(
            "min-height:60vh;padding:24px;text-align:center;"
        ):
            ui.label("교실도구 로그인 연동에 실패했습니다.").style(
                "font-size:16px;font-weight:700;color:#c0392b;"
            )
            ui.label(
                "교실도구에서 다시 로그인한 뒤 「수업 자료 생성」 메뉴를 열어 주세요."
            ).style("font-size:13px;color:#666;margin-top:8px;")
