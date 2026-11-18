#!/usr/bin/env node
/**
 * Get the END time of the maintenance window (UTC) from the Notices tab of
 * The Seven Deadly Sins: Origin.
 *
 * Flow:
 *  1. Fetch the Notices article list (data-list).
 *  2. Pick the most recent articles whose title contains "maintenance".
 *  3. Fetch the full content of each article (the `content` field in the list is only a snippet).
 *  4. Parse the "Maintenance Schedule" block -> start & end time (UTC).
 *  5. Pick the relevant schedule (ongoing/upcoming; otherwise the latest one)
 *     and print its end time.
 *
 * Requires Node.js 18+ (built-in fetch). No extra dependencies.
 * Usage:    node maintenance_checker.js [--all] [--debug]
 * Optional: DETAIL_URL_TEMPLATE="https://.../api/xxx?forumId=7dso_en&id={id}" node ...
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// ------------------------------------------------------------------ CONFIGURATION
const BASE = "https://7origin.netmarble.com";
const LIST_URL = `${BASE}/api/data-list`;
const LIST_PARAMS = {
  forumId: "7dso_en",
  start: 0,
  rows: 20, // fetch more so a maintenance notice is not missed
  name: "Notices",
  tab: "Notices",
  menuSeq: 2,
};
const MAX_NOTICES = 6; // how many of the newest maintenance articles to read in full

// Article detail endpoint. Placeholders: {id}, {objId}, {menuSeq}.
// Can be overridden with the DETAIL_URL_TEMPLATE env var; set it to "auto" to use auto-discovery.
const DEFAULT_DETAIL_URL =
  "https://7origin.netmarble.com/api/data-article?forumId=7dso_en&id={id}&menuSeq={menuSeq}";

/** If the template contains a literal id (e.g. id=347), it is automatically replaced with {id}. */
function normalizeTemplate(tpl) {
  if (!tpl || tpl === "auto") return "";
  if (/\{(id|objId)\}/.test(tpl)) return tpl;
  const fixed = tpl.replace(/([?&]id=)\d+/, "$1{id}");
  if (fixed !== tpl) {
    console.error("[i] Template has no {id}; the number after id= was automatically replaced with {id}.");
    return fixed;
  }
  console.error("[!] DETAIL_URL_TEMPLATE has no {id}/{objId}; every article would request the same URL.");
  return tpl;
}
const DETAIL_URL_TEMPLATE = normalizeTemplate(process.env.DETAIL_URL_TEMPLATE || DEFAULT_DETAIL_URL);
// On Vercel the project filesystem is read-only; only /tmp is writable.
const CACHE_FILE = path.join(process.env.VERCEL ? os.tmpdir() : __dirname, ".detail_endpoint.json");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${BASE}/en/news`,
  Origin: BASE,
};
const TIMEOUT_MS = 15000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// ------------------------------------------------------------------ PARSING
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Supported examples:
//   ✦ Maintenance Schedule
//   - November 19 (Thu) 01:00 - 09:00 (UTC) (8 hours)
//   - November 19 (Thu) 23:00 - November 20 (Fri) 05:00 (UTC)
//   - November 19 (Thu) 01:00:00 - 08:59:59 (UTC)        (seconds optional)
const SCHEDULE_RE = new RegExp(
  "Maintenance\\s+Schedule[\\s\\-\\u2013:\\u2022*]*" +
    "(?<m1>[A-Za-z]+)\\s+(?<d1>\\d{1,2})\\s*(?:\\([A-Za-z]{3,9}\\))?\\s*" +
    "(?<h1>\\d{1,2}):(?<n1>\\d{2})(?::(?<s1>\\d{2}))?\\s*[-\\u2013~]\\s*" +
    "(?:(?<m2>[A-Za-z]+)\\s+(?<d2>\\d{1,2})\\s*(?:\\([A-Za-z]{3,9}\\))?\\s*)?" +
    "(?<h2>\\d{1,2}):(?<n2>\\d{2})(?::(?<s2>\\d{2}))?\\s*\\(?\\s*UTC\\s*\\)?" +
    "(?:\\s*\\((?<dur>[\\d.]+)\\s*hours?\\))?",
  "gi"
);

const ENTITIES = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'", "&rsquo;": "\u2019", "&lsquo;": "\u2018",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);
}

/** Convert article HTML to plain text. Struck-through text (<s>/<strike>/<del>) is dropped. */
function htmlToText(raw) {
  let text = raw.replace(/<(s|strike|del)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>|<\/p>|<\/tr>|<\/li>|<\/div>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\u00a0/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  return text.replace(/\n\s*\n+/g, "\n");
}

/** A valid UTC Date, or null (e.g. February 30). */
function validUtc(y, mo, d, h, mi, s = 0) {
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const ok =
    dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d &&
    dt.getUTCHours() === h && dt.getUTCMinutes() === mi;
  return ok ? dt : null;
}
const addDays = (date, n) => new Date(date.getTime() + n * 86400000);

/**
 * Parse the "Maintenance Schedule" block.
 * refDate = the article's publish date; the year is chosen so the start date is
 * closest to refDate (safe across a year boundary). Returns
 * { start, end, durationInText } (UTC Dates) or null.
 */
function parseSchedule(text, refDate) {
  const refYear = refDate.getUTCFullYear();
  SCHEDULE_RE.lastIndex = 0;
  for (const m of text.matchAll(SCHEDULE_RE)) {
    const g = m.groups;
    const mo1 = MONTHS[g.m1.toLowerCase()];
    const mo2 = g.m2 ? MONTHS[g.m2.toLowerCase()] : mo1;
    if (!mo1 || !mo2) continue;
    const d1 = Number(g.d1);
    const d2 = g.d2 ? Number(g.d2) : d1;
    const [h1, n1, s1] = [Number(g.h1), Number(g.n1), Number(g.s1 ?? 0)];
    const [h2, n2, s2] = [Number(g.h2), Number(g.n2), Number(g.s2 ?? 0)];

    let best = null;
    for (const y of [refYear - 1, refYear, refYear + 1]) {
      const s = validUtc(y, mo1, d1, h1, n1, s1);
      if (!s) continue;
      const diff = Math.abs(s - refDate);
      if (!best || diff < best.diff) best = { y, s, diff };
    }
    if (!best) continue;

    const start = best.s;
    let end = validUtc(best.y, mo2, d2, h2, n2, s2);
    if (!end) continue;
    if (end <= start) {
      // "23:00 - 05:00" without a second date, or a year rollover
      end = g.m2 ? validUtc(best.y + 1, mo2, d2, h2, n2, s2) : addDays(end, 1);
      if (!end) continue;
    }
    return { start, end, durationInText: g.dur ? Number(g.dur) : null };
  }
  return null;
}

const versionOf = (title) => (title.match(/Version\s+(\d+(?:\.\d+)*)/i) || [])[1] ?? null;

// ------------------------------------------------------------------ HTTP
async function getJson(url, params) {
  const u = new URL(url);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));

  const res = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (res.status === 403 || body.slice(0, 300).includes("Access Denied")) {
    throw new Error(
      `Rejected by the server/CDN (HTTP ${res.status}) for ${u}. Check the URL path and ` +
        "run from a regular network; this script does not try to bypass protection."
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  return JSON.parse(body);
}

async function fetchNotices() {
  const data = await getJson(LIST_URL, LIST_PARAMS);
  return data.resultData.articleList;
}

// ------------------------------------------------------------------ AUTO-DISCOVERY
// Order: (1) override/cache, (2) scan the site's JavaScript, (3) headless browser
// (Playwright, optional) that captures the real detail request.
const DEBUG = process.argv.includes("--debug");
const dbg = (...a) => DEBUG && console.error("[debug]", ...a);

const fillTemplate = (tpl, art) =>
  tpl
    .split("{id}").join(art.id)
    .split("{objId}").join(art.objId)
    .split("{menuSeq}").join(art.menuSeq ?? LIST_PARAMS.menuSeq);

/** Turn a real request URL into a template: id/objId values are replaced by placeholders. */
function templateFromUrl(url, sample) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let tpl = url;
  for (const [key, val] of [["{id}", sample.id], ["{objId}", sample.objId]]) {
    tpl = tpl
      .replace(new RegExp(`([?&][^=&]+=)${esc(val)}(?=&|$)`, "g"), `$1${key}`)
      .replace(new RegExp(`/${esc(val)}(?=[/?]|$)`, "g"), `/${key}`);
  }
  return tpl.includes("{id}") || tpl.includes("{objId}") ? tpl : null;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Download the news page + referenced JS files (including chunks referenced from other JS). */
async function collectSources() {
  const pageUrl = `${BASE}/en/news`;
  const html = await fetchText(pageUrl);
  const sources = [html];
  const queue = [];
  const seen = new Set();
  const addUrl = (raw, base) => {
    try {
      const u = new URL(raw, base);
      if (u.origin === BASE && /\.js$/.test(u.pathname) && !seen.has(u.href)) {
        seen.add(u.href);
        queue.push(u.href);
      }
    } catch {
      /* invalid URL */
    }
  };
  for (const m of html.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/gi)) addUrl(m[1], pageUrl);

  let processed = 0;
  while (queue.length && processed++ < 60) {
    const href = queue.shift();
    try {
      const js = await fetchText(href);
      sources.push(js);
      for (const m of js.matchAll(/["'`]([^"'`\s]+\.js)["'`]/g)) addUrl(m[1], href);
    } catch (err) {
      dbg("download failed", href, err.message);
    }
  }
  dbg(`${sources.length} sources scanned (page + ${processed} JS files)`);
  return sources;
}

async function discoverCandidatePaths() {
  const found = new Set();
  for (const src of await collectSources()) {
    for (const m of src.matchAll(/\/api\/[\w\-/]+/g)) found.add(m[0].replace(/\/$/, ""));
    for (const m of src.matchAll(/["'`](data-[\w-]+)["'`]/g)) found.add(`/api/${m[1]}`);
  }
  found.delete("/api/data-list");
  found.delete("/api");
  const keyword = /detail|view|read|article|post|content/i;
  const list = [...found].sort((a, b) => Number(!keyword.test(a)) - Number(!keyword.test(b))).slice(0, 12);
  dbg("candidate paths:", list.length ? list.join(", ") : "(none)");
  return list;
}

/** Method 2: try candidates found in the site's JavaScript, verify with a real request. */
async function discoverDetailTemplate(sample) {
  const forum = LIST_PARAMS.forumId;
  const variants = [
    (p) => `${BASE}${p}?forumId=${forum}&id={id}`,
    (p) => `${BASE}${p}?forumId=${forum}&objId={objId}`,
    (p) => `${BASE}${p}?forumId=${forum}&id={id}&objId={objId}`,
  ];
  try {
    for (const p of await discoverCandidatePaths()) {
      for (const make of variants) {
        const tpl = make(p);
        try {
          const data = await getJson(fillTemplate(tpl, sample));
          const art = data?.resultData?.article;
          if (art?.content && art.id === sample.id) return tpl; // verified
          dbg("not an article:", tpl);
        } catch (err) {
          dbg("failed:", tpl, "->", err.message.slice(0, 80));
        }
      }
    }
  } catch (err) {
    dbg("JS scan failed:", err.message);
  }
  return null;
}

/**
 * Method 3 (optional): open the article page in a headless browser and capture
 * the real detail request. Requires: npm i playwright && npx playwright install chromium
 */
async function discoverWithBrowser(sample) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    dbg("playwright is not installed");
    return null;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: HEADERS["User-Agent"] });
    let hitUrl = null;
    page.on("response", async (res) => {
      if (hitUrl || !res.url().startsWith(BASE) || !res.url().includes("/api/")) return;
      try {
        const art = (await res.json())?.resultData?.article;
        if (art?.content && art.id === sample.id) hitUrl = res.url();
      } catch {
        /* not JSON */
      }
    });
    // Main way: open the article page directly (pattern /en/news/<menuSeq>/<id>), no clicking.
    const postUrl = `${BASE}/en/news/${sample.menuSeq ?? LIST_PARAMS.menuSeq}/${sample.id}`;
    dbg("opening", postUrl);
    await page.goto(postUrl, { waitUntil: "networkidle", timeout: 30000 });
    for (let i = 0; i < 10 && !hitUrl; i++) await page.waitForTimeout(500);

    if (!hitUrl) {
      // Fallback: go through the news list, click the Notices tab, then the article title.
      dbg("not captured via direct URL; trying via clicks");
      await page.goto(`${BASE}/en/news`, { waitUntil: "networkidle", timeout: 30000 });
      await page.getByText("Notices", { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.getByText(decodeEntities(sample.title).slice(0, 20)).first().click({ timeout: 8000 });
      for (let i = 0; i < 20 && !hitUrl; i++) await page.waitForTimeout(500);
    }
    dbg("detail request from browser:", hitUrl);
    return hitUrl ? templateFromUrl(hitUrl, sample) : null;
  } catch (err) {
    dbg("browser failed:", err.message.slice(0, 120));
    return null;
  } finally {
    await browser?.close();
  }
}

let detailTemplate = null;
let discoveryFailed = false; // discover only once per process
let detailUnavailable = false; // the full article content cannot be read
let newestNotice = null; // sample article (shown on page 1) used for verification

function loadCachedTemplate() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")).template || null;
  } catch {
    return null;
  }
}

async function readDetail(tpl, article) {
  const data = await getJson(fillTemplate(tpl, article));
  return data.resultData.article.content;
}

/** Fetch the full article content; fall back to the snippet if the detail endpoint is not found. */
async function fetchArticleContent(article) {
  detailTemplate ||= DETAIL_URL_TEMPLATE || loadCachedTemplate();

  if (detailTemplate) {
    try {
      return await readDetail(detailTemplate, article);
    } catch (err) {
      if (DETAIL_URL_TEMPLATE) throw err; // manual override: do not rediscover
      dbg("cached template failed:", err.message);
      detailTemplate = null; // stale cache -> rediscover once
      try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
    }
  }

  if (!discoveryFailed) {
    const sample = newestNotice ?? article;
    detailTemplate = (await discoverDetailTemplate(sample)) ?? (await discoverWithBrowser(sample));
    if (detailTemplate) {
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ template: detailTemplate }, null, 2));
      } catch (err) {
        dbg("cache could not be written:", err.message); // not fatal
      }
      console.error(`[i] Detail endpoint found: ${detailTemplate}`);
      return readDetail(detailTemplate, article);
    }
    discoveryFailed = true;
    console.error(
      "[!] Detail endpoint could not be discovered automatically; using the `content` snippet (it may be truncated)."
    );
  }
  detailUnavailable = true;
  return article.content ?? "";
}

// ------------------------------------------------------------------ MAIN
/** Collect schedules from the newest maintenance articles (no status yet). */
async function collectSchedules(maxNotices = MAX_NOTICES) {
  const articles = await fetchNotices();
  newestNotice = [...articles].sort((a, b) => (b.regDate ?? 0) - (a.regDate ?? 0))[0] ?? null;

  let candidates = articles.filter((a) => /maintenance/i.test(decodeEntities(a.title ?? "")));
  if (candidates.length === 0) candidates = articles; // no title contains the word maintenance
  candidates.sort((a, b) => (b.regDate ?? 0) - (a.regDate ?? 0));
  candidates = candidates.slice(0, maxNotices);

  const results = [];
  const errors = [];
  for (const art of candidates) {
    try {
      const text = htmlToText(await fetchArticleContent(art));
      const parsed = parseSchedule(text, new Date(art.regDate));
      if (!parsed) continue;
      const { start, end, durationInText } = parsed;
      const title = decodeEntities(art.title);
      results.push({
        article_id: art.id,
        title,
        version: versionOf(title),
        start_utc: start.toISOString(),
        end_utc: end.toISOString(),
        end_wib: new Date(end.getTime() + WIB_OFFSET_MS).toISOString().replace("Z", "+07:00"),
        duration_hours: (end - start) / 3600000,
        duration_in_text: durationInText,
      });
    } catch (err) {
      errors.push(err);
    }
  }
  if (results.length === 0 && errors.length > 0) throw errors[0];
  if (results.length === 0 && detailUnavailable) {
    throw new Error(
      "The full article content cannot be read because the detail endpoint was not found. Options: "
        + "(1) run with --debug to see the candidates; "
        + "(2) npm i playwright && npx playwright install chromium, then run again; "
        + "(3) set DETAIL_URL_TEMPLATE from the Request URL in the Network tab."
    );
  }
  return results;
}

function statusOf(item, now) {
  if (now < new Date(item.start_utc)) return "upcoming";
  if (now <= new Date(item.end_utc)) return "ongoing";
  return "finished";
}

const annotate = (items, now) => items.map((r) => ({ ...r, status: statusOf(r, now) }));
const t = (iso) => new Date(iso).getTime();

/** Relevant schedule: ongoing/upcoming (nearest); if none, the most recently finished. */
function pickRelevant(results, now = new Date()) {
  const items = annotate(results, now);
  const active = items.filter((r) => r.status !== "finished").sort((a, b) => t(a.start_utc) - t(b.start_utc));
  if (active.length) return active[0];
  return items.sort((a, b) => t(b.end_utc) - t(a.end_utc))[0] ?? null;
}

async function findMaintenanceEnd(includeAll = false, now = new Date()) {
  const results = await collectSchedules();
  if (includeAll) return annotate(results, now).sort((a, b) => t(b.start_utc) - t(a.start_utc));
  const picked = pickRelevant(results, now);
  return picked ? [picked] : [];
}

async function main() {
  let found;
  try {
    found = await findMaintenanceEnd(process.argv.includes("--all"));
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  }

  if (found.length === 0) {
    console.log("No article with a parsable 'Maintenance Schedule' was found.");
    process.exit(2);
  }

  for (const it of found) {
    console.log(`Article  : ${it.title} (id ${it.article_id})`);
    console.log(`Version  : ${it.version ?? "-"}   Status: ${it.status}`);
    console.log(`Start    : ${it.start_utc}`);
    console.log(`End      : ${it.end_utc}   <-- maintenance end time (UTC)`);
    console.log(`           ${it.end_wib}   (WIB)`);
    if (it.duration_in_text && Math.abs(it.duration_in_text - it.duration_hours) > 0.05) {
      console.log(
        `[!] Duration in text (${it.duration_in_text} h) differs from the computed duration (${it.duration_hours} h).`
      );
    }
  }
  console.log(JSON.stringify(found[0]));
}

module.exports = {
  htmlToText, parseSchedule, versionOf, templateFromUrl, collectSchedules, pickRelevant, findMaintenanceEnd,
};

if (require.main === module) main();