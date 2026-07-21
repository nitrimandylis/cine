#!/usr/bin/env bun
/**
 * cine — Village Cinemas (Greece) showtimes in your terminal.
 *
 * Scrapes villagecinemas.gr for what's playing, enriches every movie with
 * its IMDB rating and plot, and shows it all in an interactive TUI with
 * real movie posters (Kitty graphics protocol, half-block fallback).
 *
 * Zero runtime dependencies: fetch + sips(1) + open(1).
 */

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VILLAGE_URL = "https://www.villagecinemas.gr/en/tickets/film-choice";
const VILLAGE_HOST = "https://www.villagecinemas.gr";
const IMDB_SUGGEST = "https://v2.sg.media-imdb.com/suggestion";
const IMDB_GRAPHQL = "https://api.graphql.imdb.com/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const CINEMAS: Record<string, string> = {
  "21": "Maroussi - The Mall Athens",
  "01": "Rentis - Village Shopping and more...",
  "22": "Thessaloniki - Mediterranean Cosmos",
  "26": "Agios Dimitrios - Athens Metro Mall",
  "03": "Pagrati - Pagrati Village",
  "23": "Volos - Volos Village",
  "30": "Larissa - Fashion City Outlet",
};

// ponytail: prices are hardcoded, same as the original — update by hand when they change
const PRICE_TABLE = [
  "┌──────────────────┬───────────┐",
  "│   normal cost    │ what's up │",
  "├─────────┬────────┼───────────┤",
  "│ classic │  9,5 € │   6,65 €  │",
  "│  dolby  │ 10,5 € │   7,35 €  │",
  "│   vmax  │ 12,0 € │   8,40 €  │",
  "│   gold  │ 24,5 € │           │",
  "└─────────┴────────┴───────────┘",
];

const CACHE_DIR = join(homedir(), ".cache", "cine");
const POSTER_DIR = join(CACHE_DIR, "posters");
const CONFIG_PATH = join(homedir(), ".config", "cine", "config.json");
const CACHE_TTL_HOURS = 12;

const HELP = `cine — Village Cinemas (Greece) showtimes with IMDB ratings and posters

usage:
  cine                 interactive TUI (remembers your cinema)
  cine -c 21           jump straight to a cinema by ID
  cine -d 25/07        filter piped output to a date (DD/MM)
  cine --list          list cinema IDs and exit
  cine --clear         clear the cache for your cinema, then fetch fresh
  cine --no-cache      ignore the cache, always fetch fresh

siren (ticket alerts via github.com/nitrimandylis/siren):
  cine watch                     list active watches
  cine watch <title> [--imax]    get pinged when tickets open (-c limits cinema)
  cine unwatch <title>           stop watching

keys (inside the TUI):
  ⇥ switch tab (Cinemas / Home)   ↑/↓/←/→ move   ⏎ details   q quit
  Cinemas: s sort · w watch · t trailer · b book · p prices · c cinema · r refresh
  Home:    / search · p play (stream to IINA via rqbit)

Home streams via torrents (needs rqbit: brew install rqbit). showtimes: cyan
= on sale, yellow = few seats, red ✗ = sold out — as reported by Village,
whose flags often lag real availability.
piped output (cine | cat) prints a plain list instead of the TUI.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Showtime = {
  hour: string;
  screen: string;
  soldout: boolean;
  dolby: boolean;
  sphera: boolean;
  threeD: boolean;
  imax: boolean;
  imax3d: boolean;
  limited: boolean;
};

export type RtScores = {
  critic: number | null;
  criticState: "certified" | "fresh" | "rotten" | null;
  criticCount: number;
  audience: number | null;
  audienceState: "verified" | "upright" | "spilled" | null;
  audienceCount: number;
  url: string;
};

export type Movie = {
  id: string;
  title: string;
  genre: string;
  pg: string;
  minutes: number;
  plot: string;
  url: string;
  trailer: string;
  poster: string; // village poster URL
  days: Record<string, Showtime[]>; // "YYYY-MM-DD" -> showtimes
  rating: number | null;
  votes: number;
  imdbUrl: string;
  imdbPlot: string;
  imdbPoster: string;
  rt: RtScores | null;
  year?: number; // Home tab (IMDB search) results carry a year; Village movies don't
  enriched?: boolean; // Home detail rating/plot fetched lazily, once
};

const CACHE_VERSION = 3; // bump when Movie shape/enrichment changes so stale caches refetch

type CachePayload = {
  v?: number;
  cachedAt: string;
  cinemaId: string;
  cinemaName: string;
  movies: Movie[];
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Accept a real array, or a stringified list like "['01', '21']". */
export function pyList(s: string[] | string): string[] {
  if (Array.isArray(s)) return s;
  if (!s || s === "[]") return [];
  try {
    return JSON.parse(s.replace(/'/g, '"'));
  } catch {
    return [];
  }
}

export function pyBool(s: string): boolean {
  return s === "True" || s === "true";
}

export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Local date as "YYYY-MM-DD" (ISO strings compare correctly as strings). */
export function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** "YYYY-MM-DD" -> "Sat 25/07" */
export function fmtDay(iso: string, today: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  const label = `${wd} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  return iso === today ? `${label} (today)` : label;
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function isCacheFresh(payload: CachePayload, now: Date): boolean {
  const age = now.getTime() - new Date(payload.cachedAt).getTime();
  if (isNaN(age) || age > CACHE_TTL_HOURS * 3600_000) return false;
  const today = isoDay(now);
  const allDays = payload.movies.flatMap((m) => Object.keys(m.days));
  if (allDays.length && allDays.every((d) => d < today)) return false;
  return payload.movies.length > 0;
}

type Suggestion = { id: string; l: string; y?: number; qid?: string };

/** Prefer a recent movie result; fall back to the first movie, then anything. */
export function pickImdbMatch(list: Suggestion[], nowYear: number): Suggestion | undefined {
  const movies = list.filter((t) => t.qid === "movie" || t.qid === "tvMovie");
  return movies.find((t) => (t.y ?? 0) >= nowYear - 1) ?? movies[0] ?? list[0];
}

// ---------------------------------------------------------------------------
// Village scraping
// ---------------------------------------------------------------------------

export function parseBookingData(
  html: string,
  cinemaId: string,
): { cinemaName: string; movies: Movie[] } {
  const m = html.match(/var bookingData = (\{[\s\S]*?)<\/script>/);
  if (!m) throw new Error("could not find bookingData on the Village page");
  const data = JSON.parse(m[1]);

  const cinemaName: string =
    data.filters?.cinemas?.find((c: any) => c.value === cinemaId)?.display ??
    CINEMAS[cinemaId] ??
    `Cinema ${cinemaId}`;

  // film id -> day -> showtimes
  const byFilm: Record<string, Record<string, Showtime[]>> = {};
  for (const s of data.screens) {
    if (s.cinemaId !== cinemaId) continue;
    const [day, time] = String(s.showtime).split("T");
    const st: Showtime = {
      hour: time.slice(0, 5),
      screen: s.screenName ?? "",
      soldout: Boolean(s.soldoutStatus),
      dolby: Boolean(s.isDolby),
      sphera: Boolean(s.isSphera),
      threeD: Boolean(s.is3D),
      imax: Boolean(s.isImax),
      imax3d: Boolean(s.isImax3D),
      limited: Boolean(s.isLimited),
    };
    ((byFilm[s.scheduledFilmId] ??= {})[day] ??= []).push(st);
  }
  for (const days of Object.values(byFilm))
    for (const list of Object.values(days)) list.sort((a, b) => a.hour.localeCompare(b.hour));

  const movies: Movie[] = [];
  const seen = new Set<string>();
  for (const r of data.records) {
    if (!pyList(r.cinemas).includes(cinemaId)) continue;
    if (seen.has(r.title)) continue;
    seen.add(r.title);
    movies.push({
      id: r.movieId,
      title: r.title,
      genre: (r.genre ?? "").toLowerCase(),
      pg: r.pg ?? "",
      minutes: parseInt(r.dur, 10) || 0,
      plot: stripHtml(r.desc ?? ""),
      url: r.url ?? "",
      trailer: r.vid ? `https://www.youtube.com/watch?v=${r.vid}` : "",
      poster: r.thumb ? VILLAGE_HOST + r.thumb : "",
      days: byFilm[r.movieId] ?? {},
      rating: null,
      votes: 0,
      imdbUrl: "",
      imdbPlot: "",
      imdbPoster: "",
      rt: null,
    });
  }
  return { cinemaName, movies };
}

async function fetchVillage(cinemaId: string): Promise<{ cinemaName: string; movies: Movie[] }> {
  const res = await fetch(VILLAGE_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Village fetch failed: HTTP ${res.status}`);
  return parseBookingData(await res.text(), cinemaId);
}

// ---------------------------------------------------------------------------
// IMDB enrichment (keyless: suggestion API + public GraphQL endpoint)
// ---------------------------------------------------------------------------

/** Enrich from IMDB; returns the canonical (English) title when matched. */
async function imdbLookup(movie: Movie): Promise<string | null> {
  try {
    const q = movie.title.toLowerCase().trim();
    const first = q.replace(/[^a-z0-9]/g, "")[0] ?? "x";
    const res = await fetch(`${IMDB_SUGGEST}/${first}/${encodeURIComponent(q)}.json`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return null;
    const hits: Suggestion[] = (await res.json()).d ?? [];
    const match = pickImdbMatch(hits, new Date().getFullYear());
    if (!match) return null;

    const gql = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        query: `query { title(id: "${match.id}") {
          ratingsSummary { aggregateRating voteCount }
          plot { plotText { plainText } }
          primaryImage { url }
        } }`,
      }),
    });
    if (!gql.ok) return match.l ?? null;
    const t = (await gql.json()).data?.title;
    if (!t) return match.l ?? null;
    movie.rating = t.ratingsSummary?.aggregateRating ?? null;
    movie.votes = t.ratingsSummary?.voteCount ?? 0;
    movie.imdbUrl = `https://www.imdb.com/title/${match.id}/`;
    movie.imdbPlot = t.plot?.plotText?.plainText ?? "";
    movie.imdbPoster = t.primaryImage?.url ?? "";
    return match.l ?? null;
  } catch {
    // no IMDB data — the movie just shows "?" for its rating
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rotten Tomatoes enrichment (server-rendered search page + scorecard JSON)
// ---------------------------------------------------------------------------

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Pick the best /m/ movie URL from RT's search page HTML.
 * Only accepts results whose name actually matches the query (RT search
 * happily returns unrelated movies), preferring recent releases.
 */
export function parseRtSearch(html: string, nowYear: number, query: string): string | null {
  const rows = html.match(/<search-page-media-row[\s\S]*?<\/search-page-media-row>/g) ?? [];
  const q = normTitle(query);
  const candidates: { url: string; year: number }[] = [];
  for (const row of rows) {
    const url = row.match(/href="(https:\/\/www\.rottentomatoes\.com\/m\/[^"]+)"/)?.[1];
    const year = parseInt(row.match(/release-year="(\d*)"/)?.[1] ?? "", 10) || 0;
    if (!url) continue;
    const name = normTitle(stripHtml(row));
    if (!q || !name.includes(q)) continue;
    candidates.push({ url, year });
  }
  return (candidates.find((c) => c.year >= nowYear - 1) ?? candidates[0])?.url ?? null;
}

/** Extract Tomatometer + Popcornmeter from an RT movie page's scorecard JSON. */
export function parseRtScorecard(html: string, url: string): RtScores | null {
  const m = html.match(/id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const sc = JSON.parse(m[1]);
  const c = sc.criticsScore ?? {};
  const a = sc.audienceScore ?? {};
  const critic = parseInt(c.score, 10);
  const audience = parseInt(a.score, 10);
  if (isNaN(critic) && isNaN(audience)) return null;
  return {
    critic: isNaN(critic) ? null : critic,
    criticState: isNaN(critic)
      ? null
      : c.certified
        ? "certified"
        : c.sentiment === "POSITIVE"
          ? "fresh"
          : "rotten",
    criticCount: c.reviewCount ?? 0,
    audience: isNaN(audience) ? null : audience,
    audienceState: isNaN(audience)
      ? null
      : a.certified || a.scoreType === "VERIFIED"
        ? "verified"
        : a.sentiment === "POSITIVE"
          ? "upright"
          : "spilled",
    audienceCount: a.reviewCount ?? 0,
    url,
  };
}

/** Try RT with each candidate title (canonical IMDB title first — Village
 *  titles are often localized, e.g. VAIANA for Moana, which RT can't find). */
async function rtLookup(movie: Movie, canonicalTitle: string | null): Promise<void> {
  const villageTitle = movie.title.replace(/\(.*?\)/g, "").trim(); // drop "(DUBBED...)" etc.
  const queries = [...new Set([canonicalTitle, villageTitle].filter(Boolean))] as string[];
  for (const title of queries) {
    try {
      const q = encodeURIComponent(title.toLowerCase().trim());
      const search = await fetch(`https://www.rottentomatoes.com/search?search=${q}`, {
        headers: { "User-Agent": UA },
      });
      if (!search.ok) continue;
      const url = parseRtSearch(await search.text(), new Date().getFullYear(), title);
      if (!url) continue;
      const page = await fetch(url, { headers: { "User-Agent": UA } });
      if (!page.ok) continue;
      movie.rt = parseRtScorecard(await page.text(), url);
      if (movie.rt) return;
    } catch {
      // try the next title, or leave rt empty
    }
  }
}

async function enrich(movies: Movie[], onProgress: (done: number, total: number) => void) {
  let done = 0;
  await Promise.all(
    movies.map((m) =>
      imdbLookup(m)
        .then((canonical) => rtLookup(m, canonical))
        .then(() => onProgress(++done, movies.length)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Cache + config
// ---------------------------------------------------------------------------

function cachePath(cinemaId: string): string {
  return join(CACHE_DIR, `${cinemaId}.json`);
}

function loadCache(cinemaId: string): CachePayload | null {
  try {
    const payload: CachePayload = JSON.parse(readFileSync(cachePath(cinemaId), "utf-8"));
    if (payload.v !== CACHE_VERSION) return null;
    return isCacheFresh(payload, new Date()) ? payload : null;
  } catch {
    return null;
  }
}

function saveCache(payload: CachePayload) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(payload.cinemaId), JSON.stringify(payload));
}

type Config = { cinema?: string; sort?: SortKey };

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(join(homedir(), ".config", "cine"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  inv: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
  bgSel: "\x1b[48;2;40;44;60m",
};

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visLen(s: string): number {
  return stripAnsi(s).length;
}

function truncate(s: string, width: number): string {
  if (visLen(s) <= width) return s;
  let out = "";
  let len = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b")) {
      out += part;
      continue;
    }
    const room = width - 1 - len;
    if (room <= 0) break;
    out += part.slice(0, room);
    len += Math.min(part.length, room);
  }
  return out + "…";
}

function center(s: string, width: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - visLen(s)) / 2))) + s;
}

function ratingStr(m: Movie): string {
  if (m.rating === null) return `${A.grey}  ?${A.reset}`;
  const col = m.rating >= 7 ? A.green : m.rating >= 6 ? A.yellow : A.red;
  return `${col}${A.bold}${m.rating.toFixed(1)}★${A.reset}`;
}

function badges(st: Showtime): string {
  const p: string[] = [];
  if (st.screen.includes("VMax")) p.push(`${A.yellow}VMax${A.reset}`);
  if (st.screen.includes("GOLD")) p.push(`${A.yellow}Gold${A.reset}`);
  if (st.dolby) p.push(`${A.grey}Dolby${A.reset}`);
  if (st.sphera) p.push(`${A.green}Sphera${A.reset}`);
  if (st.imax) p.push(`${A.green}IMax${A.reset}`);
  if (st.threeD) p.push(`${A.red}3D${A.reset}`);
  if (st.imax3d) p.push(`${A.red}IMax3D${A.reset}`);
  return p.join("·");
}

function showtimeStr(st: Showtime): string {
  const b = badges(st);
  // red ✗ = sold out, yellow = few seats left (Village's isLimited flag)
  const hour = st.soldout
    ? `${A.red}${A.dim}${st.hour}✗${A.reset}`
    : st.limited
      ? `${A.yellow}${A.bold}${st.hour}${A.reset}`
      : `${A.cyan}${A.bold}${st.hour}${A.reset}`;
  return b ? `${hour}${A.dim}·${A.reset}${b}` : hour;
}

// ---------------------------------------------------------------------------
// Rotten Tomatoes ANSI icons (terminal recreations of RT's icon set)
// ---------------------------------------------------------------------------

const RT_RED = "\x1b[38;2;250;60;45m";
const RT_GREEN = "\x1b[38;2;110;190;60m"; // rotten splat
const RT_LEAF = "\x1b[38;2;80;170;70m";
const RT_GOLD = "\x1b[38;2;255;200;70m";
const RT_TEAL_BG = "\x1b[48;2;35;150;140m";
const RT_WHITE = "\x1b[38;2;245;245;240m";
const R = A.reset;

// striped popcorn bucket rows: alternating red/white text columns
const BUCKET =
  ` ${RT_RED}|${RT_WHITE}=${RT_RED}|${RT_WHITE}=${RT_RED}|${RT_WHITE}=${RT_RED}|${R} `;
const BUCKET_TIPPED = `${RT_RED}\\${RT_WHITE}=${RT_RED}\\${RT_WHITE}=${RT_RED}\\${R}`;

// text-character recreations of RT's icon set, each line 9 visible columns
export const RT_ICONS: Record<string, string[]> = {
  certified: [
    `${RT_GOLD}*${R}  ${RT_LEAF}\\|/${R}  ${RT_GOLD}*${R}`,
    `  ${RT_RED}.---.${R}  `,
    ` ${RT_RED}(     )${R} `,
    `${RT_GOLD}*${R} ${RT_RED}'---'${R} ${RT_GOLD}*${R}`,
  ],
  fresh: [
    `   ${RT_LEAF}\\|/${R}   `,
    `  ${RT_RED}.---.${R}  `,
    ` ${RT_RED}(     )${R} `,
    `  ${RT_RED}'---'${R}  `,
  ],
  rotten: [
    `  ${RT_GREEN}. , .${R}  `,
    ` ${RT_GREEN}(,'~',)${R} `,
    ` ${RT_GREEN}',~.~,'${R} `,
    `  ${RT_GREEN}'   '${R}  `,
  ],
  verified: [
    `  ${RT_GOLD}*.*.*${R}  `,
    BUCKET,
    ` ${RT_RED}|${RT_TEAL_BG}${RT_GOLD} HOT ${R}${RT_RED}|${R} `,
    `  ${RT_RED}\\___/${R}  `,
  ],
  upright: [
    `  ${RT_GOLD}*.*.*${R}  `,
    BUCKET,
    BUCKET,
    `  ${RT_RED}\\___/${R}  `,
  ],
  spilled: [
    `      ${RT_GOLD}o o${R}`,
    ` ${BUCKET_TIPPED} ${RT_GOLD}o${R} `,
    `  ${BUCKET_TIPPED}${RT_GOLD}.${R} `,
    `   ${RT_RED}\\__\\${R}  `,
  ],
};

const RT_LABELS: Record<string, string> = {
  certified: "Certified Fresh",
  fresh: "Fresh",
  rotten: "Rotten",
  verified: "Verified Hot",
  upright: "Hot",
  spilled: "Spilled",
};

/** One meter (icon + score + labels) as 4 aligned lines. */
function rtMeter(state: string, pct: number, meter: string, sub: string): string[] {
  const icon = RT_ICONS[state];
  return [
    `${icon[0]}  ${A.bold}${pct}%${A.reset}`,
    `${icon[1]}  ${A.grey}${meter} · ${RT_LABELS[state]}${A.reset}`,
    `${icon[2]}  ${A.grey}${sub}${A.reset}`,
    `${icon[3]}`,
  ];
}

/** Rotten Tomatoes block for the detail view (side-by-side when it fits). */
function rtBlock(m: Movie, width: number): string[] {
  const rt = m.rt;
  if (!rt) return [];
  const cols: string[][] = [];
  if (rt.critic !== null && rt.criticState)
    cols.push(
      rtMeter(rt.criticState, rt.critic, "Tomatometer", `${rt.criticCount.toLocaleString("en")} reviews`),
    );
  if (rt.audience !== null && rt.audienceState)
    cols.push(
      rtMeter(
        rt.audienceState,
        rt.audience,
        "Popcornmeter",
        `${rt.audienceCount.toLocaleString("en")}${rt.audienceState === "verified" ? " verified" : ""} ratings`,
      ),
    );
  if (!cols.length) return [];
  // pad to the widest left line so the right column starts at one fixed x
  const leftW = Math.max(...cols[0].map(visLen)) + 3;
  const rightW = cols.length === 2 ? Math.max(...cols[1].map(visLen)) : 0;
  if (cols.length === 2 && width >= leftW + rightW) {
    return cols[0].map((l, i) => l + " ".repeat(leftW - visLen(l)) + cols[1][i]);
  }
  return cols.length === 2 ? [...cols[0], "", ...cols[1]] : cols[0];
}

/** Compact colored critic score for the grid ("82%" in RT red / rotten green). */
function rtGridStr(m: Movie): string {
  if (m.rt?.critic == null) return "";
  const col = m.rt.criticState === "rotten" ? RT_GREEN : RT_RED;
  return ` ${col}${m.rt.critic}%${A.reset}`;
}

// ---------------------------------------------------------------------------
// Posters (sips + Kitty graphics protocol, half-block fallback)
// ---------------------------------------------------------------------------

function kittySupported(): boolean {
  const t = `${process.env.TERM ?? ""} ${process.env.TERM_PROGRAM ?? ""}`.toLowerCase();
  return /kitty|ghostty|wezterm/.test(t);
}

function sips(args: string[]): boolean {
  const r = Bun.spawnSync(["sips", ...args], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
}

function pngSize(path: string): { w: number; h: number } | null {
  // PNG IHDR: width/height are big-endian u32 at bytes 16 and 20
  try {
    const buf = readFileSync(path);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function gridThumbPath(png: string): string {
  const thumb = png.replace(/\.png$/, ".grid.png");
  if (!existsSync(thumb)) sips(["-s", "format", "png", "-Z", "360", png, "--out", thumb]);
  return existsSync(thumb) ? thumb : png;
}

/** Download + convert a movie's poster; returns the cached PNG path or null. */
async function ensurePoster(movie: Movie): Promise<string | null> {
  const url = movie.poster || movie.imdbPoster;
  if (!url) return null;
  mkdirSync(POSTER_DIR, { recursive: true });
  const png = join(POSTER_DIR, `${movie.id}.png`);
  if (existsSync(png)) return png;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const raw = join(POSTER_DIR, `${movie.id}.raw`);
    writeFileSync(raw, new Uint8Array(await res.arrayBuffer()));
    const ok = sips(["-s", "format", "png", "-Z", "600", raw, "--out", png]);
    rmSync(raw, { force: true });
    return ok && existsSync(png) ? png : null;
  } catch {
    return null;
  }
}

/** Cell width a poster occupies at a given row height (assumes ~1:2 cell aspect). */
function posterCellCols(png: string | null, rows: number): number {
  // ponytail: exact cell metrics would need a terminal query; 712x980 is Village's poster ratio
  const size = png ? pngSize(png) : null;
  const [w, h] = size ? [size.w, size.h] : [712, 980];
  return Math.max(1, Math.round((rows * 2 * w) / h));
}

const b64Cache = new Map<string, string>();

function pngB64(path: string): string {
  let hit = b64Cache.get(path);
  if (!hit) {
    hit = readFileSync(path).toString("base64");
    b64Cache.set(path, hit);
  }
  return hit;
}

/** Transfer + display a PNG at (row,col), scaled into rows×cols cells (a=T). */
// ponytail: re-sends image data on every full redraw — a=p placements by id
// didn't render in Ghostty, and small grid thumbs keep this cheap
function drawPoster(png: string, row: number, col: number, rows: number, cols: number) {
  const data = pngB64(png);
  let s = `\x1b[${row};${col}H`;
  for (let i = 0; i < data.length; i += 4096) {
    const last = i + 4096 >= data.length;
    const ctrl = i === 0 ? `f=100,a=T,C=1,q=2,r=${rows},c=${cols},m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
    s += `\x1b_G${ctrl};${data.slice(i, i + 4096)}\x1b\\`;
  }
  process.stdout.write(s);
}

const halfblockCache = new Map<string, string[]>();

/** Parse an uncompressed 24/32-bit BMP into a pixel getter. */
export function parseBmp(buf: Buffer): { w: number; h: number; px: (x: number, y: number) => [number, number, number] } {
  const off = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22); // negative height = top-down row order
  const h = Math.abs(rawH);
  const bytes = buf.readUInt16LE(28) / 8;
  const rowSize = Math.ceil((w * bytes) / 4) * 4;
  const px = (x: number, y: number): [number, number, number] => {
    const row = rawH < 0 ? y : h - 1 - y;
    const p = off + row * rowSize + x * bytes;
    return [buf[p + 2], buf[p + 1], buf[p]]; // BMP stores BGR
  };
  return { w, h, px };
}

/** Render the poster as half-block truecolor lines (any terminal). Cached. */
function posterHalfblockLines(png: string, rows: number): string[] {
  const key = `${png}:${rows}`;
  const hit = halfblockCache.get(key);
  if (hit) return hit;
  const size = pngSize(png);
  if (!size) return [];
  const cols = Math.max(1, Math.round((rows * 2 * size.w) / size.h));
  const bmp = join(POSTER_DIR, "small.bmp");
  if (!sips(["-s", "format", "bmp", "-z", String(rows * 2), String(cols), png, "--out", bmp]))
    return [];
  try {
    const { w, h, px } = parseBmp(readFileSync(bmp));
    const lines: string[] = [];
    for (let y = 0; y + 1 < h; y += 2) {
      let line = "";
      for (let x = 0; x < w; x++) {
        const [tr, tg, tb] = px(x, y);
        const [br, bg2, bb] = px(x, y + 1);
        line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg2};${bb}m▀`;
      }
      lines.push(line + A.reset);
    }
    halfblockCache.set(key, lines);
    return lines;
  } catch {
    return [];
  } finally {
    rmSync(bmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// siren integration — manage nitrimandylis/siren's watches.json via gh(1)
// so ticket alerts never require editing GitHub Actions by hand
// ---------------------------------------------------------------------------

const SIREN_REPO = "nitrimandylis/siren";

type SirenWatch = { title: string; imax?: boolean; cinema?: string; from?: string };

async function gh(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null; // gh not installed
  }
}

async function sirenFetch(): Promise<{ watches: SirenWatch[]; sha: string } | null> {
  const out = await gh(["api", `repos/${SIREN_REPO}/contents/watches.json`]);
  if (!out) return null;
  const j = JSON.parse(out);
  return {
    watches: JSON.parse(Buffer.from(j.content, "base64").toString("utf-8")),
    sha: j.sha,
  };
}

async function sirenPut(watches: SirenWatch[], sha: string, message: string): Promise<boolean> {
  const content = Buffer.from(JSON.stringify(watches, null, 2) + "\n").toString("base64");
  const out = await gh([
    "api", "-X", "PUT", `repos/${SIREN_REPO}/contents/watches.json`,
    "-f", `message=${message}`, "-f", `content=${content}`, "-f", `sha=${sha}`,
  ]);
  return out !== null;
}

/** Add or remove a watch; returns a human message describing what happened. */
async function sirenToggle(title: string, extra: Partial<SirenWatch> = {}): Promise<string> {
  const cur = await sirenFetch();
  if (!cur) return "siren unreachable (is gh authed?)";
  const norm = title.trim().toUpperCase();
  const existing = cur.watches.filter((w) => w.title.toUpperCase() === norm);
  if (existing.length) {
    const rest = cur.watches.filter((w) => w.title.toUpperCase() !== norm);
    return (await sirenPut(rest, cur.sha, `unwatch ${norm}`))
      ? `siren: stopped watching ${norm}`
      : "siren update failed";
  }
  const next = [...cur.watches, { title: norm, ...extra }];
  return (await sirenPut(next, cur.sha, `watch ${norm}`))
    ? `siren: watching ${norm}`
    : "siren update failed";
}

// ---------------------------------------------------------------------------
// Torrent sources — magnets by title from the r/Piracy-trusted indexers:
// Knaben (an aggregator over vetted trackers) for movies/TV, Nyaa for anime.
// A magnet is a content hash, so unlike streaming-site scrapers there's
// nothing to obfuscate or rotate — near-zero maintenance.
// ---------------------------------------------------------------------------

export type Torrent = { title: string; magnet: string; seeders: number; size: string; source: string };

// public trackers appended to hash-only results so the client finds peers
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
];

function magnetFromHash(hash: string, name: string): string {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${tr}`;
}

export function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Parse Knaben's JSON response into torrents. Pure. */
export function parseKnaben(data: any): Torrent[] {
  const hits: any[] = data?.hits ?? [];
  return hits
    .map((h) => ({
      title: h.title ?? "",
      magnet: h.magnetUrl || (h.hash ? magnetFromHash(h.hash, h.title ?? "") : ""),
      seeders: Number(h.seeders) || 0,
      size: humanSize(Number(h.bytes) || 0),
      source: h.tracker ?? "knaben",
    }))
    .filter((t) => t.magnet);
}

/** Parse Nyaa's RSS into torrents. Pure. */
export function parseNyaaRss(xml: string): Torrent[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items
    .map((it) => {
      const title = stripHtml(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const hash = it.match(/<nyaa:infoHash>([\s\S]*?)<\/nyaa:infoHash>/)?.[1]?.trim() ?? "";
      return {
        title,
        magnet: hash ? magnetFromHash(hash, title) : "",
        seeders: Number(it.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1]) || 0,
        size: (it.match(/<nyaa:size>([\s\S]*?)<\/nyaa:size>/)?.[1] ?? "?").trim(),
        source: "nyaa",
      };
    })
    .filter((t) => t.magnet);
}

async function knabenSearch(query: string): Promise<Torrent[]> {
  try {
    const res = await fetch("https://api.knaben.org/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query, order_by: "seeders", order_direction: "desc", size: 50 }),
    });
    if (!res.ok) return [];
    return parseKnaben(await res.json()).sort((a, b) => b.seeders - a.seeders);
  } catch {
    return [];
  }
}

async function nyaaSearch(query: string): Promise<Torrent[]> {
  try {
    const res = await fetch(`https://nyaa.si/?page=rss&c=1_2&f=0&q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    return parseNyaaRss(await res.text()).sort((a, b) => b.seeders - a.seeders);
  } catch {
    return [];
  }
}

/** btih hash from a magnet, for de-duping across sources. */
function magnetHash(magnet: string): string {
  return magnet.match(/btih:([a-z0-9]+)/i)?.[1]?.toLowerCase() ?? magnet;
}

/** Query both indexers and merge by seeders — Knaben covers movies/TV, Nyaa
 *  covers anime, so no content classifier is needed. Highest-seeded first. */
async function resolveTorrents(title: string, year: number): Promise<Torrent[]> {
  const [movies, anime] = await Promise.all([
    knabenSearch(year ? `${title} ${year}` : title),
    nyaaSearch(title),
  ]);
  const seen = new Set<string>();
  return [...movies, ...anime]
    .filter((t) => {
      const h = magnetHash(t.magnet);
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .sort((a, b) => b.seeders - a.seeders);
}

// ---------------------------------------------------------------------------
// Home tab search — browse any title via IMDB's suggestion API (the same
// keyless endpoint cine already uses), rendered in the existing poster grid.
// ---------------------------------------------------------------------------

const HOME_KINDS = new Set(["movie", "tvSeries", "tvMovie", "tvMiniSeries"]);

/** Build grid-ready Movie objects from IMDB suggestion hits. Pure. */
export function parseSuggestions(d: any[]): Movie[] {
  return (d ?? [])
    .filter((x) => typeof x?.id === "string" && x.id.startsWith("tt") && HOME_KINDS.has(x.qid))
    .map((x) => ({
      id: x.id,
      title: x.l ?? "",
      genre: "",
      pg: "",
      minutes: 0,
      plot: typeof x.s === "string" ? x.s : "",
      url: `https://www.imdb.com/title/${x.id}/`,
      trailer: "",
      poster: x.i?.imageUrl ?? "",
      days: {},
      rating: null,
      votes: 0,
      imdbUrl: `https://www.imdb.com/title/${x.id}/`,
      imdbPlot: "",
      imdbPoster: x.i?.imageUrl ?? "",
      rt: null,
      year: typeof x.y === "number" ? x.y : 0,
    }));
}

async function homeSearch(query: string): Promise<Movie[]> {
  try {
    const q = query.toLowerCase().trim();
    const first = q.replace(/[^a-z0-9]/g, "")[0] ?? "x";
    const res = await fetch(`${IMDB_SUGGEST}/${first}/${encodeURIComponent(q)}.json`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    return parseSuggestions((await res.json()).d ?? []);
  } catch {
    return [];
  }
}

/** Fetch rating/plot/runtime/genre for a Home title by its IMDB id, once. */
async function enrichHome(m: Movie): Promise<void> {
  if (m.enriched) return;
  m.enriched = true;
  try {
    const gql = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        query: `query { title(id: "${m.id}") {
          runtime { seconds }
          ratingsSummary { aggregateRating voteCount }
          plot { plotText { plainText } }
          genres { genres { text } }
        } }`,
      }),
    });
    if (!gql.ok) return;
    const t = (await gql.json()).data?.title;
    if (!t) return;
    m.rating = t.ratingsSummary?.aggregateRating ?? null;
    m.votes = t.ratingsSummary?.voteCount ?? 0;
    m.imdbPlot = t.plot?.plotText?.plainText ?? "";
    if (t.runtime?.seconds) m.minutes = Math.round(t.runtime.seconds / 60);
    m.genre = (t.genres?.genres ?? []).map((g: any) => g.text).join(", ").toLowerCase();
  } catch {
    // leave it showing "?" — same as Village movies with no IMDB match
  }
}

// ---------------------------------------------------------------------------
// Playback — rqbit streams a magnet over HTTP while it downloads, and IINA
// plays that URL (seekable via range requests). rqbit is a system tool cine
// shells out to, like sips/open/gh — not bundled. The server is left running
// after cine exits so playback survives (IINA streams *from* it).
// ---------------------------------------------------------------------------

const RQBIT_ADDR = "127.0.0.1:3030";
const RQBIT_BASE = `http://${RQBIT_ADDR}`;
const RQBIT_DIR = join(CACHE_DIR, "torrents");
const VIDEO_EXT = /\.(mkv|mp4|avi|webm|mov|m4v|ts)$/i;
const SUB_EXT = /\.(srt|ass|ssa|sub|vtt)$/i;

type RqFile = { name?: string; components?: string[]; length?: number };

function fileName(f: RqFile): string {
  return f.name ?? f.components?.join("/") ?? "";
}

/** Index of the largest video file in a torrent, or -1 if none. Pure. */
export function pickVideoFile(files: RqFile[]): number {
  let best = -1;
  let bestLen = -1;
  files.forEach((f, i) => {
    const len = f.length ?? 0;
    if (VIDEO_EXT.test(fileName(f)) && len > bestLen) {
      best = i;
      bestLen = len;
    }
  });
  return best;
}

/** Indices of subtitle files shipped in the torrent, English first, capped.
 *  IINA loads the first as the default track; the rest are selectable. Pure. */
export function pickSubtitles(files: RqFile[]): number[] {
  const isEng = (n: string) => /\b(en|eng|english)\b/i.test(n) || /\.en\./i.test(n);
  return files
    .map((f, i) => ({ i, name: fileName(f) }))
    .filter((x) => SUB_EXT.test(x.name))
    .sort((a, b) => (isEng(b.name) ? 1 : 0) - (isEng(a.name) ? 1 : 0))
    .slice(0, 6)
    .map((x) => x.i);
}

// ---------------------------------------------------------------------------
// External subtitles — for releases that ship none, fetch an English .srt from
// yifysubtitles (keyless, by IMDB id) and attach it. Movies only; TV/anime
// fall back to torrent/embedded subs.
// ---------------------------------------------------------------------------

const SUBS_DIR = join(CACHE_DIR, "subs");
const YIFY_BASE = "https://yifysubtitles.ch";

/** First English subtitle slug on a yifysubtitles movie page. Matches by the
 *  row's language cell, not the slug text, so titles containing "english"
 *  (e.g. The English Patient) don't mismatch. Pure. */
export function parseYifyEnglish(html: string): string | null {
  for (const row of html.split(/<tr\b/i)) {
    if (/sub-lang">\s*English\b/i.test(row)) {
      const href = row.match(/href="\/subtitles\/([^"]+)"/);
      if (href) return href[1];
    }
  }
  return null;
}

/** Download + cache an English .srt for an IMDB id; returns its local path. */
async function fetchExternalSub(imdbId: string): Promise<string | null> {
  if (!/^tt\d+$/.test(imdbId)) return null;
  mkdirSync(SUBS_DIR, { recursive: true });
  const srt = join(SUBS_DIR, `${imdbId}.srt`);
  if (existsSync(srt)) return srt;
  try {
    const page = await fetch(`${YIFY_BASE}/movie-imdb/${imdbId}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!page.ok) return null;
    const slug = parseYifyEnglish(await page.text());
    if (!slug) return null;
    // the zip download rejects hotlinks — the detail page must be the Referer
    const zip = await fetch(`${YIFY_BASE}/subtitle/${slug}.zip`, {
      headers: { "User-Agent": UA, Referer: `${YIFY_BASE}/subtitles/${slug}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!zip.ok) return null;
    const zipPath = join(SUBS_DIR, `${imdbId}.zip`);
    writeFileSync(zipPath, new Uint8Array(await zip.arrayBuffer()));
    const dir = join(SUBS_DIR, imdbId);
    Bun.spawnSync(["unzip", "-o", "-j", zipPath, "-d", dir], { stdout: "ignore", stderr: "ignore" });
    rmSync(zipPath, { force: true });
    const file = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".srt"));
    if (!file) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }
    renameSync(join(dir, file), srt);
    rmSync(dir, { recursive: true, force: true });
    return srt;
  } catch {
    return null;
  }
}

function rqbitInstalled(): boolean {
  return Bun.spawnSync(["which", "rqbit"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function rqbitUp(): Promise<boolean> {
  try {
    return (await fetch(`${RQBIT_BASE}/`)).ok;
  } catch {
    return false;
  }
}

/** Start the rqbit server if it isn't already answering; wait up to ~5s. */
async function ensureRqbit(): Promise<boolean> {
  if (await rqbitUp()) return true;
  mkdirSync(RQBIT_DIR, { recursive: true });
  Bun.spawn(["rqbit", "--http-api-listen-addr", RQBIT_ADDR, "server", "start", RQBIT_DIR], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  for (let i = 0; i < 25; i++) {
    if (await rqbitUp()) return true;
    await Bun.sleep(200);
  }
  return false;
}

/** Add a magnet, return the torrent id + chosen video file index. The POST
 *  blocks while rqbit resolves metadata from peers, so cap it — a dead magnet
 *  would otherwise hang forever. */
async function rqbitAdd(magnet: string): Promise<{ id: number; fileIdx: number; subIdx: number[] } | null> {
  try {
    const res = await fetch(`${RQBIT_BASE}/torrents?overwrite=true`, {
      method: "POST",
      body: magnet,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const files = j.details?.files ?? [];
    const fileIdx = pickVideoFile(files);
    if (fileIdx < 0) return null;
    return { id: j.id, fileIdx, subIdx: pickSubtitles(files) };
  } catch {
    return null;
  }
}

/** Open a video URL in IINA, attaching any subtitle URLs as extra tracks.
 *  Prefer IINA's own `iina` CLI, which actually loads the stream (and can take
 *  mpv options) — `open -a IINA <httpURL>` tends to just foreground the app. */
function openInIina(videoUrl: string, subUrls: string[]) {
  const hasCli = Bun.spawnSync(["which", "iina"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (!hasCli) {
    // fallback can't attach subs, but embedded (MKV) tracks still work
    Bun.spawn(["open", "-a", "IINA", videoUrl], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    return;
  }
  const cmd = ["iina", "--no-stdin"];
  for (const u of subUrls) cmd.push(`--mpv-sub-files-append=${u}`);
  cmd.push(videoUrl);
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

/** Resolve → add → fetch subs → open in IINA. Returns a human status message. */
async function streamMagnet(magnet: string, imdbId: string): Promise<string> {
  if (!rqbitInstalled()) return "rqbit not found — run: brew install rqbit";
  if (!(await ensureRqbit())) return "couldn't start rqbit server";
  const added = await rqbitAdd(magnet);
  if (!added) return "source has no seeds or no video — try another";
  const base = `${RQBIT_BASE}/torrents/${added.id}/stream`;
  const subs = added.subIdx.map((i) => `${base}/${i}`);
  // external English .srt first so IINA loads it as the default track
  const external = await fetchExternalSub(imdbId);
  if (external) subs.unshift(external);
  openInIina(`${base}/${added.fileIdx}`, subs);
  return subs.length
    ? `streaming → IINA (${subs.length} subtitle${subs.length > 1 ? "s" : ""})`
    : "streaming → IINA (embedded subs if any)";
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

type View = "list" | "detail" | "cinemas";

const state = {
  cinemaId: "",
  cinemaName: "",
  movies: [] as Movie[],
  dayList: [] as string[],
  dayIdx: 0,
  sel: 0,
  perRow: 1,
  view: "list" as View,
  showPrices: false,
  cinemaSel: 0,
  status: "",
  flash: "",
  sort: "imdb" as SortKey,
  detailToken: 0,
  posterPaths: new Map<string, string | null>(),
  grid: { scroll: 0, perRow: 1, viewRows: 1, pCols: 16, cellW: 19, cellH: 14 },
  // "out or in" hub: Cinemas (Village) vs Home (stream anything into IINA)
  tab: "cinemas" as "cinemas" | "home",
  homeMovies: [] as Movie[],
  mode: "normal" as "normal" | "search",
  searchBuf: "",
  overlay: null as null | "picker",
  overlayLines: [] as string[],
  picks: [] as Torrent[],
  pickSel: 0,
  pickTitle: "",
  pickImdb: "",
};

/** The movie list for the active tab (Home search results, or Village grid). */
function listMovies(): Movie[] {
  return state.tab === "home" ? state.homeMovies : gridMovies();
}

function out(s: string) {
  process.stdout.write(s);
}

function clearScreen() {
  // wipe text and any kitty images from the previous frame
  out("\x1b[2J\x1b[H" + (kittySupported() ? "\x1b_Ga=d\x1b\\" : ""));
}

function currentDay(): string {
  return state.dayList[state.dayIdx] ?? isoDay(new Date());
}

/** Movies playing on `day`, hiding today's already-started screenings. */
function moviesForDay(day: string): { movie: Movie; times: Showtime[] }[] {
  const today = isoDay(new Date());
  const nowHour = new Date().toTimeString().slice(0, 5);
  const rows: { movie: Movie; times: Showtime[] }[] = [];
  for (const movie of state.movies) {
    let times = movie.days[day] ?? [];
    if (day === today) times = times.filter((t) => t.hour >= nowHour);
    if (times.length) rows.push({ movie, times });
  }
  return rows;
}

/** All movies with at least one upcoming screening (grid order = rating desc). */
function gridMovies(): Movie[] {
  const today = isoDay(new Date());
  return state.movies.filter((m) => Object.keys(m.days).some((d) => d >= today));
}

function computeDayList() {
  const today = isoDay(new Date());
  const days = new Set<string>();
  for (const m of state.movies) for (const d of Object.keys(m.days)) if (d >= today) days.add(d);
  state.dayList = [...days].sort();
  if (state.dayIdx >= state.dayList.length) state.dayIdx = 0;
}

export const SORTS = ["imdb", "critics", "audience", "runtime"] as const;
export type SortKey = (typeof SORTS)[number];
const SORT_LABELS: Record<SortKey, string> = {
  imdb: "IMDB",
  critics: "Tomatometer",
  audience: "Popcornmeter",
  runtime: "runtime",
};

/** Sort value for a movie under a given key — higher first (runtime: shortest first). */
export function sortValue(m: Movie, key: SortKey): number {
  if (key === "imdb") return m.rating ?? -1;
  if (key === "critics") return m.rt?.critic ?? -1;
  if (key === "audience") return m.rt?.audience ?? -1;
  return -m.minutes;
}

function sortMovies() {
  state.movies.sort((a, b) => sortValue(b, state.sort) - sortValue(a, state.sort));
}

function renderStatus(msg: string) {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  out(`\x1b[${Math.floor(rows / 2)};1H` + center(`${A.cyan}${msg}${A.reset}`, cols));
}

function tabBar(): string {
  const chip = (name: string, active: boolean) =>
    active ? `${A.inv}${A.bold} ${name} ${A.reset}` : `${A.grey} ${name} ${A.reset}`;
  return `${chip("Cinemas", state.tab === "cinemas")}${chip("Home", state.tab === "home")}`;
}

function header(cols: number): string {
  const ctx =
    state.tab === "cinemas"
      ? state.cinemaName
      : state.homeMovies.length
        ? "search results"
        : "press / to search";
  const left = ` ${A.bold}${A.cyan}CINE${A.reset} ${tabBar()}  ${A.bold}${ctx}${A.reset}`;
  const right = state.flash
    ? `${A.yellow}${state.flash}${A.reset}`
    : state.tab === "cinemas"
      ? `${A.grey}${gridMovies().length} movies · sorted by ${SORT_LABELS[state.sort]}${A.reset}`
      : `${A.grey}${state.homeMovies.length} results · ⇥ switch tab${A.reset}`;
  const pad = Math.max(1, cols - visLen(left) - visLen(right) - 2);
  return left + " ".repeat(pad) + right + "\n" + A.grey + "─".repeat(cols) + A.reset + "\n";
}

const GRID_POSTER_ROWS = 11;

/** Screen position of a grid cell, or null if it's outside the visible window. */
function cellPos(idx: number): { y: number; x: number } | null {
  const g = state.grid;
  const rel = idx - g.scroll * g.perRow;
  if (rel < 0 || rel >= g.viewRows * g.perRow) return null;
  return { y: 3 + Math.floor(rel / g.perRow) * g.cellH, x: 2 + (rel % g.perRow) * g.cellW };
}

/** Positioned title + rating lines for one grid cell (text only, no poster). */
function cellText(idx: number, movie: Movie, selected: boolean): string {
  const pos = cellPos(idx);
  if (!pos) return "";
  const pCols = state.grid.pCols;
  const titleRaw = truncate(movie.title, pCols);
  const titlePad = titleRaw + " ".repeat(Math.max(0, pCols - visLen(titleRaw)));
  const title = selected ? `${A.inv}${A.bold}${titlePad}${A.reset}` : `${A.bold}${titlePad}${A.reset}`;
  const marker = selected ? `${A.cyan}${A.bold}▸ ${A.reset}` : "  ";
  return (
    `\x1b[${pos.y + GRID_POSTER_ROWS};${pos.x}H${title}` +
    `\x1b[${pos.y + GRID_POSTER_ROWS + 1};${pos.x}H${marker}${ratingStr(movie)}${rtGridStr(movie)} ${A.grey}${movie.minutes}′${A.reset}`
  );
}

function renderList() {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  let buf = header(cols);

  const list = listMovies();
  if (state.sel >= list.length) state.sel = Math.max(0, list.length - 1);
  if (!list.length) {
    const msg = state.tab === "home" ? "Press / to search, then ⏎ to play." : "No upcoming screenings.";
    buf += "\n" + center(`${A.dim}${msg}${A.reset}`, cols);
  }

  const pCols = posterCellCols(null, GRID_POSTER_ROWS);
  const cellW = pCols + 3; // poster + gap
  const cellH = GRID_POSTER_ROWS + 3; // poster + title + meta + gap
  const perRow = Math.max(1, Math.floor((cols - 2) / cellW));
  state.perRow = perRow;
  const viewRows = Math.max(1, Math.floor((rows - 4) / cellH));
  const totalRows = Math.ceil(list.length / perRow);
  const selRow = Math.floor(state.sel / perRow);
  // keep the current window unless the selection left it
  let scroll = Math.min(Math.max(state.grid.scroll, selRow - viewRows + 1), selRow);
  scroll = Math.max(0, Math.min(scroll, Math.max(0, totalRows - viewRows)));
  state.grid = { scroll, perRow, viewRows, pCols, cellW, cellH };

  const useKitty = kittySupported();
  const posters: { png: string; y: number; x: number }[] = [];

  for (let i = 0; i < viewRows * perRow; i++) {
    const idx = scroll * perRow + i;
    const movie = list[idx];
    if (!movie) break;
    const pos = cellPos(idx)!;
    const png = state.posterPaths.get(movie.id) ?? null;

    if (png && useKitty) {
      posters.push({ png: gridThumbPath(png), y: pos.y, x: pos.x });
    } else if (png) {
      posterHalfblockLines(png, GRID_POSTER_ROWS).forEach((line, li) => {
        buf += `\x1b[${pos.y + li};${pos.x}H${line}`;
      });
    } else {
      buf += `\x1b[${pos.y + Math.floor(GRID_POSTER_ROWS / 2)};${pos.x}H${A.grey}${center("(no poster)", pCols)}${A.reset}`;
    }
    buf += cellText(idx, movie, idx === state.sel);
  }

  const homeHints = ` ⇥ tab · ↑↓←→ move · ⏎ details · / search · p play · q quit`;
  const cineHints = ` ⇥ tab · ↑↓←→ move · ⏎ details · s sort · w watch · t trailer · b book · p prices · c cinema · r refresh · q quit`;
  const bottom =
    state.mode === "search"
      ? `${A.cyan} /${state.searchBuf}${A.reset}${A.grey}▏  ⏎ search · esc cancel${A.reset}`
      : `${A.grey}${truncate(state.tab === "home" ? homeHints : cineHints, cols - 1)}${A.reset}`;
  buf += `\x1b[${rows};1H${bottom}`;
  out(buf);

  for (const p of posters) drawPoster(p.png, p.y, p.x, GRID_POSTER_ROWS, state.grid.pCols);

  if (state.showPrices) renderPrices(cols, rows);
  if (state.overlay) renderOverlay(cols, rows);
}

/** Centered box drawn over the grid (source picker). */
function renderOverlay(cols: number, rows: number) {
  const lines = state.overlayLines;
  const innerW = Math.min(cols - 6, Math.max(24, ...lines.map(visLen)));
  const w = innerW + 4;
  const top = Math.max(2, Math.floor((rows - lines.length - 2) / 2));
  const left = Math.max(1, Math.floor((cols - w) / 2));
  const bar = "─".repeat(w - 2);
  out(`\x1b[${top};${left}H${A.cyan}┌${bar}┐${A.reset}`);
  lines.forEach((l, i) => {
    const t = truncate(l, innerW);
    const pad = " ".repeat(Math.max(0, innerW - visLen(t)));
    out(`\x1b[${top + 1 + i};${left}H${A.cyan}│${A.reset} ${t}${pad} ${A.cyan}│${A.reset}`);
  });
  out(`\x1b[${top + 1 + lines.length};${left}H${A.cyan}└${bar}┘${A.reset}`);
}

/** Move the grid selection, repainting only text when the window doesn't scroll. */
function moveSelection(newSel: number) {
  const list = listMovies();
  const clamped = Math.max(0, Math.min(list.length - 1, newSel));
  if (clamped === state.sel) return;
  const g = state.grid;
  const selRow = Math.floor(clamped / g.perRow);
  const stays = selRow >= g.scroll && selRow < g.scroll + g.viewRows;
  const old = state.sel;
  state.sel = clamped;
  if (stays) {
    out(cellText(old, list[old], false) + cellText(clamped, list[clamped], true));
  } else {
    renderList(); // window moved — full redraw (posters re-emit)
  }
}

function renderPrices(cols: number, rows: number) {
  const top = Math.max(2, Math.floor((rows - PRICE_TABLE.length) / 2));
  const left = Math.max(1, Math.floor((cols - PRICE_TABLE[0].length) / 2));
  PRICE_TABLE.forEach((line, i) => {
    out(`\x1b[${top + i};${left}H${A.green}${line}${A.reset}`);
  });
}

async function renderDetail() {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const m = listMovies()[state.sel];
  if (!m) {
    state.view = "list";
    return renderList();
  }
  const token = ++state.detailToken;

  // Home titles fetch rating/plot/runtime lazily, then repaint if still shown
  if (state.tab === "home" && !m.enriched) {
    enrichHome(m).then(() => {
      if (token === state.detailToken && state.view === "detail") renderDetail();
    });
  }

  const posterRows = Math.min(rows - 8, 18);
  let textCol = 3;
  const useKitty = kittySupported();
  // reserve poster space up front so text doesn't jump when the image lands
  const posterCols = Math.max(1, Math.round(posterRows * 2 * (712 / 980)));
  textCol = posterCols + 6;

  let buf = header(cols);
  const textW = Math.max(20, cols - textCol - 2);
  const lines: string[] = [];
  lines.push(`${A.bold}${m.title}${A.reset}  ${ratingStr(m)}${m.votes ? ` ${A.grey}(${m.votes.toLocaleString("en")} votes)${A.reset}` : ""}`);
  const meta = [state.tab === "home" && m.year ? String(m.year) : "", m.minutes ? `${m.minutes}′` : "", m.genre, m.pg]
    .filter(Boolean)
    .join(" · ");
  if (meta) lines.push(`${A.grey}${meta}${A.reset}`);
  const rtLines = rtBlock(m, textW);
  if (rtLines.length) {
    lines.push("");
    lines.push(...rtLines);
  }
  lines.push("");
  const plot = m.imdbPlot || m.plot;
  if (plot) {
    lines.push(...wrap(plot, textW).map((l) => `${A.dim}${l}${A.reset}`));
    lines.push("");
  }
  if (state.tab === "home") {
    lines.push(`${A.cyan}${A.bold}▶ p${A.reset}  ${A.grey}stream to IINA${A.reset}`);
    lines.push("");
  } else {
    const today = isoDay(new Date());
    for (const day of state.dayList) {
      const times = m.days[day];
      if (!times?.length) continue;
      lines.push(`${A.bold}${fmtDay(day, today)}${A.reset}  ` + times.map(showtimeStr).join("  "));
    }
    lines.push("");
  }
  if (m.imdbUrl) lines.push(`${A.grey}imdb     ${m.imdbUrl}${A.reset}`);
  if (m.rt?.url) lines.push(`${A.grey}rotten   ${m.rt.url}${A.reset}`);
  if (m.trailer) lines.push(`${A.grey}trailer  ${m.trailer}${A.reset}`);
  if (m.url && state.tab === "cinemas") lines.push(`${A.grey}book     ${m.url}${A.reset}`);

  lines.slice(0, rows - 5).forEach((l, i) => {
    buf += `\x1b[${4 + i};${textCol}H${truncate(l, textW)}`;
  });
  const hints =
    state.tab === "home" ? ` esc back · p play · b imdb · q quit` : ` esc back · t trailer · b book · q quit`;
  buf += `\x1b[${rows};1H${A.grey}${hints}${A.reset}`;
  out(buf);

  // picker is modal — draw it over the detail and skip the poster underneath
  if (state.overlay) return renderOverlay(cols, rows);

  const png = state.posterPaths.get(m.id) ?? (await ensurePoster(m));
  if (token !== state.detailToken || state.view !== "detail") return;
  if (png) {
    if (useKitty) {
      drawPoster(png, 4, 3, posterRows, posterCellCols(png, posterRows));
    } else {
      posterHalfblockLines(png, posterRows).forEach((line, i) => {
        out(`\x1b[${4 + i};3H${line}`);
      });
    }
  } else {
    out(`\x1b[5;5H${A.grey}(no poster)${A.reset}`);
  }
}

function renderCinemas() {
  clearScreen();
  const cols = process.stdout.columns || 80;
  let buf = ` ${A.bold}${A.cyan}CINE${A.reset}  ${A.bold}Select a cinema${A.reset}\n`;
  buf += A.grey + "─".repeat(cols) + A.reset + "\n\n";
  Object.entries(CINEMAS).forEach(([id, name], i) => {
    const selected = i === state.cinemaSel;
    const mark = selected ? `${A.cyan}${A.bold}▌ ` : "  ";
    buf += ` ${mark}${selected ? A.bold : ""}${name}${A.reset}  ${A.grey}${id}${A.reset}\n`;
  });
  buf += `\n ${A.grey}↑↓ move · ⏎ select · esc cancel${A.reset}`;
  out(buf);
}

function render() {
  if (state.view === "list") renderList();
  else if (state.view === "detail") renderDetail();
  else renderCinemas();
}

async function loadData(cinemaId: string, force: boolean) {
  state.cinemaId = cinemaId;
  const cached = force ? null : loadCache(cinemaId);
  if (cached) {
    state.cinemaName = cached.cinemaName;
    state.movies = cached.movies;
  } else {
    renderStatus(`Fetching Village Cinemas…`);
    const { cinemaName, movies } = await fetchVillage(cinemaId);
    state.cinemaName = cinemaName;
    renderStatus(`Looking up IMDB ratings… 0/${movies.length}`);
    await enrich(movies, (done, total) => renderStatus(`Looking up IMDB ratings… ${done}/${total}`));
    state.movies = movies;
    sortMovies();
    saveCache({
      v: CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      cinemaId,
      cinemaName,
      movies,
    });
  }
  sortMovies();
  computeDayList();
  state.sel = 0;

  // prefetch posters so the grid appears fully drawn (cached files return instantly)
  const list = gridMovies();
  let done = 0;
  renderStatus(`Fetching posters… 0/${list.length}`);
  await Promise.all(
    list.map((m) =>
      ensurePoster(m).then((png) => {
        state.posterPaths.set(m.id, png);
        renderStatus(`Fetching posters… ${++done}/${list.length}`);
      }),
    ),
  );
}

function openUrl(url: string) {
  if (url) Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
}

function cleanupTerminal() {
  process.stdin.setRawMode?.(false);
  out("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
}

function quit(): never {
  cleanupTerminal();
  process.exit(0);
}

/** Fetch posters for Home results in the background, repainting as they land. */
function prefetchHomePosters() {
  for (const m of state.homeMovies) {
    if (state.posterPaths.has(m.id)) continue;
    ensurePoster(m).then((png) => {
      state.posterPaths.set(m.id, png);
      if (state.tab === "home" && state.view === "list") renderList();
    });
  }
}

/** One picker row: marker · seeders (▲) · size · source · title. */
function pickerRow(t: Torrent, selected: boolean): string {
  const mark = selected ? `${A.cyan}${A.bold}▸ ${A.reset}` : "  ";
  const seeds = `${A.green}${String(t.seeders).padStart(5)}▲${A.reset}`;
  const size = `${A.grey}${t.size.padStart(9)}${A.reset}`;
  const src = `${A.grey}${truncate(t.source, 12).padEnd(12)}${A.reset}`;
  const name = selected ? `${A.bold}${truncate(t.title, 36)}${A.reset}` : truncate(t.title, 36);
  return `${mark}${seeds} ${size}  ${src} ${name}`;
}

/** Picker lines with a header and a scroll window that fits the terminal, so
 *  the list can hold many sources without overflowing the screen. */
function buildPickerLines(): string[] {
  const capacity = Math.max(4, (process.stdout.rows || 24) - 9); // rows for entries
  const total = state.picks.length;
  const start =
    total <= capacity ? 0 : Math.min(Math.max(0, state.pickSel - Math.floor(capacity / 2)), total - capacity);
  const shown = state.picks.slice(start, start + capacity);
  const counter = total > capacity ? `  ·  ${start + 1}–${start + shown.length}/${total}` : "";
  return [
    `${A.bold}${truncate(state.pickTitle, 46)}${A.reset}`,
    `${A.grey}   seeders      size  source       title${A.reset}`,
    ...shown.map((t, li) => pickerRow(t, start + li === state.pickSel)),
    `${A.grey}↑↓ choose · ⏎ play · esc cancel${counter}${A.reset}`,
  ];
}

/** Resolve sources → picker overlay (highest-seeded first, top 8). */
async function startStream(m: Movie) {
  state.flash = "finding sources…";
  render();
  const torrents = await resolveTorrents(m.title, m.year ?? 0);
  state.flash = "";
  if (!torrents.length) {
    state.flash = "no torrent found for that title";
    return render();
  }
  state.picks = torrents.slice(0, 25);
  state.pickSel = 0;
  state.pickTitle = m.title;
  state.pickImdb = m.id;
  state.overlay = "picker";
  state.overlayLines = buildPickerLines();
  render();
}

async function playPick(t: Torrent) {
  state.flash = "starting stream + subtitles…";
  render();
  state.flash = await streamMagnet(t.magnet, state.pickImdb);
  render();
}

async function handleKey(key: string) {
  // the source picker swallows keys while it's open
  if (state.overlay === "picker") {
    if (key === "\x1b[A" || key === "k") state.pickSel = Math.max(0, state.pickSel - 1);
    else if (key === "\x1b[B" || key === "j") state.pickSel = Math.min(state.picks.length - 1, state.pickSel + 1);
    else if (key === "\r" || key === "\n") {
      const t = state.picks[state.pickSel];
      state.overlay = null;
      return t ? playPick(t) : render();
    } else if (key === "\x1b" || key === "q") {
      state.overlay = null;
      return render();
    } else return;
    state.overlayLines = buildPickerLines();
    return render();
  }

  // search input mode (Home): typed keys build the query — note "q" types here,
  // it doesn't quit, so this must come before the quit check below
  if (state.mode === "search") {
    if (key === "\r" || key === "\n") {
      state.mode = "normal";
      const q = state.searchBuf.trim();
      if (q) {
        state.flash = "searching…";
        render();
        state.homeMovies = await homeSearch(q);
        state.sel = 0;
        prefetchHomePosters();
        state.flash = state.homeMovies.length ? "" : "no results";
      }
      return render();
    }
    if (key === "\x1b") {
      state.mode = "normal";
      return render();
    }
    if (key === "\x7f" || key === "\b") {
      state.searchBuf = state.searchBuf.slice(0, -1);
      return render();
    }
    if (key.length === 1 && key >= " ") {
      state.searchBuf += key;
      return render();
    }
    return;
  }

  const list = listMovies();
  const selMovie = list[state.sel];
  state.flash = ""; // any keypress clears the last flash message

  if (key === "\x03" || key === "q") quit();

  // Tab switches Cinemas ⇄ Home
  if (key === "\t") {
    state.tab = state.tab === "cinemas" ? "home" : "cinemas";
    state.view = "list";
    state.sel = 0;
    state.showPrices = false;
    return render();
  }
  if (key === "/" && state.tab === "home") {
    state.mode = "search";
    state.searchBuf = "";
    return render();
  }

  if (state.view === "cinemas") {
    const n = Object.keys(CINEMAS).length;
    if (key === "\x1b[A") state.cinemaSel = (state.cinemaSel + n - 1) % n;
    else if (key === "\x1b[B") state.cinemaSel = (state.cinemaSel + 1) % n;
    else if (key === "\r") {
      const id = Object.keys(CINEMAS)[state.cinemaSel];
      saveConfig({ ...loadConfig(), cinema: id });
      state.view = "list";
      await loadData(id, false);
    } else if (key === "\x1b") state.view = "list";
    return render();
  }

  if (key === "\x1b") {
    state.view = state.view === "detail" ? "list" : state.view;
    state.showPrices = false;
    return render();
  }
  if (key === "t") return openUrl(selMovie?.trailer ?? "");
  if (key === "b") return openUrl(selMovie?.url ?? "");
  if (key === "p") {
    if (state.tab === "home") return selMovie ? startStream(selMovie) : undefined;
    state.showPrices = !state.showPrices;
    return render();
  }
  if (key === "s" && state.tab === "cinemas") {
    state.sort = SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length];
    saveConfig({ ...loadConfig(), sort: state.sort });
    sortMovies();
    state.sel = 0;
    return render();
  }
  if (key === "w" && selMovie && state.tab === "cinemas") {
    state.flash = "siren: syncing…";
    render();
    state.flash = await sirenToggle(selMovie.title);
    return render();
  }
  if (key === "c" && state.tab === "cinemas") {
    state.view = "cinemas";
    state.cinemaSel = Math.max(0, Object.keys(CINEMAS).indexOf(state.cinemaId));
    return render();
  }
  if (key === "r" && state.tab === "cinemas") {
    state.view = "list";
    await loadData(state.cinemaId, true);
    return render();
  }
  const last = Math.max(0, list.length - 1);
  const inList = state.view === "list";
  const step = inList ? state.perRow : 1; // detail: ↑↓ step one movie
  const move = (target: number) => {
    if (inList) return moveSelection(target);
    state.sel = Math.max(0, Math.min(last, target));
    return render();
  };
  if (key === "\x1b[C") return move(state.sel + 1);
  if (key === "\x1b[D") return move(state.sel - 1);
  if (key === "\x1b[A") return move(state.sel - step);
  if (key === "\x1b[B") return move(state.sel + step);
  if (key === "\r") {
    if (state.view === "list" && selMovie) state.view = "detail";
    return render();
  }
}

// ---------------------------------------------------------------------------
// Plain (piped) output
// ---------------------------------------------------------------------------

function printPlain(day: string) {
  const entries = moviesForDay(day);
  console.log(`${state.cinemaName} — ${fmtDay(day, isoDay(new Date()))}\n`);
  if (!entries.length) return console.log("No screenings.");
  for (const { movie, times } of entries) {
    const rating = movie.rating === null ? "?" : movie.rating.toFixed(1);
    const rt = movie.rt?.critic != null ? ` RT ${movie.rt.critic}%` : "";
    console.log(`${movie.title} (${rating}${rt}) ${movie.minutes}′`);
    console.log(`  ${times.map((t) => t.hour + (t.soldout ? "(soldout)" : "")).join("  ")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Resolve "-d 25/07" to an ISO day in the current list (or null). */
export function resolveDate(arg: string, dayList: string[]): string | null {
  const m = arg.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const suffix = `-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return dayList.find((d) => d.endsWith(suffix)) ?? null;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cinema: { type: "string", short: "c" },
      date: { type: "string", short: "d" },
      imax: { type: "boolean" },
      list: { type: "boolean" },
      clear: { type: "boolean" },
      "no-cache": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) return console.log(HELP);

  // siren subcommands: cine watch [title] [--imax] [-c id], cine unwatch <title>
  const [cmd, ...args] = positionals;
  if (cmd === "watch" || cmd === "unwatch") {
    const title = args.join(" ").trim();
    if (!title) {
      const cur = await sirenFetch();
      if (!cur) return console.error("siren unreachable (is gh authed?)");
      if (!cur.watches.length) return console.log("no active watches");
      for (const w of cur.watches) {
        const extras = [w.imax && "imax", w.cinema && CINEMAS[w.cinema], w.from && `from ${w.from}`]
          .filter(Boolean)
          .join(", ");
        console.log(`${w.title}${extras ? `  (${extras})` : ""}`);
      }
      return;
    }
    if (cmd === "unwatch") return console.log(await sirenToggle(title));
    const cur = await sirenFetch();
    if (cur?.watches.some((w) => w.title.toUpperCase() === title.toUpperCase()))
      return console.log(`already watching ${title.toUpperCase()}`);
    const extra: { imax?: boolean; cinema?: string } = {};
    if (values.imax) extra.imax = true;
    if (values.cinema) extra.cinema = values.cinema;
    return console.log(await sirenToggle(title, extra));
  }
  if (values.list) {
    for (const [id, name] of Object.entries(CINEMAS)) console.log(`${id}  ${name}`);
    return;
  }

  const config = loadConfig();
  if (config.sort && SORTS.includes(config.sort)) state.sort = config.sort;
  let cinemaId = values.cinema ?? config.cinema ?? "";
  if (cinemaId && !CINEMAS[cinemaId]) {
    console.error(`Unknown cinema "${cinemaId}". Use --list to see IDs.`);
    process.exit(1);
  }

  if (values.clear && cinemaId) rmSync(cachePath(cinemaId), { force: true });

  const isTty = process.stdout.isTTY && process.stdin.isTTY;

  if (!isTty) {
    if (!cinemaId) {
      console.error("No cinema configured. Run `cine` in a terminal once, or pass -c <id>.");
      process.exit(1);
    }
    await loadDataPlain(cinemaId, Boolean(values["no-cache"]));
    const day = values.date ? resolveDate(values.date, state.dayList) : null;
    return printPlain(day ?? currentDay());
  }

  // --- TUI ---
  out("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
  process.on("exit", cleanupTerminal);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  if (!cinemaId) {
    state.view = "cinemas";
    renderCinemas();
  } else {
    await loadData(cinemaId, Boolean(values["no-cache"]));
    if (values.date) {
      const d = resolveDate(values.date, state.dayList);
      if (d) state.dayIdx = state.dayList.indexOf(d);
    }
    render();
  }

  process.stdout.on("resize", render);
  process.stdin.on("data", (b) => {
    handleKey(b.toString()).catch((e) => {
      cleanupTerminal();
      console.error(e);
      process.exit(1);
    });
  });
}

/** Data load without TUI status frames, for piped output. */
async function loadDataPlain(cinemaId: string, force: boolean) {
  state.cinemaId = cinemaId;
  const cached = force ? null : loadCache(cinemaId);
  if (cached) {
    state.cinemaName = cached.cinemaName;
    state.movies = cached.movies;
  } else {
    const { cinemaName, movies } = await fetchVillage(cinemaId);
    state.cinemaName = cinemaName;
    await enrich(movies, () => {});
    state.movies = movies;
    saveCache({ v: CACHE_VERSION, cachedAt: new Date().toISOString(), cinemaId, cinemaName, movies });
  }
  sortMovies();
  computeDayList();
}

if (import.meta.main) {
  main().catch((e) => {
    cleanupTerminal();
    console.error(`cine: ${e.message ?? e}`);
    process.exit(1);
  });
}
