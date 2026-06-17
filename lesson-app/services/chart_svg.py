"""data_interpretation용 막대·꺽은선 차트 SVG (외부 matplotlib 없이)."""
from __future__ import annotations

import html
from typing import Any


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def chart_spec_to_svg(spec: dict | None) -> str:
    """
    chart_spec: chart_type none|bar|line, labels[], values[], y_unit(선택).
    labels·values 길이가 같고 2개 이상일 때만 SVG 반환.
    """
    if not spec or not isinstance(spec, dict):
        return ""
    ct = (spec.get("chart_type") or "none").strip().lower()
    if ct in ("none", "", "null"):
        return ""
    labels = [html.escape(str(x).strip()) for x in (spec.get("labels") or []) if str(x).strip()]
    raw_vals = spec.get("values") or []
    values: list[float] = []
    for x in raw_vals:
        n = _num(x)
        if n is None:
            return ""
        values.append(n)
    if len(labels) != len(values) or len(labels) < 2:
        return ""
    y_unit = html.escape(str(spec.get("y_unit") or "").strip())
    if ct == "bar":
        return _bar_svg(labels, values, y_unit)
    if ct == "line":
        return _line_svg(labels, values, y_unit)
    return ""


def _bar_svg(labels: list[str], values: list[float], y_unit: str) -> str:
    """막대는 항상 Y=0 기준(또는 음수 포함 시 0 이하)으로 높이를 잡아 작은 값도 비율이 맞게 보이게 함."""
    w, h = 420, 220
    pad_l, pad_r, pad_t, pad_b = 50, 14, 32, 56
    inner_w = w - pad_l - pad_r
    inner_h = h - pad_t - pad_b
    lo = min(values)
    hi = max(values)
    # 막대 차트: 기준선을 0에 두고 최댓값까지 스팬 (최솟값만큼만 올린 양수 구간은 오해 소지 큼)
    vmin = min(0.0, lo)
    vmax = max(hi, vmin + 1e-9)
    if vmax <= vmin:
        vmax = vmin + 1.0
    span = vmax - vmin
    n = len(values)
    gap = 6
    bar_w = max(8, (inner_w - gap * (n + 1)) / n)

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        'role="img" aria-label="막대 그래프" style="max-width:100%;height:auto;">',
        '<rect x="0" y="0" width="100%" height="100%" fill="#fafafa" stroke="#ddd" rx="6"/>',
    ]
    if y_unit:
        parts.append(
            f'<text x="8" y="18" font-size="10" fill="#555">{y_unit}</text>'
        )
    x0, y0 = pad_l, h - pad_b
    x1, y1 = w - pad_r, pad_t
    # 가로·세로축
    parts.append(
        f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}" stroke="#333" stroke-width="1"/>'
    )
    parts.append(
        f'<line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}" stroke="#333" stroke-width="1"/>'
    )
    # Y 눈금·보조선 (vmin → vmax, 아래→위)
    tick_candidates = [vmin, vmin + 0.5 * span, vmax]
    tick_gvs = sorted({round(t, 5) for t in tick_candidates})
    for gv in tick_gvs:
        gy = y0 - (gv - vmin) / span * inner_h
        parts.append(
            f'<line x1="{x0 - 4:.1f}" y1="{gy:.1f}" x2="{x0}" y2="{gy:.1f}" stroke="#999" stroke-width="1"/>'
        )
        if vmin < gv < vmax:
            parts.append(
                f'<line x1="{x0}" y1="{gy:.1f}" x2="{x1}" y2="{gy:.1f}" stroke="#e5e7eb" stroke-width="1"/>'
            )
        lab = f"{gv:.1f}".rstrip("0").rstrip(".") if abs(gv - round(gv)) > 1e-4 else str(int(round(gv)))
        parts.append(
            f'<text x="{x0 - 6:.1f}" y="{gy + 3:.1f}" font-size="8" text-anchor="end" fill="#666">{lab}</text>'
        )

    bx = x0 + gap
    for i, (lab, val) in enumerate(zip(labels, values)):
        ratio = (val - vmin) / span
        bh = max(3, ratio * inner_h)
        x = bx + i * (bar_w + gap)
        y = y0 - bh
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{bh:.1f}" '
            'fill="#2563eb" rx="2"/>'
        )
        vlab = f"{val:g}" if abs(val - round(val)) > 1e-6 else str(int(round(val)))
        ty = max(y1 + 4, y - 4)
        parts.append(
            f'<text x="{x + bar_w / 2:.1f}" y="{ty:.1f}" font-size="9" text-anchor="middle" '
            f'fill="#1e3a8a" font-weight="700">{html.escape(vlab)}</text>'
        )
        parts.append(
            f'<text x="{x + bar_w / 2:.1f}" y="{y0 + 12}" font-size="8" text-anchor="middle" fill="#333">{lab}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def _line_svg(labels: list[str], values: list[float], y_unit: str) -> str:
    w, h = 420, 220
    pad_l, pad_r, pad_t, pad_b = 50, 14, 32, 56
    inner_w = w - pad_l - pad_r
    inner_h = h - pad_t - pad_b
    lo, hi = min(values), max(values)
    vmin = min(0.0, lo)
    vmax = max(hi, vmin + 1e-9)
    if vmax <= vmin:
        vmax = vmin + 1.0
    span = vmax - vmin
    n = len(values)
    if n < 2:
        return ""

    def x_at(i: int) -> float:
        return pad_l + (inner_w * i / (n - 1))

    def y_at(val: float) -> float:
        return (h - pad_b) - ((val - vmin) / span) * inner_h

    pts = " ".join(f"{x_at(i):.1f},{y_at(v):.1f}" for i, v in enumerate(values))

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        'role="img" aria-label="꺾은선 그래프" style="max-width:100%;height:auto;">',
        '<rect x="0" y="0" width="100%" height="100%" fill="#fafafa" stroke="#ddd" rx="6"/>',
    ]
    if y_unit:
        parts.append(
            f'<text x="6" y="16" font-size="10" fill="#555">{y_unit}</text>'
        )
    x0, y0 = pad_l, h - pad_b
    x1, y1 = w - pad_r, pad_t
    parts.append(
        f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}" stroke="#333" stroke-width="1"/>'
    )
    parts.append(
        f'<line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}" stroke="#333" stroke-width="1"/>'
    )
    parts.append(
        f'<polyline fill="none" stroke="#059669" stroke-width="2.5" points="{pts}"/>'
    )
    for i, (lab, val) in enumerate(zip(labels, values)):
        cx, cy = x_at(i), y_at(val)
        parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="4" fill="#059669" stroke="#fff" stroke-width="1"/>'
        )
        parts.append(
            f'<text x="{cx:.1f}" y="{y0 + 14}" font-size="9" text-anchor="middle" fill="#333">{lab}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)
