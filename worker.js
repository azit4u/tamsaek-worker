/**
 * tamsaek-worker — 탐색팩(tamsaekPack)용 검색 그라운딩 + AI 이미지 워커.
 *
 * Cloudflare Workers 무료 플랜에 단독 배포되는 API 키 없는 워커로,
 * 탐색팩 플러그인의 "검색 Worker 주소" 칸에 배포 주소를 넣으면 바로 동작한다.
 *
 * 라우트:
 *   GET      /api/search?q={검색어}&engine=all|naver|daum|bing|google&start=0
 *   POST     /api/research { query, max_results? } — 썸네일용 주제 조사(JSON)
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

/* ── 심층 수집 (deep=1) ─────────────────────────────
   자동화글쓰기 프로젝트의 리서처(researcher.py) 방식 이식:
   ① 모바일 뉴스·블로그 "탭"을 정렬(관련도/최신)별로 나눠 링크를 모으고
   ② 상위 글에 실제로 들어가 본문을 발췌해 온다.
   네이버 뉴스/블로그(m.), 다음 뉴스는 서버 렌더링이라 브라우저 없이 본문이 잡힌다.
   검색 스니펫 몇 줄 대신 실제 본문 수천 자가 그라운딩 재료가 되는 게 핵심. */

const DEEP_URL_RES = {
  naverNews: /https?:\/\/(?:n\.)?news\.naver\.com\/(?:mnews\/)?article\/\d+\/\d+/,
  naverBlog: /https?:\/\/(?:m\.)?blog\.naver\.com\/[\w.-]+\/\d+/,
  daumNews: /https?:\/\/v\.daum\.net\/v\/\w+/,
};

const DEEP_SOURCES = [
  { name: "네이버 뉴스(관련도)", re: DEEP_URL_RES.naverNews,
    url: (q) => `https://m.search.naver.com/search.naver?ssc=tab.m_news.all&where=m_news&sm=mtb_jum&query=${encodeURIComponent(q)}` },
  { name: "네이버 뉴스(최신)", re: DEEP_URL_RES.naverNews,
    url: (q) => `https://m.search.naver.com/search.naver?ssc=tab.m_news.all&where=m_news&sm=mtb_jum&query=${encodeURIComponent(q)}&sort=1` },
  { name: "네이버 블로그", re: DEEP_URL_RES.naverBlog,
    url: (q) => `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all&sm=mtb_jum&query=${encodeURIComponent(q)}` },
  { name: "다음 뉴스(최신)", re: DEEP_URL_RES.daumNews,
    url: (q) => `https://m.search.daum.net/search?w=news&q=${encodeURIComponent(q)}&sort=recency&DA=STC` },
];

const DEEP_PER_SOURCE = 5;   // 탭당 수집 링크 수
const DEEP_MAX_ARTICLES = 12; // 본문까지 따라 들어가는 최대 글 수 (서브요청 한도 고려)
const DEEP_BODY_CHARS = 1200; // 글당 본문 발췌 길이

/** 중복 판정용 URL 정규화 — 프로토콜·모바일(m.)·쿼리스트링·끝 슬래시 차이를 무시 */
function normalizeArticleUrl(raw) {
  try {
    const p = new URL(raw);
    return p.hostname.replace(/^m\./, "") + p.pathname.replace(/\/$/, "");
  } catch { return String(raw); }
}

/** 검색 탭 HTML에서 패턴에 맞는 글 링크(+앵커 제목)를 뽑는다 */
function collectDeepLinks(html, urlRe, max) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < max) {
    const href = m[1].replace(/&amp;/g, "&");
    const um = href.match(urlRe);
    if (!um) continue;
    const key = normalizeArticleUrl(um[0]);
    if (seen.has(key)) continue;
    const title = stripTags(m[2]).trim();
    if (title.length < 8) continue; // 썸네일 이미지 등 제목 없는 앵커 제외
    seen.add(key);
    out.push({ title: title.slice(0, 120), url: um[0] });
  }
  return out;
}

/** 본문 후보 컨테이너 마커 — 앞에 있을수록 우선 (네이버 뉴스/블로그·다음 뉴스·일반) */
const DEEP_BODY_MARKERS = ['id="dic_area"', "se-main-container", "article_view", "articleBody", "<article", "<main"];

function htmlToText(s) {
  return stripTags(String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " "));
}

/** 글 하나에 들어가 본문을 발췌한다 — 실패하면 null (수집 흐름은 계속) */
async function fetchArticleBody(item) {
  // 데스크톱 블로그 주소는 iframe 껍데기라 본문이 없다 → 모바일 주소로 변환 (리서처 방식)
  const url = item.url.replace(/^https?:\/\/blog\.naver\.com\//, "https://m.blog.naver.com/");
  try {
    const { text } = await fetchText(url, 7000);
    if (!text) return null;
    const H = text.slice(0, 400000);
    for (const mk of DEEP_BODY_MARKERS) {
      const idx = H.indexOf(mk);
      if (idx === -1) continue;
      const body = htmlToText(H.slice(idx, idx + 90000)).trim();
      if (body.length > 150) {
        return { title: item.title, url: item.url, source: item.source, content: body.slice(0, DEEP_BODY_CHARS) };
      }
    }
    const fallback = htmlToText(H.slice(0, 120000)).trim();
    return fallback.length > 300
      ? { title: item.title, url: item.url, source: item.source, content: fallback.slice(0, DEEP_BODY_CHARS) }
      : null;
  } catch { return null; }
}

/** 심층 수집 본체: 탭 4곳 병렬 → 링크 중복 제거 → 본문 병렬 발췌 */
async function deepCollect(q) {
  const pages = await Promise.allSettled(DEEP_SOURCES.map((s) => fetchText(s.url(q), 7000)));
  const targets = [];
  const seen = new Set();
  pages.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value.text) return;
    for (const l of collectDeepLinks(r.value.text, DEEP_SOURCES[i].re, DEEP_PER_SOURCE)) {
      const key = normalizeArticleUrl(l.url);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ ...l, source: DEEP_SOURCES[i].name });
    }
  });
  const bodies = await Promise.allSettled(targets.slice(0, DEEP_MAX_ARTICLES).map((t) => fetchArticleBody(t)));
  return bodies.filter((b) => b.status === "fulfilled" && b.value).map((b) => b.value);
}

async function handleSearch(request) {
  const u = new URL(request.url);
  // 플러그인이 q 값을 이중 인코딩해 보내는 경우가 있어 한 번 더 디코드를 시도한다.
  let q = (u.searchParams.get("q") || "").trim().slice(0, 200);
  if (/%[0-9a-fA-F]{2}/.test(q)) { try { q = decodeURIComponent(q); } catch { /* 그대로 사용 */ } }
  const engine = (u.searchParams.get("engine") || "all").toLowerCase();
  const start = Math.max(0, parseInt(u.searchParams.get("start") || "0", 10) || 0);
  const deep = u.searchParams.get("deep") === "1";

  if (!q) return json({ error: "q 파라미터가 필요합니다. 예: /api/search?q=검색어&engine=all" }, 400);
  // all에서 bing(웹검색)은 제외 — Cloudflare IP로 오는 한국어 쿼리를 Bing이 무시하고
  // 무관한 결과(외국어 문서 등)를 주는 일이 잦아(실측 2026-09-08) 그라운딩 자료를 오염시킨다.
  // 필요하면 engine=bing으로 명시 호출은 여전히 가능. (google=뉴스 RSS의 Bing 뉴스 폴백은 정상이라 유지)
  const names = engine === "all"
    ? Object.keys(ENGINES).filter((n) => n !== "bing")
    : engine.split(",").filter((n) => ENGINES[n]);
  if (!names.length) return json({ error: "engine은 all, naver, daum, bing, google 중 하나입니다." }, 400);

  // deep=1이면 탭별 링크 수집+본문 발췌를 스니펫 검색과 병렬로 돌린다 (실패해도 스니펫은 정상 반환)
  const deepPromise = deep ? deepCollect(q).catch(() => []) : null;

  const settled = await Promise.allSettled(names.map((n) => runEngine(n, q, start)));
  const providers = settled.map((s, i) => s.status === "fulfilled"
    ? s.value
    : { engine: names[i], label: ENGINES[names[i]].label, upstream_status: 599, latency_ms: 0, results: [] });

  const payload = { query: q, engine, start, providers };
  if (deepPromise) payload.articles = await deepPromise;
  return json(payload);
}

/* ── /api/research ──────────────────────────────────
   썸네일 전용 "주제 조사": 검색(기존 엔진 재활용) → 규칙 기반 분석으로
   주제의 실제 의미·시각 요소·색감을 JSON으로 만든다. 프롬프트를 짓는
   Gemini(플러그인 쪽)가 주제 문자열만 보고 엉뚱하게 해석하는 것을 막는 용도.
   Workers AI 바인딩이 있으면 소형 텍스트 모델을 요청당 딱 1회, 짧게 호출해
   정성 필드만 보강하고, 없거나 실패하면 항상 규칙 기반 결과를 반환한다. */

const RESEARCH_COLOR_HINTS = [
  { words: ["빨강", "레드", "붉은", "적색"], mood: "정열적이고 강렬한 붉은 톤", text: "#FFFFFF", accent: "#E4342F" },
  { words: ["파랑", "블루", "푸른", "네이비", "청색"], mood: "차분하고 신뢰감 있는 파란 톤", text: "#FFFFFF", accent: "#2F6FE4" },
  { words: ["초록", "그린", "녹색", "연두"], mood: "자연스럽고 신선한 초록 톤", text: "#FFFFFF", accent: "#2FA84F" },
  { words: ["노랑", "옐로", "골드", "금색"], mood: "밝고 경쾌한 노란·골드 톤", text: "#1A1A1A", accent: "#FFD400" },
  { words: ["보라", "퍼플", "라벤더"], mood: "신비롭고 세련된 보라 톤", text: "#FFFFFF", accent: "#8B5CF6" },
  { words: ["분홍", "핑크", "로즈"], mood: "부드럽고 따뜻한 핑크 톤", text: "#1A1A1A", accent: "#F472B6" },
  { words: ["검정", "블랙", "다크"], mood: "묵직하고 고급스러운 다크 톤", text: "#FFFFFF", accent: "#F2F2F2" },
  { words: ["흰색", "화이트", "미니멀"], mood: "깨끗하고 여백이 넓은 화이트 톤", text: "#1A1A1A", accent: "#111111" },
];

/* 카드 심볼용 카테고리 키(영문)를 조사 결과용 한글 라벨·정서 톤으로 변환.
   사전을 이중으로 두지 않고 CATEGORY_KEYWORDS 하나를 공유한다. */
const RESEARCH_CATEGORY_META = {
  messenger: { label: "메신저/앱", tone: "modern" },
  device: { label: "IT/기기", tone: "modern" },
  finance: { label: "재테크/금융", tone: "trustworthy" },
  food: { label: "푸드", tone: "warm" },
  travel: { label: "여행", tone: "warm" },
  health: { label: "건강/피트니스", tone: "energetic" },
  education: { label: "교육", tone: "trustworthy" },
  beauty: { label: "뷰티/패션", tone: "elegant" },
  business: { label: "비즈니스/커리어", tone: "energetic" },
  environment: { label: "자연/반려동물", tone: "warm" },
  entertainment: { label: "엔터테인먼트", tone: "dynamic" },
  legal: { label: "법률/제도", tone: "serious" },
  home: { label: "리빙/인테리어", tone: "warm" },
  tech: { label: "IT/기술", tone: "modern" },
  default: { label: "일반", tone: "dynamic" },
};

const PEOPLE_WORDS_EN = /\b(person|people|woman|women|man|men|girl|boy|human|face|portrait|model)\b/gi;
const PEOPLE_WORDS_KO = /(사람|인물|모델|여성|남성|얼굴)/g;

function stripPeopleWords(s) {
  return String(s || "").replace(PEOPLE_WORDS_KO, "").replace(PEOPLE_WORDS_EN, "").replace(/\s{2,}/g, " ").trim();
}

/* 검색 결과(제목+스니펫)를 규칙 기반으로 분석해 research JSON을 만든다.
   AI 바인딩이 전혀 없어도 항상 완전한 결과를 반환한다. */
function buildRuleBasedResearch(topic, flatResults) {
  const corpus = [topic]
    .concat(flatResults.slice(0, 8).map((r) => `${r.title || ""} ${r.snippet || ""}`))
    .join(" ")
    .toLowerCase();

  let colorEntry = null;
  for (const entry of RESEARCH_COLOR_HINTS) {
    if (entry.words.some((w) => corpus.includes(w))) { colorEntry = entry; break; }
  }
  const categoryKey = detectCategory(corpus);
  const categoryMeta = RESEARCH_CATEGORY_META[categoryKey] || RESEARCH_CATEGORY_META.default;

  const topTitles = flatResults.slice(0, 5).map((r) => r.title).filter(Boolean);
  const topSnippets = flatResults.slice(0, 3).map((r) => r.snippet).filter(Boolean);

  // 실제 의미: 정보량이 적당한 검색 결과 제목을 붙여 주제의 실체를 드러낸다.
  const bestTitle = topTitles.find((t) => t.length >= 6 && t.length <= 60) || topTitles[0] || "";
  const actualMeaning = (bestTitle ? `${topic} — ${bestTitle}` : topic).slice(0, 160);

  // 스니펫 앞의 날짜/숫자 찌꺼기("2026.07.14." 등)를 걷어내고, 내용이 충분한
  // 스니펫만 시각적 맥락으로 채택한다.
  const cleanedSnippets = topSnippets
    .map((s) => stripPeopleWords(s).replace(/^[\s\d.,~\-:년월일()]+/, "").trim())
    .filter((s) => s.length >= 20);
  const visualContext = (cleanedSnippets[0]
    || stripPeopleWords(topTitles.slice(0, 3).join(", "))
    || topic).slice(0, 160);

  const keyVisuals = Array.from(new Set(
    topTitles.join(" ").split(/[\s,·|\-\/]+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && w.length <= 12
        && !/(사람|인물|모델|여성|남성|얼굴)/.test(w)
        && !/^\d/.test(w) && !/^[\d.,~%년월일회차:()]+$/.test(w))
  )).slice(0, 5);

  return {
    actual_meaning: actualMeaning,
    visual_context: visualContext || topic,
    hero_shot: keyVisuals[0] ? `${keyVisuals[0]}을(를) 중심으로 한 상징적 장면` : `${topic}을(를) 상징하는 오브젝트 중심 장면`,
    color_mood: colorEntry ? colorEntry.mood : "주제와 어울리는 현대적이고 선명한 톤",
    key_visuals: keyVisuals.length ? keyVisuals : [topic],
    category: categoryMeta.label,
    emotional_tone: categoryMeta.tone,
    text_color_hex: colorEntry ? colorEntry.text : "#FFFFFF",
    accent_color_hex: colorEntry ? colorEntry.accent : "#FFD400",
    research_engine: "rule_based",
  };
}

/* (선택) Workers AI 소형 텍스트 모델로 정성 필드만 보강 — 요청당 1회,
   짧은 프롬프트 + 짧은 max_tokens + 6초 제한. 실패 시 규칙 기반 결과 유지. */
async function enhanceResearchWithAI(env, topic, flatResults, ruleBased, debug) {
  const fail = (why) => {
    if (debug) ruleBased._ai_skip = why; // debug:true 요청에서만 노출되는 진단 필드
    return ruleBased;
  };
  if (!env || !env.AI || typeof env.AI.run !== "function") return fail("no_ai_binding");
  const snippets = flatResults.slice(0, 5)
    .map((r) => `- ${r.title || ""}: ${String(r.snippet || "").slice(0, 120)}`)
    .join("\n");
  if (!snippets) return fail("no_snippets");

  const prompt = `다음은 "${topic}"에 대한 검색 결과 요약이다. 아래 JSON 스키마로만, 마크다운이나 설명 없이 응답하라.
검색 결과:
${snippets}

스키마:
{"actual_meaning":"주제의 실제 의미(최대 40자)","visual_context":"이미지로 표현할 시각적 장면(최대 60자)","hero_shot":"핵심 장면 한 문장","color_mood":"어울리는 색상 분위기","category":"카테고리 한 단어","emotional_tone":"영어 한 단어(예: warm, dynamic, trustworthy)"}
인물/사람을 시각 요소로 넣지 말 것.`;

  /* 저비용 소형 텍스트 모델 체인 — 앞 모델이 퇴역(5028)·실패·지연되면 다음
     모델로. 모델마다 개별 6초 제한을 둔다.
     (2026-09 카탈로그 실측: llama-3.1-8b-instruct는 퇴역됨 → 현행 모델 사용) */
  const textModels = [
    "@cf/meta/llama-3.1-8b-instruct-fp8", // 빠르고 저렴 — 1순위
    "@cf/meta/llama-3.2-3b-instruct",     // 예비(최저 비용)
    "@cf/zai-org/glm-4.7-flash",          // 다국어 예비
  ];
  try {
    let raw = "";
    let lastErr = "";
    for (const model of textModels) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort("ai_timeout"), 6000);
      try {
        const result = await env.AI.run(model, {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 220,
        }, { signal: ac.signal });
        raw = typeof result === "string" ? result : ((result && result.response) || "");
        if (raw) break;
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 120);
      } finally {
        clearTimeout(t);
      }
    }
    if (!raw) return fail("ai_error: " + (lastErr || "empty_response"));
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fail("no_json_in_response: " + String(raw).slice(0, 80));
    const parsed = JSON.parse(match[0]);
    // 소형 모델이 지나치게 짧거나 형식이 어긋난 값을 주면 그 필드는 규칙
    // 기반 값을 유지한다 (AI는 "있으면 좋은 보강"일 뿐 절대 후퇴는 없어야 함).
    const pick = (key, max, strip, minLen) => {
      if (!parsed[key]) return ruleBased[key];
      const v = strip ? stripPeopleWords(String(parsed[key])) : String(parsed[key]).trim();
      return v && v.length >= minLen ? v.slice(0, max) : ruleBased[key];
    };
    const tone = String(parsed.emotional_tone || "").trim();
    return {
      ...ruleBased,
      actual_meaning: pick("actual_meaning", 160, false, 8),
      visual_context: pick("visual_context", 200, true, 10),
      hero_shot: pick("hero_shot", 200, true, 10),
      color_mood: pick("color_mood", 100, false, 6),
      category: pick("category", 40, false, 2),
      // emotional_tone은 영어 한 단어 형식일 때만 채택.
      emotional_tone: /^[a-z]{3,20}$/i.test(tone) ? tone.toLowerCase() : ruleBased.emotional_tone,
      research_engine: "workers_ai+rule_based",
    };
  } catch (e) {
    return fail("ai_error: " + String((e && e.message) || e).slice(0, 120));
  }
}

async function handleResearch(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }
  const query = String(body.query || body.topic || body.q || "").trim().slice(0, 200);
  if (!query) return json({ error: "query가 필요합니다." }, 400);
  const maxResults = Math.max(3, Math.min(10, parseInt(body.max_results, 10) || 8));

  // 빠른 엔진 2곳만 병렬 조사(뉴스 RSS는 조사 목적상 기여도가 낮고 느릴 수 있어 제외,
  // bing 웹검색은 무관한 결과 오염 문제로 제외 — /api/search의 all과 같은 이유).
  const names = ["naver", "daum"];
  const settled = await Promise.allSettled(names.map((n) => runEngine(n, query, 0)));
  const providers = settled.map((s, i) => s.status === "fulfilled"
    ? s.value
    : { engine: names[i], label: ENGINES[names[i]].label, upstream_status: 599, latency_ms: 0, results: [] });

  const flatResults = dedupe(providers.flatMap((p) => p.results || []), maxResults);
  const summary = flatResults.slice(0, 6).map((r) => r.title).filter(Boolean).join(" / ");

  const ruleBased = buildRuleBasedResearch(query, flatResults);
  const research = await enhanceResearchWithAI(env, query, flatResults, ruleBased, Boolean(body.debug));

  return json({ query, summary, results: flatResults, providers, research });
}

/* ── /api/image ─────────────────────────────────────
   Workers AI 바인딩(env.AI)이 있으면 스타일별 모델 체인을 순서대로 시도한다.
   모두 실패하면(바인딩 없음 포함) 항상 성공하는 SVG 카드로 폴백해
   호출 측이 절대 빈손이 되지 않게 한다.

   ⚠️ 뉴런 최소화 원칙: 각 스타일 체인의 1순위는 항상 스텝 수가 적어 뉴런
   소모가 가장 적은 모델(schnell/lightning/dreamshaper, 4~8스텝)로 고정한다.
   대부분의 요청이 1순위에서 성공하므로 실사용 비용은 저비용 모델에 집중되고,
   고스텝 모델(SDXL base 20스텝)은 앞이 실패했을 때만 도달하는 안전망이다.
   각 모델은 재시도 없이 1회씩만 시도한다. */

const AI_MODELS = {
  FLUX_SCHNELL: "@cf/black-forest-labs/flux-1-schnell",          // 4스텝, 최저 비용, 자연문 지시 이행 우수
  SDXL_BASE: "@cf/stabilityai/stable-diffusion-xl-base-1.0",     // 20스텝, 고품질/고비용, negative_prompt 지원
  SDXL_LIGHTNING: "@cf/bytedance/stable-diffusion-xl-lightning", // 8스텝, 빠르고 대비 강함, negative_prompt 지원
  DREAMSHAPER: "@cf/lykon/dreamshaper-8-lcm",                    // 6스텝, 사실적 렌더링 강점, 저비용
};

/* 스타일별 모델 체인 — 플러그인이 보내는 style(poster/minimal/typography/
   branding/photo_realistic)마다 그 스타일의 디자인 철학에 맞는 우선순위를 둔다. */
const STYLE_MODEL_CHAIN = {
  // 포스터: 강한 대비·인쇄 광고풍 마감이 강점인 Lightning을 1순위로,
  // 폭넓은 구도 표현을 위해 서로 다른 계열을 두루 포함.
  poster: [AI_MODELS.SDXL_LIGHTNING, AI_MODELS.FLUX_SCHNELL, AI_MODELS.DREAMSHAPER, AI_MODELS.SDXL_BASE],
  // 브랜딩: 상업 광고급 대비의 Lightning 우선, 디테일 안전망으로 SDXL base.
  branding: [AI_MODELS.SDXL_LIGHTNING, AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_BASE],
  // 미니멀: 과도한 디테일을 만드는 고스텝 모델은 철학에 어긋나므로
  // 저스텝·깔끔한 지시 이행 모델로만 짧게 구성.
  minimal: [AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_LIGHTNING],
  // 타이포그래피: 배경은 텍스트를 위한 무대 — 단순 배경에 강한 저비용 모델
  // 우선, 감성적 색조 표현용으로 SDXL 계열을 안전망에 둔다.
  typography: [AI_MODELS.FLUX_SCHNELL, AI_MODELS.SDXL_LIGHTNING, AI_MODELS.SDXL_BASE],
  // 사실적 사진: 사실적 렌더링에 강한 Dreamshaper 1순위, 사실성 실패 시
  // 품질 저하가 가장 두드러지는 스타일이라 폴백 단계를 가장 넓게 둔다.
  photo_realistic: [AI_MODELS.DREAMSHAPER, AI_MODELS.SDXL_LIGHTNING, AI_MODELS.SDXL_BASE, AI_MODELS.FLUX_SCHNELL],
};

/* 모델 계열별 프롬프트 가공 — 계열마다 프롬프트 문법이 다르다.
   - FLUX 계열: 자연스러운 문장 묘사를 선호, 가중치 문법·negative_prompt 미지원 → 그대로.
   - Stable Diffusion 계열(SDXL base/lightning): 품질 태그를 덧붙이면 효과가
     있고 negative_prompt를 지원한다.
   - dreamshaper(LCM): 소수 스텝에 최적화 — 긴 프롬프트보다 핵심 묘사 위주가 안정적. */
function buildModelPrompt(model, prompt, style) {
  switch (model) {
    case AI_MODELS.SDXL_BASE:
    case AI_MODELS.SDXL_LIGHTNING:
      return `${prompt}, professional commercial ${style} design, sharp focus, high detail, studio quality lighting, 4k`;
    case AI_MODELS.DREAMSHAPER:
      return `${prompt}, clean composition, balanced lighting, crisp detail`;
    default:
      return prompt;
  }
}

function buildModelInput(model, prompt, style, w, h) {
  const shaped = buildModelPrompt(model, prompt, style);
  // negative_prompt는 Stable Diffusion 계열만 지원한다.
  const negative = "blurry, low quality, watermark, text artifacts, distorted, extra limbs, deformed";
  switch (model) {
    case AI_MODELS.SDXL_BASE:
      return { prompt: shaped, negative_prompt: negative, num_steps: 20, guidance: 7.5, width: w, height: h };
    case AI_MODELS.SDXL_LIGHTNING:
      return { prompt: shaped, negative_prompt: negative, num_steps: 8, width: w, height: h };
    case AI_MODELS.DREAMSHAPER:
      return { prompt: shaped, num_steps: 6, guidance: 2, width: w, height: h };
    case AI_MODELS.FLUX_SCHNELL:
    default:
      // schnell 권장값(4스텝)을 넘기지 않는다 — 뉴런 남용 방지. 크기 파라미터는 미지원(항상 1024급).
      return { prompt: shaped, steps: 4 };
  }
}

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

async function tryModel(env, modelId, input) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), 30000);
  try {
    const res = await env.AI.run(modelId, input, { signal: ac.signal });
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

/* ── 최후 폴백: SVG 카드 렌더러 ─────────────────────
   AI 모델이 전부 실패해도(바인딩 없음 포함) 항상 성공하는 디자인 카드.
   스타일별로 색상·패널 기하·타이포 스케일을 다르게 두고, 주제의 카테고리를
   추정해 심볼을 얹어 "모든 주제가 똑같은 카드"로 보이는 문제를 완화한다. */

function hashString(input) {
  let hash = 5381;
  const s = String(input || "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return hash;
}

function escapeXml(v = "") {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

/**
 * 문자 1개의 대략적인 렌더 폭을 em(폰트 크기 대비 배수) 단위로 추정한다.
 * Workers 런타임에는 폰트 metrics 측정 수단이 없으므로 문자 종류별 평균 폭을
 * 근사값으로 쓴다. 제목이 굵게(font-weight 800) 그려지는 점을 감안해 실제
 * 평균보다 넉넉히 잡아, 추정이 어긋나도 "넘치는" 대신 "일찍 접히는" 쪽으로만
 * 오차가 나게 한다.
 */
function estCharWidthEm(ch) {
  if (/[가-힣]/.test(ch)) return 1.05;
  if (/[A-Z0-9]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.60;
  if (ch === " ") return 0.30;
  return 0.55;
}

function estTextWidthEm(text) {
  let total = 0;
  for (const ch of String(text || "")) total += estCharWidthEm(ch);
  return total;
}

// 폭 추정치와 실제 렌더러의 오차를 흡수하는 전역 안전 계수.
const WIDTH_SAFETY_FACTOR = 0.92;

/**
 * 긴 텍스트를 "실제 폭(em)" 기준으로 여러 줄로 나눈다. 글자 수 기준 줄바꿈은
 * 한글/영문 폭 차이로 카드 밖으로 넘치는 원인이라 폭 기준으로만 계산한다.
 * 단어 단위로 나누되, 단어 하나가 한 줄 폭을 넘으면(공백 없는 긴 한글 구절 등)
 * 문자 단위로 강제 절단하고, 다 못 들어가면 말줄임표를 붙인다.
 */
function wrapTextByWidth(text, maxWidthEm, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  let currentWidth = 0;
  let truncated = false;

  const pushLine = () => { if (current) lines.push(current); current = ""; currentWidth = 0; };

  outer:
  for (const word of words) {
    if (lines.length >= maxLines) { truncated = true; break; }
    const wordWidth = estTextWidthEm(word);
    const sepWidth = current ? estCharWidthEm(" ") : 0;

    if (currentWidth + sepWidth + wordWidth <= maxWidthEm) {
      current = current ? `${current} ${word}` : word;
      currentWidth += sepWidth + wordWidth;
      continue;
    }
    if (current) {
      pushLine();
      if (lines.length >= maxLines) { truncated = true; break; }
    }
    if (wordWidth > maxWidthEm) {
      let chunk = "";
      let chunkWidth = 0;
      for (const ch of word) {
        const chW = estCharWidthEm(ch);
        if (chunkWidth + chW > maxWidthEm && chunk) {
          lines.push(chunk);
          if (lines.length >= maxLines) { truncated = true; break outer; }
          chunk = ch;
          chunkWidth = chW;
        } else {
          chunk += ch;
          chunkWidth += chW;
        }
      }
      current = chunk;
      currentWidth = chunkWidth;
    } else {
      current = word;
      currentWidth = wordWidth;
    }
  }

  if (lines.length < maxLines) {
    if (current) lines.push(current);
  } else if (current) {
    truncated = true;
  }
  if (lines.length === 0) lines.push("");

  const consumedLength = lines.join(" ").length;
  if (truncated || String(text || "").length > consumedLength + words.length) {
    let last = lines[lines.length - 1] || "";
    const ellipsisWidth = estCharWidthEm("…");
    while (last.length > 0 && estTextWidthEm(last) + ellipsisWidth > maxWidthEm) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/[…\s]+$/, "") + "…";
  }
  return lines;
}

/**
 * 줄바꿈 계산에 쓴 폭 가정과 실제 그리는 폰트 크기가 항상 일치하도록,
 * 패널 폭 안에 들어오는 가장 큰 폰트 크기를 찾는다.
 */
function fitTitle(topic, panelInnerWidth, maxLines, maxFontSize, minFontSize) {
  let fontSize = maxFontSize;
  let lines = [];
  const safeWidth = panelInnerWidth * WIDTH_SAFETY_FACTOR;
  while (fontSize >= minFontSize) {
    lines = wrapTextByWidth(topic, safeWidth / fontSize, maxLines);
    if (lines.every((line) => estTextWidthEm(line) * fontSize <= safeWidth + 0.5)) break;
    fontSize -= 4;
  }
  if (fontSize < minFontSize) fontSize = minFontSize;
  return { fontSize, lines };
}

const FONT_STACK = "'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Segoe UI', sans-serif";

/* 카테고리별 심볼(24×24 그리드 기준 SVG path) — 주제의 "종류"만이라도
   시각적으로 구분되게 카드 구석에 얹는다. */
const CATEGORY_GLYPHS = {
  messenger: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  device: "M6 3h9a2 2 0 0 1 2 2v13H4V5a2 2 0 0 1 2-2zM3 20h16M9 6h3",
  finance: "M4 19V10M10 19V5M16 19v-7M2 19h20M4 10l6-5 6 4 4-4",
  food: "M6 3v7a3 3 0 0 0 6 0V3M9 10v11M17 3c-2 2-2 5 0 8v10",
  travel: "M2 16l7-2 4-9 2 1-3 8 6-1 2 2-8 4-2 5-2-1 1-5-7 2-1-2 3-2z",
  health: "M12 21s-7-4.4-9.5-8.6C.6 8.8 2.4 5 6 5c2 0 3.4 1.1 4 2.3C10.6 6.1 12 5 14 5c3.6 0 5.4 3.8 3.5 7.4C19 16.6 12 21 12 21z",
  education: "M2 8l10-4 10 4-10 4-10-4zM6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 8v6",
  beauty: "M12 3c1.5 2 1.5 4 0 6 1.5 2 1.5 4 0 6M6 6c1.5 1.5 1.5 3.5 0 5M18 6c-1.5 1.5-1.5 3.5 0 5M4 15c2 3 5 5 8 6 3-1 6-3 8-6",
  business: "M4 20V10l8-6 8 6v10M9 20v-6h6v6",
  environment: "M12 2c4 3 7 7 7 11a7 7 0 0 1-14 0c0-4 3-8 7-11z",
  entertainment: "M4 4l16 8-16 8V4z",
  legal: "M12 3v18M6 7h12M4 7l3 6H1l3-6zM17 7l3 6h-6l3-6z",
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  tech: "M4 4h16v12H4zM9 20h6M12 16v4M7 8h10M7 11h6",
  default: "M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.6L6 22l1.5-7.2L2 10l7.1-1.1z",
};

const CATEGORY_KEYWORDS = [
  // "라인"은 "온라인/오프라인"에 오탐되므로 메신저 문맥이 분명할 때만 매칭한다.
  [/카카오톡|카톡|kakaotalk|네이버\s*라인|라인\s*(메신저|앱|친구)|line\s*app|왓츠앱|whatsapp|텔레그램|telegram|디스코드|discord|메신저|messenger|채팅/iu, "messenger"],
  [/pc\s*버전|pc용|다운로드|download|설치|install|업데이트|update|갤럭시|galaxy|아이폰|iphone|아이패드|ipad|맥북|macbook|노트북|laptop|태블릿|모니터|스마트폰/iu, "device"],
  [/재테크|투자|주식|펀드|자산|금융|은행|대출|부동산|아파트|주택|청약|세금|회계|계좌|적금|예금|연금/iu, "finance"],
  [/요리|레시피|음식|맛집|카페|커피|베이커리/iu, "food"],
  [/여행|관광|trip|해외여행|여행지|기차|열차|ktx|srt|항공권|비행기표|숙소|호텔|펜션|리조트|캠핑|글램핑/iu, "travel"],
  [/건강|병원|치료|영양제|비타민|다이어트|운동|헬스|피트니스/iu, "health"],
  [/교육|학습|공부|강의|수업|자격증|합격|취업준비/iu, "education"],
  [/뷰티|화장품|스킨케어|패션/iu, "beauty"],
  [/창업|스타트업|마케팅|비즈니스|취업|직장|커리어|채용|면접/iu, "business"],
  [/환경|기후|생태|반려동물|강아지|고양이/iu, "environment"],
  [/게임|gaming|e스포츠|영화|드라마|스트리밍|음악|아이돌/iu, "entertainment"],
  [/법률|계약서|보험|소송|정책|지원금|복지|민원/iu, "legal"],
  [/인테리어|이사|부동산\s*매물|가전/iu, "home"],
  [/ai|인공지능|머신러닝|딥러닝|소프트웨어|프로그래밍|코딩|개발|it\b/iu, "tech"],
];

function detectCategory(text) {
  for (const [pattern, category] of CATEGORY_KEYWORDS) {
    if (pattern.test(String(text || ""))) return category;
  }
  return "default";
}

/* ── SVG 디자인 카드 렌더러 (v4 — 변주 시스템) ─────────
   두 가지 변형: ① 문구 포함(title 전달 — 카드 모드, 캔버스 합성 생략)
   ② 문구 없음(AI 실패 폴백 — 캔버스가 문구를 얹음, 중앙 비움).
   [v4] "매번 똑같은 카드" 문제 해결: 스타일마다 배색 팔레트 3~4종과
   장식 배치 변형을 두고 생성할 때마다 무작위 조합 — AI 그림처럼
   「다시 생성」할 때마다 다른 카드가 나온다. 사실적 사진 스타일은
   풍경 자체가 3종(석양 산맥/밤하늘/바다 수평선). AI 호출 없음(뉴런 0). */
export function fallbackSvg(topic, width = 1024, height = 1024, style = "poster", title = "", subtitle = "", titleSize = 0, subSize = 0) {
  const s = String(topic || "thumbnail").trim();
  const dTitle = String(title || "").trim();
  const withText = dTitle !== "";
  const sub0 = String(subtitle || "").trim();
  const sub = withText && sub0 && sub0 !== dTitle ? sub0.slice(0, 80) : "";
  const fixedTitlePx = Math.max(0, Math.min(400, parseInt(titleSize, 10) || 0));
  const fixedSubPx = Math.max(0, Math.min(300, parseInt(subSize, 10) || 0));
  const glyph = CATEGORY_GLYPHS[detectCategory(s)] || CATEGORY_GLYPHS.default;
  const esc = escapeXml;
  const R = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const glyphAt = (x, y, svgPx, color, sw, opacity) =>
    `<g transform="translate(${x}, ${y}) scale(${(svgPx / 24).toFixed(3)})"${opacity != null ? ` opacity="${opacity}"` : ""}>` +
    `<path d="${glyph}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/></g>`;

  const wrapManual = (text, availW, maxLines, fontSize) => {
    const maxWEm = (availW * WIDTH_SAFETY_FACTOR) / fontSize;
    let lines = [];
    for (const seg of String(text).split(/\n/).map((t) => t.trim()).filter(Boolean)) {
      if (lines.length >= maxLines) break;
      lines = lines.concat(wrapTextByWidth(seg, maxWEm, maxLines - lines.length));
    }
    return lines.slice(0, maxLines);
  };
  const len = [...dTitle.replace(/\n/g, "")].length || 1;
  const scale = len <= 14 ? 1.0 : ( len <= 24 ? 0.8 : 0.62 );
  const titleBlock = (availW, maxLines, maxFont, minFont) => {
    if (fixedTitlePx > 0) {
      const fontSize = fixedTitlePx;
      const lines = wrapManual(dTitle, availW, maxLines, fontSize);
      const lh = fontSize * 1.18;
      return { fontSize, lines, lh, blockH: (lines.length - 1) * lh + fontSize };
    }
    let fontSize = Math.max(minFont, Math.round(maxFont * scale));
    let lines = wrapManual(dTitle, availW, maxLines, fontSize);
    while (fontSize > minFont) {
      lines = wrapManual(dTitle, availW, maxLines, fontSize);
      const fitsW = lines.every((ln) => estTextWidthEm(ln) * fontSize <= availW * WIDTH_SAFETY_FACTOR + 0.5);
      if (fitsW) break;
      fontSize -= 4;
    }
    const lh = fontSize * 1.18;
    return { fontSize, lines, lh, blockH: (lines.length - 1) * lh + fontSize };
  };
  const tspans = (lines, x, lh) =>
    lines.map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lh.toFixed(1)}">${esc(ln)}</tspan>`).join("");
  const subLines = (availW, fontSize) => sub ? wrapTextByWidth(sub, (availW * WIDTH_SAFETY_FACTOR) / fontSize, 2) : [];

  let defs = "";
  let body = "";

  if (style === "minimal") {
    // 팔레트 변주: 강조색·잉크색·장식 톤
    const P = R([
      { bg: "#f7f8fb", ink: "#111827", accent: "#2563eb", soft: "#e3ebfd", dot: "rgba(37,99,235,0.30)", line: "#d7dce6" },
      { bg: "#faf7f2", ink: "#1c1917", accent: "#ea580c", soft: "#fde8d7", dot: "rgba(234,88,12,0.30)", line: "#e2ddd4" },
      { bg: "#f4f9f6", ink: "#0f2e21", accent: "#0d9488", soft: "#d5efe7", dot: "rgba(13,148,136,0.30)", line: "#d3e3db" },
      { bg: "#f8f7fb", ink: "#1e1b2e", accent: "#7c3aed", soft: "#e9e2fb", dot: "rgba(124,58,237,0.28)", line: "#ddd8e8" },
    ]);
    // 장식 변형: 원 2개 / 사분원 아치 / 겹친 사각 프레임
    const decoKind = R(["circles", "arc", "squares"]);
    const deco = decoKind === "circles"
      ? `<circle cx="786" cy="212" r="95" fill="${P.soft}"/><circle cx="755" cy="274" r="44" fill="${P.accent}" opacity="0.9"/>`
      : decoKind === "arc"
      ? `<path d="M980 44 A 300 300 0 0 1 680 344 L 980 344 Z" fill="${P.soft}"/><circle cx="800" cy="220" r="30" fill="${P.accent}" opacity="0.9"/>`
      : `<rect x="700" y="120" width="180" height="180" fill="none" stroke="${P.soft}" stroke-width="26"/><rect x="760" y="180" width="180" height="180" fill="none" stroke="${P.accent}" stroke-width="10" opacity="0.65"/>`;
    defs = `<pattern id="dg" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="3" fill="${P.dot}"/></pattern>`;
    body = `<rect width="1024" height="1024" fill="${P.bg}"/>
<rect x="44" y="44" width="936" height="936" fill="none" stroke="${P.line}" stroke-width="2"/>
<path d="M44 76V44h32M948 44h32v32M44 948v32h32M980 948v32h-32" fill="none" stroke="${P.accent}" stroke-width="6"/>
${deco}
<rect x="651" y="740" width="260" height="180" fill="url(#dg)"/>`;
    if (withText) {
      const t = titleBlock(700, 3, 88, 34);
      const topY = 512 - t.blockH / 2;
      body += `
<rect x="113" y="${(topY - 112).toFixed(0)}" width="74" height="74" rx="20" fill="${P.soft}"/>
${glyphAt(129, topY - 96, 42, P.accent, 1.7)}
<line x1="205" y1="${(topY - 75).toFixed(0)}" x2="790" y2="${(topY - 75).toFixed(0)}" stroke="${P.line}" stroke-width="2"/>
<text x="113" y="${(topY + t.fontSize).toFixed(0)}" font-family="${FONT_STACK}" font-size="${t.fontSize}" font-weight="800" letter-spacing="-2" fill="${P.ink}">${tspans(t.lines, 113, t.lh)}</text>
<rect x="113" y="${(topY + t.blockH + 44).toFixed(0)}" width="170" height="10" fill="${P.accent}"/>`;
    } else {
      body += `
<rect x="113" y="180" width="74" height="74" rx="20" fill="${P.soft}"/>
${glyphAt(129, 196, 42, P.accent, 1.7)}
<line x1="205" y1="217" x2="640" y2="217" stroke="${P.line}" stroke-width="2"/>
<rect x="113" y="770" width="170" height="10" fill="${P.accent}"/>`;
    }
  } else if (style === "typography") {
    const P = R([
      { bg: "#101623", ink: "#f8fafc", accent: "#fb923c", g1: "rgba(251,146,60,0.16)", g2: "rgba(148,163,184,0.13)" },
      { bg: "#0d1b2a", ink: "#f0f9ff", accent: "#38bdf8", g1: "rgba(56,189,248,0.15)", g2: "rgba(148,163,184,0.12)" },
      { bg: "#1a1216", ink: "#fdf2f8", accent: "#f472b6", g1: "rgba(244,114,182,0.15)", g2: "rgba(168,162,158,0.12)" },
      { bg: "#f5f1e8", ink: "#1c1917", accent: "#dc2626", g1: "rgba(28,25,23,0.10)", g2: "rgba(220,38,38,0.10)" },
    ]);
    const ghostSrc = withText ? dTitle.replace(/\n/g, " ") : s;
    const rowYs = R([[110, 314, 518, 722, 926], [140, 380, 620, 860], [90, 260, 430, 600, 770, 940]]);
    const gRows = rowYs.map((y, i) =>
      `<text x="${i % 2 ? 1016 : 8}" y="${y}" text-anchor="${i % 2 ? "end" : "start"}" font-family="${FONT_STACK}" font-size="118" font-weight="800" letter-spacing="-2" fill="none" stroke="${i % 2 ? P.g2 : P.g1}" stroke-width="2">${esc(ghostSrc)}</text>`
    ).join("");
    body = `<rect width="1024" height="1024" fill="${P.bg}"/>${gRows}`;
    if (withText) {
      const t = titleBlock(840, 3, 118, 40);
      const topY = 512 - t.blockH / 2;
      const shadow = P.bg === "#f5f1e8" ? "" : `text-shadow: none;`;
      body += `
<rect x="92" y="${(topY - 54).toFixed(0)}" width="120" height="12" rx="6" fill="${P.accent}"/>
<text x="92" y="${(topY + t.fontSize).toFixed(0)}" font-family="${FONT_STACK}" font-size="${t.fontSize}" font-weight="800" letter-spacing="-3" fill="${P.ink}">${tspans(t.lines, 92, t.lh)}</text>
<line x1="92" y1="${(topY + t.blockH + 46).toFixed(0)}" x2="312" y2="${(topY + t.blockH + 46).toFixed(0)}" stroke="${P.ink}" stroke-opacity="0.35" stroke-width="4"/>
<circle cx="326" cy="${(topY + t.blockH + 46).toFixed(0)}" r="7" fill="${P.accent}"/>`;
    } else {
      body += `
<rect x="92" y="238" width="120" height="12" rx="6" fill="${P.accent}"/>
<line x1="92" y1="780" x2="312" y2="780" stroke="${P.ink}" stroke-opacity="0.35" stroke-width="4"/>
<circle cx="326" cy="780" r="7" fill="${P.accent}"/>`;
    }
  } else if (style === "branding") {
    const P = R([
      { c1: "#f43f5e", c2: "#a855f7", bgA: "#2a1035", bgB: "#120a1d", bgC: "#090e18" },
      { c1: "#38bdf8", c2: "#2dd4bf", bgA: "#0c2740", bgB: "#0a1626", bgC: "#070e18" },
      { c1: "#f59e0b", c2: "#f43f5e", bgA: "#301a06", bgB: "#1c1006", bgC: "#120a04" },
      { c1: "#34d399", c2: "#22d3ee", bgA: "#0a2e22", bgB: "#081a14", bgC: "#06110d" },
    ]);
    const glowCenter = R(["50% 30%", "38% 40%", "62% 35%"]);
    const rgba = (hex, a) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    defs = `<radialGradient id="bgr" cx="${glowCenter.split(" ")[0]}" cy="${glowCenter.split(" ")[1]}" r="80%"><stop offset="0%" stop-color="${P.bgA}"/><stop offset="55%" stop-color="${P.bgB}"/><stop offset="100%" stop-color="${P.bgC}"/></radialGradient>
<linearGradient id="gbar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${P.c1}"/><stop offset="1" stop-color="${P.c2}"/></linearGradient>
<linearGradient id="badge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${rgba(P.c1, 0.25)}"/><stop offset="1" stop-color="${rgba(P.c2, 0.25)}"/></linearGradient>
<filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="34"/></filter>`;
    const rings = R([
      `<circle cx="60" cy="60" r="137" fill="none" stroke="${rgba(P.c1, 0.28)}" stroke-width="26"/><circle cx="964" cy="964" r="120" fill="none" stroke="${rgba(P.c2, 0.30)}" stroke-width="20"/>`,
      `<circle cx="964" cy="60" r="137" fill="none" stroke="${rgba(P.c2, 0.28)}" stroke-width="26"/><circle cx="60" cy="964" r="120" fill="none" stroke="${rgba(P.c1, 0.30)}" stroke-width="20"/>`,
      `<circle cx="512" cy="-60" r="150" fill="none" stroke="${rgba(P.c1, 0.22)}" stroke-width="30"/><circle cx="80" cy="920" r="100" fill="none" stroke="${rgba(P.c2, 0.28)}" stroke-width="18"/>`,
    ]);
    body = `<rect width="1024" height="1024" fill="url(#bgr)"/>
${rings}
<circle cx="164" cy="798" r="7" fill="${P.c1}"/><circle cx="840" cy="246" r="5" fill="${P.c2}"/>
<circle cx="758" cy="870" r="4" fill="rgba(255,255,255,0.6)"/><circle cx="246" cy="174" r="4" fill="rgba(255,255,255,0.45)"/>`;
    if (withText) {
      const t = titleBlock(800, 3, 92, 36);
      const sf = fixedSubPx > 0 ? fixedSubPx : 28;
      const sl = subLines(800, sf);
      const subH = sl.length ? 30 + (sl.length - 1) * sf * 1.5 + sf : 0;
      const total = 128 + 52 + t.blockH + subH + 48 + 12;
      let y = 512 - total / 2;
      const badgeCy = y + 64;
      y += 128 + 52;
      const titleY = y + t.fontSize;
      y += t.blockH;
      const subY = y + 30 + sf;
      y += subH + 48;
      body += `
<circle cx="512" cy="${badgeCy.toFixed(0)}" r="80" fill="${rgba(P.c1, 0.35)}" filter="url(#glow)"/>
<circle cx="512" cy="${badgeCy.toFixed(0)}" r="64" fill="url(#badge)" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
${glyphAt(480, badgeCy - 32, 64, "#ffffff", 1.6)}
<text x="512" y="${titleY.toFixed(0)}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${t.fontSize}" font-weight="800" letter-spacing="-2.5" fill="#ffffff">${tspans(t.lines, 512, t.lh)}</text>
${sl.length ? `<text x="512" y="${subY.toFixed(0)}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${sf}" fill="rgba(255,255,255,0.8)">${sl.map((ln, i) => `<tspan x="512" dy="${i === 0 ? 0 : sf * 1.5}">${esc(ln)}</tspan>`).join("")}</text>` : ""}
<rect x="397" y="${y.toFixed(0)}" width="230" height="12" rx="6" fill="url(#gbar)"/>`;
    } else {
      body += `
<circle cx="512" cy="190" r="80" fill="${rgba(P.c1, 0.35)}" filter="url(#glow)"/>
<circle cx="512" cy="190" r="64" fill="url(#badge)" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>
${glyphAt(480, 158, 64, "#ffffff", 1.6)}
<rect x="397" y="800" width="230" height="12" rx="6" fill="url(#gbar)"/>`;
    }
  } else if (style === "photo_realistic") {
    // 풍경 3종: 석양 산맥 / 밤하늘 / 바다 수평선
    const scene = R(["sunset", "night", "sea"]);
    const poly = (hPct, pts) => {
      const top = 1024 - 1024 * hPct;
      return pts.map(([px, py]) => `${(px * 10.24).toFixed(1)},${(top + py * 10.24 * hPct).toFixed(1)}`).join(" ");
    };
    const m1pts = [[0,100],[0,62],[16,38],[30,58],[46,26],[60,52],[74,34],[88,56],[100,44],[100,100]];
    const m2pts = [[0,100],[0,70],[12,52],[26,68],[40,44],[58,72],[72,52],[86,70],[100,58],[100,100]];
    let ink = "#f0fdf4";
    if (scene === "night") {
      ink = "#e2e8f0";
      const stars = Array.from({ length: 26 }, (_, i) => {
        const sx = (i * 197 + 83) % 1024, sy = (i * 131 + 47) % 520;
        return `<circle cx="${sx}" cy="${sy}" r="${(i % 3) + 1.5}" fill="rgba(226,232,240,${0.35 + (i % 4) * 0.15})"/>`;
      }).join("");
      defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#070b1a"/><stop offset="55%" stop-color="#14204a"/><stop offset="100%" stop-color="#28407e"/></linearGradient>
<filter id="sunglow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="26"/></filter>`;
      body = `<rect width="1024" height="1024" fill="url(#sky)"/>${stars}
<circle cx="740" cy="210" r="100" fill="rgba(226,232,240,0.35)" filter="url(#sunglow)"/>
<circle cx="740" cy="210" r="72" fill="#e2e8f0"/>
<circle cx="712" cy="188" r="14" fill="rgba(148,163,184,0.5)"/><circle cx="762" cy="232" r="9" fill="rgba(148,163,184,0.4)"/>
<polygon points="${poly(0.46, m1pts)}" fill="#0e1630"/><polygon points="${poly(0.34, m2pts)}" fill="#060b1c"/>`;
    } else if (scene === "sea") {
      ink = "#fef3e2";
      defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#13324a"/><stop offset="58%" stop-color="#2a6f97"/><stop offset="100%" stop-color="#f4a261"/></linearGradient>
<linearGradient id="seag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0e4a68"/><stop offset="100%" stop-color="#0a3350"/></linearGradient>
<filter id="sunglow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="30"/></filter>`;
      body = `<rect width="1024" height="628" fill="url(#sky)"/>
<circle cx="512" cy="560" r="130" fill="rgba(252,211,77,0.5)" filter="url(#sunglow)"/>
<circle cx="512" cy="560" r="90" fill="#fcd34d"/>
<rect y="628" width="1024" height="396" fill="url(#seag)"/>
<rect x="430" y="650" width="164" height="8" rx="4" fill="rgba(252,211,77,0.55)"/>
<rect x="452" y="690" width="120" height="6" rx="3" fill="rgba(252,211,77,0.4)"/>
<rect x="472" y="726" width="80" height="5" rx="2.5" fill="rgba(252,211,77,0.3)"/>
<rect x="410" y="760" width="204" height="4" rx="2" fill="rgba(252,211,77,0.22)"/>`;
    } else {
      defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0e2233"/><stop offset="45%" stop-color="#14424b"/><stop offset="72%" stop-color="#3c6d55"/><stop offset="100%" stop-color="#c2803f"/></linearGradient>
<filter id="sunglow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="30"/></filter>`;
      body = `<rect width="1024" height="1024" fill="url(#sky)"/>
<circle cx="760" cy="220" r="120" fill="rgba(252,211,77,0.45)" filter="url(#sunglow)"/>
<circle cx="760" cy="220" r="85" fill="#fcd34d"/>
<polygon points="${poly(0.52, m1pts)}" fill="#1d3a30"/><polygon points="${poly(0.40, m2pts)}" fill="#122620"/>`;
    }
    if (withText) {
      const t = titleBlock(700, 2, 56, 28);
      const sf = fixedSubPx > 0 ? fixedSubPx : 25;
      const sl = subLines(700, sf);
      const contentH = t.blockH + (sl.length ? 14 + (sl.length - 1) * sf * 1.45 + sf : 0);
      const capH = Math.max(104, contentH) + 84;
      const capY = 1024 - 61 - capH;
      const titleY = capY + 42 + (Math.max(104, contentH) - contentH) / 2 + t.fontSize;
      const subY = capY + 42 + (Math.max(104, contentH) - contentH) / 2 + t.blockH + 14 + sf;
      body += `
<rect x="61" y="${capY.toFixed(0)}" width="902" height="${capH.toFixed(0)}" rx="26" fill="rgba(8,16,14,0.55)" stroke="rgba(255,255,255,0.12)"/>
<text x="107" y="${titleY.toFixed(0)}" font-family="${FONT_STACK}" font-size="${t.fontSize}" font-weight="800" letter-spacing="-1.5" fill="${ink}">${tspans(t.lines, 107, t.lh)}</text>
${sl.length ? `<text x="107" y="${subY.toFixed(0)}" font-family="${FONT_STACK}" font-size="${sf}" fill="${ink}" fill-opacity="0.8">${sl.map((ln, i) => `<tspan x="107" dy="${i === 0 ? 0 : sf * 1.45}">${esc(ln)}</tspan>`).join("")}</text>` : ""}
<rect x="817" y="${(capY + (capH - 104) / 2).toFixed(0)}" width="104" height="104" rx="24" fill="rgba(255,255,255,0.12)"/>
${glyphAt(841, capY + (capH - 104) / 2 + 24, 56, ink, 1.6)}`;
    } else {
      body += `
<rect x="858" y="856" width="104" height="104" rx="24" fill="rgba(255,255,255,0.12)"/>
${glyphAt(882, 880, 56, ink, 1.6)}`;
    }
  } else { // poster (기본)
    const P = R([
      { a: "#0b1226", b: "#132a54", c: "#1e3a8a", accent: "#38bdf8", rib1: "#f97316", rib2: "#fb5f2a", ghost: "#93c5fd", dot: "rgba(148,197,255,0.45)", ink: "#f8fafc" },
      { a: "#160b26", b: "#2d1454", c: "#5b21b6", accent: "#e879f9", rib1: "#facc15", rib2: "#f59e0b", ghost: "#d8b4fe", dot: "rgba(216,180,254,0.45)", ink: "#faf5ff" },
      { a: "#052019", b: "#0a3d2e", c: "#0f766e", accent: "#fbbf24", rib1: "#f43f5e", rib2: "#e11d48", ghost: "#6ee7b7", dot: "rgba(110,231,183,0.45)", ink: "#f0fdf4" },
      { a: "#1f0a0a", b: "#4c1212", c: "#991b1b", accent: "#fde047", rib1: "#f97316", rib2: "#ea580c", ghost: "#fca5a5", dot: "rgba(252,165,165,0.45)", ink: "#fff7ed" },
    ]);
    const ribAngle = R([-7, 7, -11]);
    const ghostRight = R([true, true, false]);
    defs = `<linearGradient id="pbg" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0%" stop-color="${P.a}"/><stop offset="55%" stop-color="${P.b}"/><stop offset="100%" stop-color="${P.c}"/></linearGradient>
<linearGradient id="rib" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${P.rib1}"/><stop offset="1" stop-color="${P.rib2}"/></linearGradient>
<pattern id="pd" width="34" height="34" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="3" fill="${P.dot}"/></pattern>`;
    body = `<rect width="1024" height="1024" fill="url(#pbg)"/>
<rect x="${ghostRight ? 655 : 69}" y="72" width="300" height="220" fill="url(#pd)"/>
${glyphAt(ghostRight ? 590 : -126, 164, 560, P.ghost, 1.1, 0.14)}
<g transform="rotate(${ribAngle} 512 512)"><rect x="-100" y="742" width="1224" height="118" fill="url(#rib)" opacity="0.92"/><rect x="-100" y="906" width="1224" height="26" fill="${P.accent}" opacity="0.75"/></g>`;
    if (withText) {
      const t = titleBlock(740, 3, 104, 40);
      const titleY = 246 + 12 + 40 + t.fontSize;
      const sf = fixedSubPx > 0 ? fixedSubPx : 29;
      const sl = subLines(740, sf);
      const subY = 246 + 12 + 40 + t.blockH + 26 + sf;
      body += `
<rect x="82" y="246" width="120" height="12" rx="6" fill="${P.accent}"/>
<text x="82" y="${titleY.toFixed(0)}" font-family="${FONT_STACK}" font-size="${t.fontSize}" font-weight="800" letter-spacing="-2.5" fill="${P.ink}">${tspans(t.lines, 82, t.lh)}</text>
${sl.length ? `<text x="82" y="${subY.toFixed(0)}" font-family="${FONT_STACK}" font-size="${sf}" fill="${P.ink}" fill-opacity="0.85">${sl.map((ln, i) => `<tspan x="82" dy="${i === 0 ? 0 : sf * 1.5}">${esc(ln)}</tspan>`).join("")}</text>` : ""}`;
    } else {
      body += `
<rect x="82" y="216" width="120" height="12" rx="6" fill="${P.accent}"/>`;
    }
    body += `
<rect x="82" y="866" width="92" height="92" rx="24" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.18)"/>
${glyphAt(102, 886, 52, P.ink, 1.6)}`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1024 1024" preserveAspectRatio="xMidYMid slice">
<defs>${defs}</defs>
${body}
</svg>`;
  const b64 = bytesToBase64(new TextEncoder().encode(svg));
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
  const style = STYLE_MODEL_CHAIN[String(body.style || "").trim()] ? String(body.style).trim() : "poster";
  const w = Math.max(512, Math.min(1536, parseInt(body.width, 10) || 1024));
  const h = Math.max(512, Math.min(1536, parseInt(body.height, 10) || 1024));
  // card_only: AI를 건너뛰고 곧장 SVG 디자인 카드만 만든다 (뉴런 0 —
  // 사용자가 "디자인 카드" 타입을 직접 고른 경우).
  const cardOnly = Boolean(body.card_only);

  if (!cardOnly && env && env.AI && typeof env.AI.run === "function") {
    for (const modelId of STYLE_MODEL_CHAIN[style]) {
      const hit = await tryModel(env, modelId, buildModelInput(modelId, prompt, style, w, h));
      if (hit) {
        return json({
          success: true,
          // 플러그인은 provider가 "workers-ai-flux"일 때만 "AI 그림"으로 표시하므로
          // (폴백과의 구분용 고정 문자열), 실제 모델 id는 model 필드로 따로 준다.
          provider: "workers-ai-flux",
          model: modelId,
          style,
          format: hit.mime.split("/")[1],
          mime_type: hit.mime,
          image_base64: hit.b64,
          data_url: `data:${hit.mime};base64,${hit.b64}`,
        });
      }
    }
  }

  const svg = fallbackSvg(topic || prompt, w, h, style,
    cardOnly ? String(body.title || "").slice(0, 120) : "",
    cardOnly ? String(body.subtitle || "").slice(0, 90) : "",
    cardOnly ? body.title_size : 0,
    cardOnly ? body.sub_size : 0);
  return json({
    success: true,
    provider: cardOnly ? "design-card" : "svg-fallback",
    style,
    format: "svg",
    mime_type: svg.mime,
    image_base64: svg.b64,
    data_url: `data:${svg.mime};base64,${svg.b64}`,
    note: cardOnly ? "요청에 따라 SVG 디자인 카드를 생성했습니다." : "Workers AI 바인딩이 없거나 이미지 모델 호출이 실패해 SVG 카드로 대체했습니다.",
  });
}

/* ── 라우팅 ────────────────────────────────────── */

const DOCS_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tamsaek-worker</title>
<style>body{font-family:system-ui,'Apple SD Gothic Neo',sans-serif;background:#0b1220;color:#e5e7eb;margin:0;padding:40px}main{max-width:760px;margin:auto;background:#111a2e;border:1px solid #24304d;border-radius:20px;padding:32px}code,pre{background:#0a0f1c;border:1px solid #24304d;border-radius:10px;padding:3px 8px}pre{display:block;padding:14px;overflow:auto}h1{font-size:22px}</style></head>
<body><main><h1>tamsaek-worker 검색·이미지 API</h1>
<p>탐색팩 플러그인용 검색 그라운딩 + AI 이미지 생성 워커입니다. 워드프레스 관리자 → AI 글쓰기 설정의 "검색 Worker 주소"에 이 주소를 넣으세요.</p>
<pre>GET  /api/search?q=검색어&amp;engine=all   (naver·daum·google뉴스 병렬)
GET  /api/search?q=검색어&amp;deep=1      (+뉴스·블로그 탭 상위 글 본문 발췌)
POST /api/research  {"query":"주제"}   (썸네일용 주제 조사 JSON)
POST /api/image  {"prompt":"...","width":1024,"height":1024}</pre>
<p>engine 값: <code>all</code> <code>naver</code> <code>daum</code> <code>bing</code> <code>google</code> (쉼표로 조합 가능)</p>
<p>Google은 자동화 차단 때문에 뉴스 RSS 기반이라 결과가 뉴스 기사로 한정됩니다. 이미지 생성은 Cloudflare Workers AI 바인딩이 켜져 있어야 실제 AI 이미지가 나오고, 없으면 SVG 카드로 대체됩니다.</p>
</main></body></html>`;

async function routeRequest(request, env) {
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
  if (url.pathname === "/api/research") {
    if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    return handleResearch(request, env);
  }
  if (url.pathname === "/api/image") {
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
    return handleImage(request, env);
  }
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(DOCS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
  }
  return json({ error: "Not Found", endpoints: ["/api/search?q=...&engine=all", "/api/research", "/api/image"] }, 404);
}

export default {
  async fetch(request, env) {
    /* ⚠️ 안정성: 어떤 경로에서 예외가 나든 항상 JSON을 반환한다. 전역
       try/catch가 없으면 Cloudflare가 "1101 Worker threw an exception"
       HTML 오류 페이지를 반환하고, 플러그인은 JSON을 기대하므로 관리
       화면에 아무 메시지 없이 실패하게 된다. */
    try {
      return await routeRequest(request, env);
    } catch (error) {
      return json({
        success: false,
        error: "internal_worker_error",
        message: String((error && error.message) || error),
      }, 500);
    }
  },
};
