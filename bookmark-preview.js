const FETCH_TIMEOUT_MS = 7000;
const MAX_HTML_BYTES = 512 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ClassroomBookmarkBot/1.0; +https://classroom-chat)";

function normalizePageUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  if (h.startsWith("127.")) return true;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (h.startsWith("169.254.")) return true;
  if (h === "::1" || h.startsWith("fe80:")) return true;
  return false;
}

export function assertPublicHttpUrl(raw) {
  const normalized = normalizePageUrl(raw);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("올바른 주소가 아닙니다.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("http/https 주소만 지원합니다.");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("내부 주소는 미리보기를 만들 수 없습니다.");
  }
  return parsed.href;
}

function resolveMaybeRelative(baseUrl, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  try {
    return new URL(v, baseUrl).href;
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function pickMetaContent(html, attr, key) {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`,
    "i"
  );
  const m = html.match(re);
  return decodeHtmlEntities(m?.[1] || m?.[2] || "");
}

function pickLinkImage(html, baseUrl) {
  const re =
    /<link[^>]+rel=["'](?:image_src|shortcut icon|icon)["'][^>]+href=["']([^"']+)["']|<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:image_src|shortcut icon|icon)["']/gi;
  let best = "";
  let m;
  while ((m = re.exec(html))) {
    const href = resolveMaybeRelative(baseUrl, m[1] || m[2]);
    if (!href) continue;
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(href)) {
      best = href;
      break;
    }
    if (!best) best = href;
  }
  return best;
}

function isLikelyImageUrl(url) {
  if (!url) return false;
  if (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url)) return true;
  if (/og|image|thumb|preview|banner|hero/i.test(url)) return true;
  return /^https?:\/\//i.test(url);
}

function screenshotFallbackUrl(pageUrl) {
  return `https://s0.wp.com/mshots/v1/${encodeURIComponent(pageUrl)}?w=640`;
}

export async function fetchBookmarkPreview(rawUrl) {
  const pageUrl = assertPublicHttpUrl(rawUrl);

  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { previewUrl: screenshotFallbackUrl(pageUrl), source: "screenshot" };
    }

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { previewUrl: screenshotFallbackUrl(pageUrl), source: "screenshot" };
    }

    const reader = res.body?.getReader?.();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder("utf-8");
      let total = 0;
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
    } else {
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
    }

    const finalUrl = res.url || pageUrl;
    const candidates = [
      pickMetaContent(html, "property", "og:image"),
      pickMetaContent(html, "property", "og:image:url"),
      pickMetaContent(html, "property", "og:image:secure_url"),
      pickMetaContent(html, "name", "twitter:image"),
      pickMetaContent(html, "name", "twitter:image:src"),
      pickLinkImage(html, finalUrl),
    ]
      .map((v) => resolveMaybeRelative(finalUrl, v))
      .filter((v) => isLikelyImageUrl(v));

    if (candidates.length) {
      return { previewUrl: candidates[0], source: "meta" };
    }
  } catch (_) {
    /* fall through to screenshot */
  }

  return { previewUrl: screenshotFallbackUrl(pageUrl), source: "screenshot" };
}
