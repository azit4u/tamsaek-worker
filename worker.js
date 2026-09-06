/**
 * tamsaek-worker — 탐색팩(tamsaekPack)용 검색 그라운딩 + AI 이미지 워커.
 *
 * Cloudflare Workers 무료 플랜에 단독 배포되는 API 키 없는 워커로,
 * 탐색팩 플러그인의 "검색 Worker 주소" 칸에 배포 주소를 넣으면 바로 동작한다.
 *
 * 라우트:
 *   GET      /api/search?q={검색어}&engine=all|naver|daum|bing|google&start=0
 *   GET/POST /api/image   { prompt, topic?, style?, width?, height? }
 *   GET      /            간단 안내 페이지
 *
 * 응답 계약(플러그인이 기대하는 형태):
 *   /api/search → { providers: [ { engine, label, results: [{title,url,snippet}] } ] }
 *   /api/image  → { success, provider, data_url }
 *
 * 인증(선택): `npx wrangler secret put WORKER_SECRET`으로 비밀값을 등록하면
 * 이후 모든 /api/* 요청은 X-AIBP-Secret 헤더가 그 값과 일치해야 한다.
 * 등록하지 않으면 인증 없이 동작한다(개인용 기본값).
 *
 * 검색은 각 검색 사이트의 공개 결과 페이지를 요청 시점에 직접 가져와 파싱한다.
 * 공식 API가 아니므로 상대 사이트의 HTML 변경·자동화 차단 시 결과가 줄어들
 * 수 있고, 그 경우에도 오류 대신 빈 결과를 반환해 글쓰기 자체는 막지 않는다.
 * Google 일반 웹검색은 서버(공유 IP) 환경에서 상시 차단(HTTP 429)되므로
 * 처음부터 Google 뉴스 RSS를 소스로 사용한다(결과는 뉴스 기사로 한정).
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-AIBP-Secret",
};

const UA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/* ── 공통 텍스트 유틸 ───────────────────────────── */

export function stripTags(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function dedupe(list, max = 10) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = (r.url || "").split("#")[0];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/* ── 네이버 ─────────────────────────────────────────
   2026-09 기준 네이버 통합검색은 해시 클래스(fender-ui_*)로 렌더링되지만,
   디자인 시스템 타입 클래스는 안정적으로 유지된다:
   제목 = sds-comps-text-type-headline1, 요약 = sds-comps-text-type-body1.
   제목 클래스를 품은 <a href> 를 결과로 보고, 그 뒤쪽에서 요약을 찾는다. */
export function parseNaver(html) {
  const out = [];
  const anchorRe = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,2500}?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const inner = m[2];
    if (inner.indexOf("sds-comps-text-type-headline1") === -1) continue;
    const url = stripTags(m[1]);
    let fullHost = "";
    try { fullHost = new URL(url).hostname; } catch { continue; }
    // 검색 내부 링크·광고·정적 리소스는 결과가 아니다.
    if (/^(search|m\.search|ader|adcr|help|nid|shopping|pay)\.naver\.com$/.test(fullHost)) continue;
    if (/(^|\.)pstatic\.net$/.test(fullHost)) continue;
    const title = stripTags((inner.match(/sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
    if (title.length < 4) continue;
    const tail = html.slice(m.index, m.index + 4000);
    const snippet = stripTags((tail.match(/sds-comps-text-type-body1[^>]*>([\s\S]*?)<\/span>/) || [])[1] || "");
    out.push({ title, url, snippet });
  }
  return dedupe(out);
}

/* ── 다음(Daum) ─────────────────────────────────────
   통합검색(w=tot)은 웹컴포넌트 커스텀 태그로 렌더링된다:
   <c-title data-href="원본URL">제목</c-title> 이 결과 한 건이고,
   근처의 <c-contents-desc>…</c-contents-desc> 가 본문 요약이다. */
export function parseDaum(html) {
  const out = [];
  const re = /<c-title\b[^>]*data-href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/c-title>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = stripTags(m[1]);
    const title = stripTags(m[2]);
    if (!title || title.length < 2) continue;
    if (/daum\.net\/|kakaocdn\.net/.test(url) && !/blog\.daum|brunch/.test(url)) continue;
    const tail = html.slice(m.index, m.index + 3000);
    const snippet = stripTags((tail.match(/<c-contents-desc\b[^>]*>([\s\S]*?)<\/c-contents-desc>/) || [])[1] || "");
    out.push({ title, url, snippet });
  }
  return dedupe(out);
}

/* ── 빙(Bing) ───────────────────────────────────────
   결과 한 건 = <li class="b_algo"> 블록, 제목 링크는 <h2><a href>.
   href 는 bing.com/ck/a?…&u=a1<base64url> 형태의 리다이렉트 주소라서
   u 파라미터의 base64(앞 2글자 "a1" 제거)를 풀어 원본 URL을 복원한다. */
export function decodeBingUrl(raw = "") {
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"));
    if (!/(^|\.)bing\.com$/.test(u.hostname) || u.pathname.indexOf("/ck/") !== 0) return raw;
    let v = u.searchParams.get("u") || "";
    if (v.slice(0, 2) === "a1") v = v.slice(2);
    v = v.replace(/-/g, "+").replace(/_/g, "/");
    while (v.length % 4) v += "=";
    const decoded = atob(v);
    // atob 결과는 latin1 바이트열이므로 UTF-8로 재해석한다.
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const real = new TextDecoder().decode(bytes);
    return real.indexOf("http") === 0 ? real : raw;
  } catch {
    return raw;
  }
}

export function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo[" ]/).slice(1);
  for (const block of blocks) {
    const a = block.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeBingUrl(stripTags(a[1]));
    const title = stripTags(a[2]);
    if (!title || url.indexOf("http") !== 0) continue;
    const snippet = stripTags(
      (block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) ||
       block.match(/<div class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || ""
    );
    out.push({ title, url, snippet });
  }
  return dedupe(out);
}

/* ── 구글 뉴스 RSS ──────────────────────────────── */
export function parseGoogleNewsRss(xml) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    const pick = (tag) => {
      const raw = (item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || "";
      // RSS 본문은 HTML이 한 번 더 이스케이프되어 있어 두 번 벗겨야 태그가 사라진다.
      return stripTags(stripTags(raw.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")));
    };
    const title = pick("title");
    const url = pick("link");
    if (!title || url.indexOf("http") !== 0) continue;
    out.push({ title, url, snippet: pick("description") });
  }
  return dedupe(out);
}

/* ── 엔진 정의 ─────────────────────────────────── */

const ENGINES = {
  naver: {
    label: "네이버",
    urls: (q, start) => [
      `https://search.naver.com/search.naver?query=${encodeURIComponent(q)}&start=${start + 1}`,
      `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(q)}&start=${start + 1}`,
    ],
    parse: parseNaver,
  },
  daum: {
    label: "다음",
    urls: (q) => [`https://search.daum.net/search?w=tot&q=${encodeURIComponent(q)}`],
    parse: parseDaum,
  },
  bing: {
    label: "Bing",
    urls: (q, start) => [`https://www.bing.com/search?q=${encodeURIComponent(q)}&mkt=ko-KR&setlang=ko&first=${start + 1}`],
    parse: parseBing,
  },
  google: {
    label: "뉴스",
    // Google 뉴스 RSS는 Cloudflare IP를 자주 차단(503)하므로 짧게만 시도하고,
    // 실패하면 같은 RSS 형식인 Bing 뉴스로 자동 대체한다.
    timeoutMs: 3000,
    urls: (q) => [
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`,
      `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&mkt=ko-KR`,
    ],
    parse: parseGoogleNewsRss,
  },
};

async function fetchText(url, timeoutMs = 8000, headers = UA_HEADERS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal, redirect: "follow" });
    return { status: res.status, text: res.ok ? await res.text() : "" };
  } finally {
    clearTimeout(t);
  }
}

async function runEngine(name, q, start) {
  const eng = ENGINES[name];
  const started = Date.now();
  let results = [];
  let status = 0;
  for (const url of eng.urls(q, start)) {
    try {
      const { status: s, text } = await fetchText(url, eng.timeoutMs || 6500, eng.headers || UA_HEADERS);
      status = s;
      if (text) results = eng.parse(text);
      if (results.length >= 3) break;
    } catch (e) {
      status = 599;
    }
  }
  return {
    engine: name,
    label: eng.label,
    upstream_status: status,
    latency_ms: Date.now() - started,
    results,
  };
}

async function handleSearch(request) {
  const u = new URL(request.url);
  // 플러그인이 q 값을 이중 인코딩해 보내는 경우가 있어 한 번 더 디코드를 시도한다.
  let q = (u.searchParams.get("q") || "").trim().slice(0, 200);
  if (/%[0-9a-fA-F]{2}/.test(q)) { try { q = decodeURIComponent(q); } catch { /* 그대로 사용 */ } }
  const engine = (u.searchParams.get("engine") || "all").toLowerCase();
  const start = Math.max(0, parseInt(u.searchParams.get("start") || "0", 10) || 0);

  if (!q) return json({ error: "q 파라미터가 필요합니다. 예: /api/search?q=검색어&engine=all" }, 400);
  const names = engine === "all" ? Object.keys(ENGINES) : engine.split(",").filter((n) => ENGINES[n]);
  if (!names.length) return json({ error: "engine은 all, naver, daum, bing, google 중 하나입니다." }, 400);

  const settled = await Promise.allSettled(names.map((n) => runEngine(n, q, start)));
  const providers = settled.map((s, i) => s.status === "fulfilled"
    ? s.value
    : { engine: names[i], label: ENGINES[names[i]].label, upstream_status: 599, latency_ms: 0, results: [] });

  return json({ query: q, engine, start, providers });
}

/* ── /api/image ─────────────────────────────────────
   Workers AI 바인딩(env.AI)이 있으면 이미지 모델을 순서대로 시도한다.
   모두 실패하면(바인딩 없음 포함) 항상 성공하는 SVG 카드로 폴백해
   호출 측이 절대 빈손이 되지 않게 한다. */

const IMAGE_MODELS = [
  { id: "@cf/black-forest-labs/flux-1-schnell", input: (p) => ({ prompt: p, steps: 8 }) },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", input: (p, w, h) => ({ prompt: p, width: w, height: h }) },
  { id: "@cf/lykon/dreamshaper-8-lcm", input: (p, w, h) => ({ prompt: p, width: w, height: h }) },
];

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function sniffMime(b64) {
  const head = atob(b64.slice(0, 12));
  if (head.charCodeAt(0) === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return "image/jpeg";
  return "image/png";
}

async function tryModel(env, model, prompt, w, h) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), 30000);
  try {
    const res = await env.AI.run(model.id, model.input(prompt, w, h), { signal: ac.signal });
    let b64 = null;
    if (res && typeof res.image === "string" && res.image.length > 100) {
      b64 = res.image;
    } else if (res instanceof ArrayBuffer) {
      b64 = bytesToBase64(new Uint8Array(res));
    } else if (res instanceof Uint8Array) {
      b64 = bytesToBase64(res);
    } else if (res && typeof res.getReader === "function") {
      const buf = new Uint8Array(await new Response(res).arrayBuffer());
      b64 = bytesToBase64(buf);
    }
    if (!b64 || b64.length < 1000) return null;
    const mime = sniffMime(b64);
    return { b64, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* 최후 폴백: 주제 문구를 얹은 그라디언트 SVG 카드(외부 의존 없음, 항상 성공). */
export function fallbackSvg(topic, width = 1024, height = 1024) {
  let hash = 5381;
  const s = String(topic || "thumbnail");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const hue2 = (hue + 40 + (hash >> 8) % 60) % 360;
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const chars = [...s.slice(0, 48)];
  const lines = [];
  for (let i = 0; i < chars.length && lines.length < 3; i += 14) lines.push(chars.slice(i, i + 14).join(""));
  const tspans = lines.map((l, i) => `<tspan x="${width / 2}" dy="${i === 0 ? 0 : 90}">${esc(l)}</tspan>`).join("");
  const startY = height / 2 - (lines.length - 1) * 45;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},62%,30%)"/><stop offset="1" stop-color="hsl(${hue2},70%,16%)"/>
</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
<circle cx="${(hash % width)}" cy="${height - 140}" r="300" fill="hsl(${hue2},80%,55%)" opacity="0.14"/>
<circle cx="${width - (hash >> 4) % 300}" cy="120" r="200" fill="hsl(${hue},85%,65%)" opacity="0.12"/>
<text x="${width / 2}" y="${startY}" text-anchor="middle" font-family="'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif" font-size="76" font-weight="800" fill="#ffffff">${tspans}</text>
</svg>`;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return { b64, mime: "image/svg+xml" };
}

async function handleImage(request, env) {
  let body = {};
  try {
    body = request.method === "GET"
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json();
  } catch {
    return json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }
  const prompt = String(body.prompt || body.topic || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 1200);
  const topic = String(body.topic || body.prompt || "").trim().slice(0, 120);
  if (!prompt) return json({ error: "prompt 또는 topic이 필요합니다." }, 400);
  const w = Math.max(512, Math.min(1536, parseInt(body.width, 10) || 1024));
  const h = Math.max(512, Math.min(1536, parseInt(body.height, 10) || 1024));

  if (env && env.AI && typeof env.AI.run === "function") {
    for (const model of IMAGE_MODELS) {
      const hit = await tryModel(env, model, prompt, w, h);
      if (hit) {
        return json({
          success: true,
          provider: model.id,
          format: hit.mime.split("/")[1],
          mime_type: hit.mime,
          image_base64: hit.b64,
          data_url: `data:${hit.mime};base64,${hit.b64}`,
        });
      }
    }
  }

  const svg = fallbackSvg(topic || prompt, w, h);
  return json({
    success: true,
    provider: "svg-fallback",
    format: "svg",
    mime_type: svg.mime,
    image_base64: svg.b64,
    data_url: `data:${svg.mime};base64,${svg.b64}`,
    note: "Workers AI 바인딩이 없거나 이미지 모델 호출이 실패해 SVG 카드로 대체했습니다.",
  });
}

/* ── 라우팅 ────────────────────────────────────── */

const DOCS_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tamsaek-worker</title>
<style>body{font-family:system-ui,'Apple SD Gothic Neo',sans-serif;background:#0b1220;color:#e5e7eb;margin:0;padding:40px}main{max-width:760px;margin:auto;background:#111a2e;border:1px solid #24304d;border-radius:20px;padding:32px}code,pre{background:#0a0f1c;border:1px solid #24304d;border-radius:10px;padding:3px 8px}pre{display:block;padding:14px;overflow:auto}h1{font-size:22px}</style></head>
<body><main><h1>tamsaek-worker 검색·이미지 API</h1>
<p>탐색팩 플러그인용 검색 그라운딩 + AI 이미지 생성 워커입니다. 워드프레스 관리자 → AI 글쓰기 설정의 "검색 Worker 주소"에 이 주소를 넣으세요.</p>
<pre>GET  /api/search?q=검색어&amp;engine=all   (naver·daum·bing·google 병렬)
POST /api/image  {"prompt":"...","width":1024,"height":1024}</pre>
<p>engine 값: <code>all</code> <code>naver</code> <code>daum</code> <code>bing</code> <code>google</code> (쉼표로 조합 가능)</p>
<p>Google은 자동화 차단 때문에 뉴스 RSS 기반이라 결과가 뉴스 기사로 한정됩니다. 이미지 생성은 Cloudflare Workers AI 바인딩이 켜져 있어야 실제 AI 이미지가 나오고, 없으면 SVG 카드로 대체됩니다.</p>
</main></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname.indexOf("/api/") === 0) {
      // 비밀키가 등록된 경우에만 검사한다 (미등록 시 개방).
      const secret = env && env.WORKER_SECRET ? String(env.WORKER_SECRET) : "";
      if (secret && request.headers.get("X-AIBP-Secret") !== secret) {
        return json({ error: "인증 실패: X-AIBP-Secret 헤더가 필요합니다." }, 401);
      }
    }

    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
      return handleSearch(request);
    }
    if (url.pathname === "/api/image") {
      if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
      return handleImage(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(DOCS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    }
    return json({ error: "Not Found", endpoints: ["/api/search?q=...&engine=all", "/api/image"] }, 404);
  },
};
