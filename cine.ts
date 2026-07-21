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
const HISTORY_PATH = join(homedir(), ".config", "cine", "history.json");
const TREND_PATH = join(CACHE_DIR, "trending.json");
const CACHE_TTL_HOURS = 12;

const HELP = `cine — Village Cinemas (Greece) showtimes with IMDB ratings and posters

usage:
  cine                 interactive TUI (remembers your cinema)
  cine -c 21           jump straight to a cinema by ID
  cine -d 25/07        filter piped output to a date (DD/MM)
  cine --list          list cinema IDs and exit
  cine --clear         clear the cache for your cinema, then fetch fresh
  cine --no-cache      ignore the cache, always fetch fresh

stream (skip the TUI — fzf a title, fzf a source, play in IINA):
  cine stream <title>            e.g. cine stream dune
  cine stream <title> --dub      prefer dual-audio anime torrents (default: sub)
                                 needs fzf, rqbit, and IINA installed

siren (ticket alerts via github.com/nitrimandylis/siren):
  cine watch                     list active watches
  cine watch <title> [--imax]    get pinged when tickets open (-c limits cinema)
  cine unwatch <title>           stop watching

keys (inside the TUI):
  ⇥ switch tab (Village / Stream)   ↑/↓/←/→ move   ⏎ details   q quit
  Village: s sort · w watch · t trailer · b book · p prices · c cinema · r refresh
  Stream:  opens on recently-played + trending · / live search · p play (→ IINA)
           TV/anime: ⏎ a series → seasons (←→) & episodes (↑↓); ⏎ play · n next
           watched episodes show ✓ and resume jumps to the next unwatched one

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
  kind?: string; // IMDB qid: "movie" | "tvSeries" | "tvMiniSeries" | ...
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
// Home landing data — a local play history (recently played + per-series
// resume point) and a 12h cache of IMDB's most-popular charts (trending).
// ---------------------------------------------------------------------------

const HISTORY_CAP = 30;

type HistoryEntry = {
  id: string;
  title: string;
  poster: string;
  kind: string;
  year?: number;
  lastSeason?: number;
  lastEpisode?: number;
  ts: number;
};

function loadHistory(): HistoryEntry[] {
  try {
    const h = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function saveHistory(list: HistoryEntry[]) {
  mkdirSync(join(homedir(), ".config", "cine"), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(list.slice(0, HISTORY_CAP)));
}

/** Record a stream launch: move the title to the front, update its resume
 *  point (season/episode) if it's a series. Deduped by IMDB id. */
function recordPlay(m: Movie | null, ep: { season: number; number: number } | null) {
  if (!m) return;
  const list = loadHistory().filter((e) => e.id !== m.id);
  list.unshift({
    id: m.id,
    title: m.title,
    poster: m.poster || m.imdbPoster || "",
    kind: m.kind ?? "",
    year: m.year,
    lastSeason: ep?.season,
    lastEpisode: ep?.number,
    ts: Date.now(),
  });
  saveHistory(list);
}

/** The last episode watched for a series id, or null. */
function lastWatched(id: string): { season: number; number: number } | null {
  const e = loadHistory().find((h) => h.id === id);
  return e && e.lastEpisode != null ? { season: e.lastSeason ?? 1, number: e.lastEpisode } : null;
}

/** A history entry as a grid-ready Movie (poster/title/rating placeholders). */
function historyToMovie(e: HistoryEntry): Movie {
  return {
    id: e.id, title: e.title, genre: "", pg: "", minutes: 0, plot: "",
    url: `https://www.imdb.com/title/${e.id}/`, trailer: "",
    poster: e.poster, days: {}, rating: null, votes: 0,
    imdbUrl: `https://www.imdb.com/title/${e.id}/`, imdbPlot: "", imdbPoster: e.poster,
    rt: null, year: e.year, kind: e.kind,
  };
}

/** Grid-ready Movies from an IMDB advancedTitleSearch (trending) response. Pure. */
export function parseTrending(j: any): Movie[] {
  const edges = j?.data?.advancedTitleSearch?.edges ?? [];
  return edges
    .map((e: any) => e.node?.title)
    .filter((t: any) => typeof t?.id === "string" && t.id.startsWith("tt"))
    .map((t: any) => {
      const url = t.primaryImage?.url ?? "";
      return {
        id: t.id, title: t.titleText?.text ?? "", genre: "", pg: "", minutes: 0, plot: "",
        url: `https://www.imdb.com/title/${t.id}/`, trailer: "",
        poster: url, days: {}, rating: t.ratingsSummary?.aggregateRating ?? null, votes: 0,
        imdbUrl: `https://www.imdb.com/title/${t.id}/`, imdbPlot: "", imdbPoster: url,
        rt: null, year: t.releaseYear?.year ?? undefined,
        kind: t.titleType?.id ?? "",
      } as Movie;
    });
}

/** Most-popular movies or TV from IMDB's GraphQL (keyless), sorted by daily
 *  popularity — the closest thing to a "trending now" list. */
async function fetchTrending(titleType: "movie" | "tvSeries"): Promise<Movie[]> {
  try {
    const query = `query { advancedTitleSearch(first: 24, sort: {sortBy: POPULARITY, sortOrder: ASC}, constraints: {titleTypeConstraint: {anyTitleTypeIds: ["${titleType}"]}}) { edges { node { title { id titleText { text } releaseYear { year } titleType { id } ratingsSummary { aggregateRating } primaryImage { url } } } } } }`;
    const r = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) return [];
    return parseTrending(await r.json());
  } catch {
    return [];
  }
}

type TrendCache = { cachedAt: string; movies: Movie[]; tv: Movie[] };

function loadTrending(): TrendCache | null {
  try {
    const c: TrendCache = JSON.parse(readFileSync(TREND_PATH, "utf-8"));
    const ageHours = (Date.now() - new Date(c.cachedAt).getTime()) / 3_600_000;
    return ageHours < CACHE_TTL_HOURS ? c : null;
  } catch {
    return null;
  }
}

function saveTrending(movies: Movie[], tv: Movie[]) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(TREND_PATH, JSON.stringify({ cachedAt: new Date().toISOString(), movies, tv }));
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

/** Pull the resolution / HDR / codec / release-source tags out of a raw
 *  torrent name so the picker can show them as tidy columns. Pure. */
export function parseQuality(title: string): { res: string; hdr: string; codec: string; src: string } {
  const res =
    title.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1].toLowerCase() ??
    (/\b(4k|uhd)\b/i.test(title) ? "2160p" : "");
  const hdr = /\b(dolby\s*vision|dv)\b/i.test(title)
    ? "DV"
    : /\bhdr10\+?\b|\bhdr\b/i.test(title)
      ? "HDR"
      : "";
  const codec = /\b(x265|h\.?\s?265|hevc)\b/i.test(title)
    ? "x265"
    : /\b(x264|h\.?\s?264|avc)\b/i.test(title)
      ? "x264"
      : /\bav1\b/i.test(title)
        ? "AV1"
        : "";
  const srcRaw = title.match(/\b(REMUX|BluRay|BDRip|BRRip|WEB[- .]?DL|WEBRip|WEB|HDTV|DVDRip|HDCAM|CAM)\b/i)?.[1] ?? "";
  const src = /^web[- .]?dl$/i.test(srcRaw) ? "WEB-DL" : /^web$/i.test(srcRaw) ? "WEB" : srcRaw;
  return { res, hdr, codec, src };
}

/** The quality tags of a torrent as one short string ("2160p HDR x265"). */
export function qualityLabel(title: string): string {
  const q = parseQuality(title);
  return [q.res, q.hdr, q.codec, q.src].filter(Boolean).join(" ") || "—";
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

/** Is `name` a torrent for show `title` (given its SxxEyy / year `tag`)? The
 *  release title — the part before the tag — must BE the show name, optionally
 *  with trailing words dropped (releases write "House", not "House M.D.") and a
 *  trailing year ignored. Extra leading words mean a different, longer show, so
 *  "House of the Dragon" and "Spartacus House of Ashur" are rejected for "House".
 *  A tag not present in the name isn't judged (kept). Pure. */
export function matchesShow(name: string, title: string, tag: string): boolean {
  const norm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = tag.toLowerCase();
  const i = t ? norm.indexOf(t) : -1;
  if (i < 0) return true;
  const pre = norm.slice(0, i).trim().split(/\s+/).filter(Boolean);
  if (pre.length && /^(19|20)\d\d$/.test(pre[pre.length - 1])) pre.pop(); // drop a year token
  const show = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!pre.length || !show.length) return true;
  if (pre.length > show.length) return false; // extra leading words → different show
  return pre.every((w, k) => w === show[k]); // release title is a prefix of the show name
}

/** Query both indexers and merge by seeders — Knaben covers movies/TV, Nyaa
 *  covers anime, so no content classifier is needed. Each argument may be one
 *  query or several (anime fans out over title/number variants); pass "" to skip
 *  an indexer (Nyaa is skipped for non-anime). All run in parallel and merge,
 *  de-duped by btih. `relevance`, when given, drops results whose title isn't the
 *  searched show (guards generic names like "House"), keeping seeder order; if it
 *  would drop everything it's ignored. Highest-seeded first. */
async function resolveTorrents(
  knaben: string | string[],
  nyaa: string | string[] = knaben,
  relevance?: { title: string; tag: string },
): Promise<Torrent[]> {
  const kq = [...new Set((Array.isArray(knaben) ? knaben : [knaben]).filter(Boolean))];
  const nq = [...new Set((Array.isArray(nyaa) ? nyaa : [nyaa]).filter(Boolean))];
  const results = await Promise.all([...kq.map(knabenSearch), ...nq.map(nyaaSearch)]);
  const seen = new Set<string>();
  const merged = results
    .flat()
    .filter((t) => {
      const h = magnetHash(t.magnet);
      if (seen.has(h)) return false;
      seen.add(h);
      return true;
    })
    .sort((a, b) => b.seeders - a.seeders);
  if (relevance?.title) {
    const kept = merged.filter((t) => matchesShow(t.title, relevance.title, relevance.tag));
    if (kept.length) return kept;
  }
  return merged;
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
      kind: typeof x.qid === "string" ? x.qid : "",
    }));
}

export function isSeries(m: Movie): boolean {
  return m.kind === "tvSeries" || m.kind === "tvMiniSeries";
}

// ---------------------------------------------------------------------------
// TV seasons + episodes (IMDB GraphQL — same keyless endpoint as ratings)
// ---------------------------------------------------------------------------

export type Episode = { season: number; number: number; title: string; rating: number | null };

export function parseSeasons(j: any): number[] {
  const seasons = j?.data?.title?.episodes?.seasons ?? [];
  return seasons
    .map((s: any) => s.number)
    .filter((n: any) => typeof n === "number")
    .sort((a: number, b: number) => a - b);
}

export function parseEpisodes(j: any): Episode[] {
  const edges = j?.data?.title?.episodes?.episodes?.edges ?? [];
  return edges
    .map((e: any) => {
      const n = e.node ?? {};
      const en = n.series?.episodeNumber ?? {};
      return {
        season: en.seasonNumber ?? 0,
        number: en.episodeNumber ?? 0,
        title: n.titleText?.text ?? "",
        rating: n.ratingsSummary?.aggregateRating ?? null,
      };
    })
    .filter((e: Episode) => e.number > 0)
    .sort((a: Episode, b: Episode) => a.number - b.number);
}

async function fetchSeasons(imdbId: string): Promise<number[]> {
  try {
    const r = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ query: `query { title(id: "${imdbId}") { episodes { seasons { number } } } }` }),
    });
    if (!r.ok) return [];
    return parseSeasons(await r.json());
  } catch {
    return [];
  }
}

async function fetchEpisodes(imdbId: string, season: number): Promise<Episode[]> {
  try {
    const r = await fetch(IMDB_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        query: `query { title(id: "${imdbId}") { episodes { episodes(first: 100, filter: {includeSeasons: ["${season}"]}) { edges { node { titleText { text } ratingsSummary { aggregateRating } series { episodeNumber { seasonNumber episodeNumber } } } } } } } }`,
      }),
    });
    if (!r.ok) return [];
    return parseEpisodes(await r.json());
  } catch {
    return [];
  }
}

/** "S02E05" for torrent search. */
function sxxeyy(season: number, ep: number): string {
  return `S${String(season).padStart(2, "0")}E${String(ep).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Anime numbering (AniList — keyless). IMDB numbers anime as SxxEyy, but Nyaa
// releases use the romaji title + per-cour episode number, so anime gets its
// episode list + search terms from AniList instead.
// ---------------------------------------------------------------------------

// english + synonyms feed extra torrent-search title variants (fansubbers name
// releases inconsistently); undefined when absent so the shape stays minimal.
type AnimeInfo = {
  romaji: string;
  episodes: number;
  titles: Record<number, string>;
  english?: string;
  synonyms?: string[];
};

export function parseAnime(j: any): AnimeInfo | null {
  const m = j?.data?.Media;
  if (!m) return null;
  const romaji = m.title?.romaji || m.title?.english || "";
  // AniList leaves `episodes` null while a show is still airing; fall back to
  // however many have aired (nextAiringEpisode is the NEXT, unaired one).
  const aired = typeof m.nextAiringEpisode?.episode === "number" ? m.nextAiringEpisode.episode - 1 : 0;
  const episodes = typeof m.episodes === "number" ? m.episodes : aired;
  // AniList streaming titles look like "Episode 5 - The Fight" — map by number
  const titles: Record<number, string> = {};
  for (const se of m.streamingEpisodes ?? []) {
    const mm = String(se?.title ?? "").match(/Episode\s+(\d+)\s*[-–—:]\s*(.+)/i);
    if (mm) titles[Number(mm[1])] = mm[2].trim();
  }
  if (!romaji || episodes <= 0) return null;
  const english = m.title?.english && m.title.english !== romaji ? m.title.english : undefined;
  const synonyms = Array.isArray(m.synonyms) && m.synonyms.length ? m.synonyms : undefined;
  return { romaji, episodes, titles, english, synonyms };
}

/** Strip everything but letters/digits for tolerant title comparison. Pure. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** AniList `search` fuzzy-matches, so "House" returns the anime "The House".
 *  Only trust the match when the searched title exactly equals (normalized) one
 *  of AniList's own titles — otherwise it's a false positive, not anime. Pure. */
export function animeMatches(a: AnimeInfo, title: string): boolean {
  const want = normKey(title);
  return want !== "" && [a.romaji, a.english ?? "", ...(a.synonyms ?? [])].some((t) => normKey(t) === want);
}

async function fetchAnime(title: string): Promise<AnimeInfo | null> {
  try {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({
        query: `query($q:String){Media(search:$q,type:ANIME){episodes synonyms title{romaji english} nextAiringEpisode{episode} streamingEpisodes{title}}}`,
        variables: { q: title },
      }),
    });
    if (!r.ok) return null;
    const a = parseAnime(await r.json());
    return a && animeMatches(a, title) ? a : null; // reject fuzzy false matches
  } catch {
    return null;
  }
}

// CJK / Thai / Hangul / Cyrillic / Arabic / Hebrew — Nyaa's English-translated
// category names releases in Latin script, so titles in these scripts never hit.
const NON_LATIN = /[Ѐ-ۿ֐-׿฀-๿぀-ヿ㐀-鿿가-힯]/;

/** De-duped, cleaned title variants to search torrents for an anime: romaji +
 *  english + AniList synonyms, season descriptors stripped to match fansub
 *  naming. Non-Latin titles are dropped (0 hits on Nyaa) so the cap spends its
 *  slots on searchable names. More titles = more hits. Pure. */
export function animeTitles(a: AnimeInfo): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [a.romaji, a.english ?? "", ...(a.synonyms ?? [])]) {
    const clean = nyaaTitle(t);
    const key = clean.toLowerCase();
    if (clean && !NON_LATIN.test(clean) && /[a-z]/i.test(clean) && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  }
  return out.slice(0, 4);
}

/** Nyaa search queries for one anime episode: each title × padded-and-unpadded
 *  number (fansubbers differ on zero-padding). `dub` swaps in a "dual audio"
 *  term — a heuristic, since dub torrents aren't tagged consistently. Pure. */
export function animeQueries(titles: string[], epNo: number, dub: boolean): string[] {
  const pad = String(epNo).padStart(2, "0");
  const nums = pad === String(epNo) ? [pad] : [pad, String(epNo)];
  const out: string[] = [];
  for (const t of titles) {
    for (const n of nums) out.push(dub ? `${t} ${n} dual audio` : `${t} ${n}`);
  }
  return out.slice(0, 12);
}

/** Strip season descriptors so the romaji matches Nyaa's fansub naming
 *  ("Sousou no Frieren 2nd Season" → "Sousou no Frieren"). Pure. */
export function nyaaTitle(romaji: string): string {
  return romaji
    .replace(/\b(\d+(?:st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+|cour\s+\d+)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
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

type Video = { idx: number; name: string; length: number };

/** The playable episodes/movie in a torrent: video files over 50 MB (drops
 *  samples/extras), naturally sorted so E02 precedes E10. One entry = a movie
 *  or single episode; many = a season pack / anime batch. Pure. */
export function selectVideos(files: RqFile[]): Video[] {
  return files
    .map((f, i) => ({ idx: i, name: fileName(f), length: f.length ?? 0 }))
    .filter((v) => VIDEO_EXT.test(v.name) && v.length >= 50_000_000 && !/sample/i.test(v.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
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
type Pack = { id: number; videos: Video[]; files: RqFile[] };

/** Add a magnet, return the torrent id + its playable videos + all files. The
 *  POST blocks while rqbit resolves metadata from peers, so cap it. */
async function rqbitAddFiles(magnet: string): Promise<Pack | null> {
  try {
    const res = await fetch(`${RQBIT_BASE}/torrents?overwrite=true`, {
      method: "POST",
      body: magnet,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const files = j.details?.files ?? [];
    const videos = selectVideos(files);
    if (!videos.length) return null;
    return { id: j.id, videos, files };
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

/** Stream one video file from an added torrent into IINA with subtitles.
 *  Torrent .srt files are only attached for a single-video torrent (a pack has
 *  per-episode subs we can't reliably map, so those rely on embedded tracks). */
async function playFile(pack: Pack, fileIdx: number, imdbId: string): Promise<string> {
  const base = `${RQBIT_BASE}/torrents/${pack.id}/stream`;
  const subs = pack.videos.length === 1 ? pickSubtitles(pack.files).map((i) => `${base}/${i}`) : [];
  // external English .srt (movies only) first so IINA loads it as default
  const external = await fetchExternalSub(imdbId);
  if (external) subs.unshift(external);
  openInIina(`${base}/${fileIdx}`, subs);
  return subs.length
    ? `streaming → IINA (${subs.length} subtitle${subs.length > 1 ? "s" : ""})`
    : "streaming → IINA (embedded subs if any)";
}

// --dub prefers dual-audio anime torrents; default is sub. Set once at startup,
// read by the anime query builder in both the TUI and the headless path.
let dubMode = false;

// ---------------------------------------------------------------------------
// Headless streaming: `cine stream <query>` — pick a title, then a source, via
// fzf, and hand it to IINA. Same pipeline as the Stream tab, no TUI. Like
// lobster's flow, reusing homeSearch → resolveTorrents → rqbit → IINA.
// ---------------------------------------------------------------------------

/** Interactive pick with fzf: feeds "idx<TAB>label" lines, hides the idx
 *  column, returns the chosen item — or null if the user pressed esc. fzf reads
 *  candidates from our pipe and draws its UI on /dev/tty (inherited stderr). */
async function fzfPick<T>(items: T[], label: (t: T) => string, promptLabel: string): Promise<T | null> {
  const input = items.map((t, i) => `${i}\t${label(t)}`).join("\n");
  const proc = Bun.spawn(
    ["fzf", "--ansi", "--delimiter", "\t", "--with-nth", "2..", "--prompt", promptLabel, "--height", "40%", "--reverse"],
    { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "inherit" },
  );
  const picked = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!picked) return null; // esc / no match
  const idx = parseInt(picked.split("\t")[0], 10);
  return items[idx] ?? null;
}

function have(bin: string): boolean {
  return Bun.spawnSync(["which", bin], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function streamCli(query: string) {
  if (!have("rqbit")) return fail("rqbit not found — run: brew install rqbit");
  if (!have("fzf")) return fail("fzf not found — run: brew install fzf");

  // 1. resolve the query to a canonical title (IMDB suggestion) — gives a clean
  //    name, year, and the imdb id used for external subtitles. Skipped when the
  //    suggestion API finds nothing (e.g. an "Show S01E05" query): search raw.
  process.stderr.write("searching…\r");
  const results = await homeSearch(query);
  process.stderr.write("\x1b[2K");
  let movie: Movie | null = null;
  if (results.length === 1) movie = results[0];
  else if (results.length > 1) {
    movie = await fzfPick(
      results,
      (m) => `${m.title}${m.year ? ` (${m.year})` : ""}  ·  ${isSeries(m) ? "TV" : "movie"}`,
      "title> ",
    );
    if (!movie) return; // cancelled
  }

  // 2. a series → browse season/episode; a movie → title (+year). No IMDB match
  //    (raw "Show S01E05" query) → search the raw query, embedded subs only.
  //    Nyaa is anime-only, so non-anime skips it ("") and a relevance guard keeps
  //    generic titles ("House") from matching longer shows ("House of the Dragon").
  let ep: { season: number; number: number } | null = null;
  let knabenQ: string | string[], nyaaQ: string | string[];
  let relevance: { title: string; tag: string } | undefined;
  if (movie && isSeries(movie)) {
    const sel = await pickEpisode(movie);
    if (!sel) return; // cancelled
    ({ knabenQ, nyaaQ, ep, relevance } = sel);
  } else if (movie) {
    knabenQ = movie.year ? `${movie.title} ${movie.year}` : movie.title;
    nyaaQ = "";
    relevance = { title: movie.title, tag: String(movie.year ?? "") };
  } else {
    knabenQ = nyaaQ = query;
  }

  // 3. find sources, pick one
  process.stderr.write("\x1b[2Kfinding sources…\r");
  const torrents = await resolveTorrents(knabenQ, nyaaQ, relevance);
  process.stderr.write("\x1b[2K");
  if (!torrents.length) return fail("no source found — try a different search");
  const t = await fzfPick(
    torrents.slice(0, 25),
    (t) =>
      `${String(t.seeders).padStart(5)}▲  ${t.size.padStart(9)}  ${qualityLabel(t.title).padEnd(15)}  ${t.source.padEnd(8)}  ${t.title}`,
    "source> ",
  );
  if (!t) return; // cancelled

  // 4. add to rqbit, pick the file if it's a pack, buffer the head, hand to IINA
  streamReport = (m) => process.stderr.write("\x1b[2K" + m + "\r");
  if (!(await ensureRqbit())) return fail("couldn't start rqbit server");
  reportStream("resolving source…");
  const pack = await rqbitAddFiles(t.magnet);
  if (!pack) return fail("source has no seeds or no video — try another");
  let fileIdx = pack.videos[0].idx;
  if (pack.videos.length > 1) {
    // a season pack even when we searched one episode: pick the file
    const v = await fzfPick(pack.videos, (v) => `${humanSize(v.length).padStart(9)}  ${v.name}`, "episode> ");
    if (!v) return;
    fileIdx = v.idx;
  }
  await primeStream(pack.id, fileIdx);
  const msg = await playFile(pack, fileIdx, movie?.id ?? "");
  recordPlay(movie, ep);
  process.stderr.write("\x1b[2K");
  console.log(msg);
}

/** Season/episode selection for a series, returning the torrent search terms and
 *  the episode (for resume history). Anime is numbered via AniList (flat, romaji
 *  + episode) like the TUI; regular TV uses IMDB seasons/episodes and SxxEyy. */
async function pickEpisode(m: Movie): Promise<{
  knabenQ: string | string[];
  nyaaQ: string | string[];
  ep: { season: number; number: number };
  relevance?: { title: string; tag: string };
} | null> {
  process.stderr.write("loading episodes…\r");
  const anime = await fetchAnime(m.title);
  process.stderr.write("\x1b[2K");

  if (anime) {
    const eps = Array.from({ length: anime.episodes }, (_, i) => ({ number: i + 1, title: anime.titles[i + 1] ?? "" }));
    const ep = await fzfPick(eps, (e) => `${String(e.number).padStart(3)}  ${e.title}`, "episode> ");
    if (!ep) return null;
    return {
      knabenQ: `${m.title} ${sxxeyy(1, ep.number)}`,
      nyaaQ: animeQueries(animeTitles(anime), ep.number, dubMode),
      ep: { season: 1, number: ep.number },
    };
  }

  let seasons = await fetchSeasons(m.id);
  if (!seasons.length) seasons = [1];
  let season = seasons[0];
  if (seasons.length > 1) {
    const s = await fzfPick(seasons, (n) => `Season ${n}`, "season> ");
    if (s == null) return null;
    season = s;
  }
  process.stderr.write("loading episodes…\r");
  const eps = await fetchEpisodes(m.id, season);
  process.stderr.write("\x1b[2K");
  if (!eps.length) return fail("couldn't load episodes — try: cine stream \"" + m.title + " " + sxxeyy(season, 1) + "\"");
  const ep = await fzfPick(
    eps,
    (e) => `${sxxeyy(season, e.number)}  ${e.title}${e.rating ? ` · ${e.rating}` : ""}`,
    "episode> ",
  );
  if (!ep) return null;
  const tag = sxxeyy(season, ep.number);
  return {
    knabenQ: `${m.title} ${tag}`,
    nyaaQ: "", // Nyaa is anime-only; this is regular TV
    ep: { season, number: ep.number },
    relevance: { title: m.title, tag },
  };
}

function fail(msg: string): never {
  process.stderr.write("\x1b[2K");
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

type View = "list" | "detail" | "cinemas";
type SeriesState = {
  imdbId: string;
  title: string;
  seasons: number[];
  seasonIdx: number;
  episodes: Episode[];
  epSel: number;
  anime?: boolean; // numbered via AniList (flat, romaji search) instead of IMDB SxxEyy
  romaji?: string;
  aTitles?: string[]; // romaji/english/synonym variants to search Nyaa for anime
};

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
  homeMovies: [] as Movie[], // current search results (empty on the landing)
  homeQuery: "", // committed search text; "" means show the landing (recents + trending)
  recents: [] as Movie[], // landing: recently played (from history.json)
  trendMovies: [] as Movie[], // landing: IMDB most-popular movies
  trendTv: [] as Movie[], // landing: IMDB most-popular TV
  searchSeq: 0, // guards live-search: a newer keystroke invalidates older responses
  searchTimer: null as ReturnType<typeof setTimeout> | null,
  frame: { xy: new Map<number, { y: number; x: number }>(), pCols: 16 }, // last grid frame's cell positions
  mode: "normal" as "normal" | "search",
  searchBuf: "",
  overlay: null as null | "picker" | "files",
  overlayLines: [] as string[],
  picks: [] as Torrent[],
  pickSel: 0,
  pickTitle: "",
  pickImdb: "",
  pickMovie: null as Movie | null, // the title being streamed (for history)
  pickEp: null as { season: number; number: number } | null, // its episode, if a series
  pack: null as Pack | null,
  fileSel: 0,
  series: null as SeriesState | null,
};

type Group = { label: string; movies: Movie[] };

/** Ordered groups for the active view. Home landing = recents + trending
 *  (labeled, empty groups dropped); a Home search or Cinemas = one unlabeled
 *  group so the grid renders as a single flat block. */
function listGroups(): Group[] {
  if (state.tab !== "home") return [{ label: "", movies: gridMovies() }];
  if (state.homeQuery) return [{ label: "", movies: state.homeMovies }];
  return [
    { label: "Recently played", movies: state.recents },
    { label: "Trending movies", movies: state.trendMovies },
    { label: "Trending TV", movies: state.trendTv },
  ].filter((g) => g.movies.length);
}

/** Flat movie list (selection/navigation order) across all groups. */
function listMovies(): Movie[] {
  return listGroups().flatMap((g) => g.movies);
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
  return `${chip("Village", state.tab === "cinemas")}${chip("Stream", state.tab === "home")}`;
}

function header(cols: number): string {
  const ctx =
    state.tab === "cinemas"
      ? state.cinemaName
      : state.homeQuery
        ? `results · ${state.homeQuery}`
        : "stream";
  const left = ` ${A.bold}${A.cyan}CINE${A.reset} ${tabBar()}  ${A.bold}${ctx}${A.reset}`;
  const right = state.flash
    ? `${A.yellow}${state.flash}${A.reset}`
    : state.tab === "cinemas"
      ? `${A.grey}${gridMovies().length} movies · sorted by ${SORT_LABELS[state.sort]}${A.reset}`
      : state.homeQuery
        ? `${A.grey}${state.homeMovies.length} results · ⇥ switch tab${A.reset}`
        : `${A.grey}stream anything · ⇥ switch tab${A.reset}`;
  const pad = Math.max(1, cols - visLen(left) - visLen(right) - 2);
  return left + " ".repeat(pad) + right + "\n" + A.grey + "─".repeat(cols) + A.reset + "\n";
}

const GRID_POSTER_ROWS = 11;

/** Screen position of a grid cell in the last rendered frame, or null if it
 *  wasn't visible. The flow layout (renderList) fills state.frame.xy. */
function cellPos(idx: number): { y: number; x: number } | null {
  return state.frame.xy.get(idx) ?? null;
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
  // runtime for Village movies; release year for Home titles (which carry no runtime)
  const meta = movie.minutes ? `${movie.minutes}′` : movie.year ? String(movie.year) : "";
  return (
    `\x1b[${pos.y + GRID_POSTER_ROWS};${pos.x}H${title}` +
    `\x1b[${pos.y + GRID_POSTER_ROWS + 1};${pos.x}H${marker}${ratingStr(movie)}${rtGridStr(movie)}${meta ? ` ${A.grey}${meta}${A.reset}` : ""}`
  );
}

// A flow-layout block: either a group header line or a row of grid cells
// (holding global movie indices). Headers let the landing group recents and
// trending under labeled dividers within one scrolling grid.
type Block = { header: string } | { row: number[] };
const HEADER_H = 2; // blank + label line

function renderList() {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  let buf = header(cols);

  const groups = listGroups();
  const list = groups.flatMap((g) => g.movies);
  if (state.sel >= list.length) state.sel = Math.max(0, list.length - 1);
  if (!list.length) {
    const msg =
      state.tab === "home"
        ? state.homeQuery ? "No results." : "Press / to search, then ⏎ to play."
        : "No upcoming screenings.";
    buf += "\n" + center(`${A.dim}${msg}${A.reset}`, cols);
  }

  const pCols = posterCellCols(null, GRID_POSTER_ROWS);
  const cellW = pCols + 3; // poster + gap
  const cellH = GRID_POSTER_ROWS + 3; // poster + title + meta + gap
  const perRow = Math.max(1, Math.floor((cols - 2) / cellW));
  state.perRow = perRow;

  // Build blocks: each labeled group gets a header, then rows of `perRow` cells.
  const blocks: Block[] = [];
  let gi = 0; // running global movie index
  for (const g of groups) {
    if (g.label) blocks.push({ header: g.label });
    for (let i = 0; i < g.movies.length; i += perRow) {
      const idxs: number[] = [];
      for (let j = 0; j < perRow && i + j < g.movies.length; j++) idxs.push(gi + i + j);
      blocks.push({ row: idxs });
    }
    gi += g.movies.length;
  }
  const blockH = (b: Block) => ("header" in b ? HEADER_H : cellH);
  const selBlock = blocks.findIndex((b) => "row" in b && b.row.includes(state.sel));

  const gridTop = 3;
  const bottomY = rows - 1; // keep the last row for hints
  // Pick the top visible block so the selected cell stays on screen.
  let top = Math.max(0, Math.min(state.grid.scroll, blocks.length - 1));
  if (selBlock >= 0) {
    if (selBlock < top) top = selBlock;
    const fits = (from: number) => {
      let y = gridTop;
      for (let bi = from; bi <= selBlock; bi++) y += blockH(blocks[bi]);
      return y <= bottomY;
    };
    while (top < selBlock && !fits(top)) top++;
    // reveal a group's header when its first row is at the top of the window
    if (top > 0 && top === selBlock && "header" in blocks[top - 1]) top--;
  }
  state.grid = { scroll: top, perRow, viewRows: 0, pCols, cellW, cellH };

  const useKitty = kittySupported();
  const posters: { png: string; y: number; x: number }[] = [];
  const xy = new Map<number, { y: number; x: number }>();

  let y = gridTop;
  for (let bi = top; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const h = blockH(b);
    if (y + h > bottomY + 1) break; // no room for this block
    if ("header" in b) {
      buf += `\x1b[${y + 1};2H${A.grey}── ${b.header} ──${A.reset}`;
    } else {
      for (let c = 0; c < b.row.length; c++) xy.set(b.row[c], { y, x: 2 + c * cellW });
    }
    y += h;
  }
  state.frame = { xy, pCols };

  for (const [idx, pos] of xy) {
    const movie = list[idx];
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
      ? `${A.cyan} /${state.searchBuf}${A.reset}${A.grey}▏  ⏎ select · esc cancel${A.reset}`
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
  const old = state.sel;
  // repaint text-only when both cells are in the current frame; else scroll
  const stays = state.frame.xy.has(old) && state.frame.xy.has(clamped);
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

/** Append the season header + a scroll-windowed episode list to a series
 *  detail view. The window follows epSel and fits the remaining rows. */
function renderEpisodeBrowser(s: SeriesState, lines: string[], textW: number, rows: number) {
  if (s.anime) {
    lines.push(`${A.bold}Episodes${A.reset}  ${A.grey}(${s.episodes.length}${s.romaji ? ` · ${s.romaji}` : ""})${A.reset}`);
  } else {
    if (!s.seasons.length) {
      lines.push(`${A.grey}loading episodes…${A.reset}`);
      return;
    }
    const season = s.seasons[s.seasonIdx];
    const left = s.seasonIdx > 0 ? "◂" : " ";
    const right = s.seasonIdx < s.seasons.length - 1 ? "▸" : " ";
    lines.push(
      `${A.bold}${left} Season ${season} ${right}${A.reset}  ${A.grey}(${s.seasonIdx + 1}/${s.seasons.length})${A.reset}`,
    );
  }
  if (!s.episodes.length) {
    lines.push(`${A.grey}loading…${A.reset}`);
    return;
  }
  const w = lastWatched(s.imdbId); // resume point → ✓ on already-watched episodes
  const avail = Math.max(3, rows - 5 - lines.length);
  const total = s.episodes.length;
  const start = total <= avail ? 0 : Math.min(Math.max(0, s.epSel - Math.floor(avail / 2)), total - avail);
  for (let i = start; i < Math.min(total, start + avail); i++) {
    const ep = s.episodes[i];
    const sel = i === s.epSel;
    const watched = !!w && (ep.season < w.season || (ep.season === w.season && ep.number <= w.number));
    const mark = sel ? `${A.cyan}${A.bold}▸ ${A.reset}` : watched ? `${A.green}✓ ${A.reset}` : "  ";
    const rt = ep.rating != null ? ` ${A.grey}${ep.rating.toFixed(1)}★${A.reset}` : "";
    const label = truncate(ep.title ? `E${ep.number} · ${ep.title}` : `Episode ${ep.number}`, textW - 8);
    lines.push(`${mark}${sel ? A.bold : ""}${label}${A.reset}${rt}`);
  }
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
  const series = state.tab === "home" && state.series && state.series.imdbId === m.id ? state.series : null;

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
    const pl = wrap(plot, textW).map((l) => `${A.dim}${l}${A.reset}`);
    lines.push(...(series ? pl.slice(0, 2) : pl)); // series: keep plot short, leave room for episodes
    lines.push("");
  }
  if (series) {
    renderEpisodeBrowser(series, lines, textW, rows);
  } else if (state.tab === "home") {
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
  if (!series) {
    if (m.imdbUrl) lines.push(`${A.grey}imdb     ${m.imdbUrl}${A.reset}`);
    if (m.rt?.url) lines.push(`${A.grey}rotten   ${m.rt.url}${A.reset}`);
    if (m.trailer) lines.push(`${A.grey}trailer  ${m.trailer}${A.reset}`);
    if (m.url && state.tab === "cinemas") lines.push(`${A.grey}book     ${m.url}${A.reset}`);
  }

  lines.slice(0, rows - 5).forEach((l, i) => {
    buf += `\x1b[${4 + i};${textCol}H${truncate(l, textW)}`;
  });
  const hints =
    state.tab === "cinemas"
      ? ` esc back · t trailer · b book · q quit`
      : series
        ? series.anime
          ? ` esc back · ↑↓ episode · ⏎ play · n next · q quit`
          : ` esc back · ←→ season · ↑↓ episode · ⏎ play · n next · q quit`
        : ` esc back · p play · b imdb · q quit`;
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

/** Draw one poster into its cell in the current frame, without touching the
 *  rest of the screen. A full renderList would clearScreen — which in kitty
 *  deletes and re-transmits *every* image, so a poster trickling in over the
 *  network would flash the whole grid. This paints just the one that landed. */
function drawPosterInCell(id: string) {
  if (state.tab !== "home" || state.view !== "list") return;
  const list = listMovies();
  for (const [idx, pos] of state.frame.xy) {
    if (list[idx]?.id !== id) continue;
    const png = state.posterPaths.get(id);
    if (!png) return;
    if (kittySupported()) {
      drawPoster(gridThumbPath(png), pos.y, pos.x, GRID_POSTER_ROWS, state.frame.pCols);
    } else {
      let buf = "";
      posterHalfblockLines(png, GRID_POSTER_ROWS).forEach((line, li) => {
        buf += `\x1b[${pos.y + li};${pos.x}H${line}`;
      });
      out(buf);
    }
    out(cellText(idx, list[idx], idx === state.sel));
    return; // a movie occupies at most one visible cell
  }
}

/** Fetch posters for a set of Home titles in the background, painting each into
 *  its cell as it lands (off-screen ones just cache — scrolling draws them). */
function prefetchPosters(movies: Movie[]) {
  for (const m of movies) {
    if (state.posterPaths.has(m.id)) continue;
    ensurePoster(m).then((png) => {
      state.posterPaths.set(m.id, png);
      if (png) drawPosterInCell(m.id);
    });
  }
}

function prefetchHomePosters() {
  prefetchPosters(state.homeMovies);
}

let homeLoaded = false;

/** Populate the Home landing: recents (always refreshed from history) and
 *  trending movies/TV (fetched once, 12h-cached). Non-blocking. */
async function ensureHomeLoaded() {
  state.recents = loadHistory().map(historyToMovie);
  prefetchPosters(state.recents);
  if (homeLoaded) return;
  homeLoaded = true;
  const cached = loadTrending();
  if (cached) {
    state.trendMovies = cached.movies;
    state.trendTv = cached.tv;
  } else {
    const [mv, tv] = await Promise.all([fetchTrending("movie"), fetchTrending("tvSeries")]);
    state.trendMovies = mv;
    state.trendTv = tv;
    if (mv.length || tv.length) saveTrending(mv, tv);
  }
  prefetchPosters([...state.trendMovies, ...state.trendTv]);
  if (state.tab === "home" && state.view === "list" && !state.homeQuery) renderList();
}

/** Live search: debounce keystrokes, drop stale responses via a sequence
 *  counter, and fall back to the landing when the query is cleared. */
function scheduleSearch() {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  const q = state.searchBuf.trim();
  if (!q) {
    state.homeQuery = "";
    state.homeMovies = [];
    state.sel = 0;
    state.searchSeq++; // cancel any in-flight response
    return renderList();
  }
  state.homeQuery = q; // show the (possibly stale) results group while typing
  state.searchTimer = setTimeout(async () => {
    const seq = ++state.searchSeq;
    const res = await homeSearch(q);
    if (seq !== state.searchSeq) return; // a newer keystroke superseded this
    state.homeMovies = res;
    state.sel = 0;
    prefetchHomePosters();
    if (state.tab === "home" && state.view === "list") renderList();
  }, 250);
}

/** One picker row: marker · seeders (▲) · size · quality · source · title. */
function pickerRow(t: Torrent, selected: boolean): string {
  const mark = selected ? `${A.cyan}${A.bold}▸ ${A.reset}` : "  ";
  const seeds = `${A.green}${String(t.seeders).padStart(5)}▲${A.reset}`;
  const size = `${A.grey}${t.size.padStart(9)}${A.reset}`;
  const qual = `${A.cyan}${truncate(qualityLabel(t.title), 15).padEnd(15)}${A.reset}`;
  const src = `${A.grey}${truncate(t.source, 8).padEnd(8)}${A.reset}`;
  const name = selected ? `${A.bold}${truncate(t.title, 30)}${A.reset}` : `${A.dim}${truncate(t.title, 30)}${A.reset}`;
  return `${mark}${seeds} ${size}  ${qual} ${src} ${name}`;
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
    `${A.grey}   seeders      size  quality         source   title${A.reset}`,
    ...shown.map((t, li) => pickerRow(t, start + li === state.pickSel)),
    `${A.grey}↑↓ choose · ⏎ play · esc cancel${counter}${A.reset}`,
  ];
}

/** Resolve sources for a query → source picker overlay (highest-seeded first). */
async function startStreamFor(
  label: string,
  imdbId: string,
  knabenQuery: string | string[],
  nyaaQuery: string | string[],
  relevance?: { title: string; tag: string },
) {
  state.flash = "finding sources…";
  render();
  const torrents = await resolveTorrents(knabenQuery, nyaaQuery, relevance);
  state.flash = "";
  if (!torrents.length) {
    state.flash = "no source found — try a different search";
    return render();
  }
  state.picks = torrents.slice(0, 25);
  state.pickSel = 0;
  state.pickTitle = label;
  state.pickImdb = imdbId;
  state.overlay = "picker";
  state.overlayLines = buildPickerLines();
  render();
}

/** A movie: search Knaben by title (+year); Nyaa is anime-only so it's skipped,
 *  and a relevance guard keeps a generic title off longer same-word shows. */
function startStream(m: Movie) {
  state.pickMovie = m;
  state.pickEp = null;
  return startStreamFor(m.title, m.id, m.year ? `${m.title} ${m.year}` : m.title, "", {
    title: m.title,
    tag: String(m.year ?? ""),
  });
}

/** Stream one episode. Anime searches Nyaa by every title variant + episode
 *  number and Knaben by SxxEyy; regular TV uses SxxEyy on Knaben only (Nyaa is
 *  anime-only) with a relevance guard against generic titles. */
function streamEpisode(s: SeriesState) {
  const ep = s.episodes[s.epSel];
  if (!ep) return;
  state.pickMovie = listMovies()[state.sel] ?? historyToMovie({ id: s.imdbId, title: s.title, poster: "", kind: "tvSeries", ts: 0 });
  state.pickEp = { season: s.seasons[s.seasonIdx], number: ep.number };
  const tag = sxxeyy(s.seasons[s.seasonIdx], ep.number);
  if (s.anime && s.aTitles?.length) {
    const pad = String(ep.number).padStart(2, "0");
    return startStreamFor(
      `${s.aTitles[0]} - ${pad}`,
      s.imdbId,
      `${s.title} ${tag}`,
      animeQueries(s.aTitles, ep.number, dubMode),
    );
  }
  return startStreamFor(`${s.title} ${tag}`, s.imdbId, `${s.title} ${tag}`, "", { title: s.title, tag });
}

async function loadSeries(m: Movie) {
  const s: SeriesState = { imdbId: m.id, title: m.title, seasons: [], seasonIdx: 0, episodes: [], epSel: 0 };
  state.series = s;
  if (state.view === "detail") renderDetail();
  // anime is numbered by AniList (flat, romaji); a false match is harmless
  // since the Knaben SxxEyy search still runs alongside the Nyaa romaji one
  const a = await fetchAnime(m.title);
  if (state.series !== s) return;
  if (a) {
    s.anime = true;
    s.romaji = a.romaji;
    s.aTitles = animeTitles(a);
    s.seasons = [1];
    s.episodes = Array.from({ length: a.episodes }, (_, i) => ({
      season: 1, number: i + 1, title: a.titles[i + 1] ?? "", rating: null,
    }));
    applyResume(s);
    if (state.view === "detail") renderDetail();
    return;
  }
  s.seasons = await fetchSeasons(m.id);
  if (state.series !== s) return; // user moved on
  if (!s.seasons.length) s.seasons = [1];
  await loadSeasonEpisodes(s);
}

async function loadSeasonEpisodes(s: SeriesState) {
  s.episodes = [];
  s.epSel = 0;
  if (state.series === s && state.view === "detail") renderDetail();
  const eps = await fetchEpisodes(s.imdbId, s.seasons[s.seasonIdx]);
  if (state.series !== s) return;
  s.episodes = eps;
  applyResume(s);
  if (state.view === "detail") renderDetail();
}

/** Jump the selection to the first unwatched episode of the current season,
 *  based on the resume point recorded in history (else stay at the top). */
function applyResume(s: SeriesState) {
  const w = lastWatched(s.imdbId);
  if (!w || s.seasons[s.seasonIdx] !== w.season) {
    s.epSel = 0;
    return;
  }
  const next = s.episodes.findIndex((e) => e.number > w.number);
  s.epSel = next >= 0 ? next : Math.max(0, s.episodes.length - 1);
}

/** One episode-picker row: marker · size · filename. */
function fileRow(v: Video, selected: boolean): string {
  const mark = selected ? `${A.cyan}${A.bold}▸ ${A.reset}` : "  ";
  const size = `${A.grey}${humanSize(v.length).padStart(9)}${A.reset}`;
  const name = selected ? `${A.bold}${truncate(v.name, 46)}${A.reset}` : truncate(v.name, 46);
  return `${mark}${size}  ${name}`;
}

function buildFileLines(): string[] {
  const vids = state.pack?.videos ?? [];
  const capacity = Math.max(4, (process.stdout.rows || 24) - 9);
  const total = vids.length;
  const start =
    total <= capacity ? 0 : Math.min(Math.max(0, state.fileSel - Math.floor(capacity / 2)), total - capacity);
  const shown = vids.slice(start, start + capacity);
  const counter = total > capacity ? `  ·  ${start + 1}–${start + shown.length}/${total}` : "";
  return [
    `${A.bold}${truncate(state.pickTitle, 40)}${A.reset} ${A.grey}— ${total} episodes${A.reset}`,
    `${A.grey}      size  file${A.reset}`,
    ...shown.map((v, li) => fileRow(v, start + li === state.fileSel)),
    `${A.grey}↑↓ choose · ⏎ play · esc cancel${counter}${A.reset}`,
  ];
}

/** Run an async task while animating a spinner in the header. rqbit's add
 *  blocks for seconds while it resolves metadata from peers, so this gives the
 *  wait a heartbeat instead of a frozen "starting stream…". */
async function withSpinner<T>(msg: string, fn: () => Promise<T>): Promise<T> {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    state.flash = `${frames[i++ % frames.length]} ${msg}`;
    render();
  }, 120);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

const PRIME_TARGET = 8 * 1024 * 1024; // buffer this much of the file head before IINA opens
const PRIME_MAX_MS = 45_000; // …but don't wait longer than this (open IINA anyway)

// Where streaming progress goes: the TUI header by default; the `stream`
// subcommand (headless) swaps in a stderr line so it works with no TUI running.
let streamReport: ((msg: string) => void) | null = null;
function reportStream(msg: string) {
  if (streamReport) streamReport(msg);
  else {
    state.flash = msg;
    render();
  }
}

/** Whether a torrent has finished downloading (whole file available). */
async function rqbitFinished(id: number): Promise<boolean> {
  try {
    const r = await fetch(`${RQBIT_BASE}/torrents/${id}/stats/v1`, { signal: AbortSignal.timeout(5_000) });
    return r.ok ? Boolean((await r.json()).finished) : false;
  } catch {
    return false;
  }
}

/** Buffer the head of a file *before* handing it to IINA. rqbit only serves the
 *  stream from byte 0 and (in 8.1.1) ignores Range, so if IINA opens at 0% it
 *  gets an *immediate empty EOF* and hangs at "loading media…" forever. Reading
 *  the stream ourselves forces rqbit into sequential (head-first) download; each
 *  read streams the downloaded head then ends at the download frontier, so we
 *  retry from byte 0 until one pass reaches the target (the head is buffered),
 *  the torrent finishes, or we time out. Shows buffered MB · speed meanwhile. */
async function primeStream(id: number, fileIdx: number) {
  const url = `${RQBIT_BASE}/torrents/${id}/stream/${fileIdx}`;
  const started = performance.now();
  while (performance.now() - started < PRIME_MAX_MS) {
    let read = 0;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PRIME_MAX_MS) });
      if (res.body) {
        const reader = res.body.getReader();
        let lastRender = 0;
        while (read < PRIME_TARGET) {
          const { done, value } = await reader.read();
          if (done) break; // hit the download frontier (or 0% empty stream)
          read += value?.length ?? 0;
          const elapsed = performance.now() - started;
          if (elapsed - lastRender > 400) {
            lastRender = elapsed;
            const mb = (read / 1048576).toFixed(1);
            const speed = (read / 1048576 / Math.max(0.1, elapsed / 1000)).toFixed(1);
            reportStream(`▸ buffering ${mb} MB · ${speed} MB/s`);
          }
          if (elapsed > PRIME_MAX_MS) break;
        }
        await reader.cancel();
      }
    } catch {
      // network hiccup — fall through to the finished-check / retry
    }
    if (read >= PRIME_TARGET) return; // head buffered → safe to open IINA
    if (await rqbitFinished(id)) return; // small file fully downloaded
    await Bun.sleep(700); // let more pieces arrive, then re-read from byte 0
  }
}

/** "▸ next: E06 · press n" when the just-played item is a series episode with
 *  a next one queued; empty otherwise. */
function nextEpHint(): string {
  const s = state.series;
  if (!s || !state.pickEp || s.epSel >= s.episodes.length - 1) return "";
  return `   ▸ next: E${s.episodes[s.epSel + 1].number} · press n`;
}

/** Chosen source → add torrent → play directly (movie/single episode) or open
 *  the episode picker (season pack / anime batch). */
async function playPick(t: Torrent) {
  if (!rqbitInstalled()) {
    state.flash = "rqbit not found — run: brew install rqbit";
    return render();
  }
  state.flash = "starting stream…";
  render();
  if (!(await ensureRqbit())) {
    state.flash = "couldn't start rqbit server";
    return render();
  }
  const pack = await withSpinner("resolving source…", () => rqbitAddFiles(t.magnet));
  if (!pack) {
    state.flash = "source has no seeds or no video — try another";
    return render();
  }
  if (pack.videos.length === 1) {
    await primeStream(pack.id, pack.videos[0].idx); // buffer the head so IINA doesn't open an empty stream
    const msg = await playFile(pack, pack.videos[0].idx, state.pickImdb);
    recordPlay(state.pickMovie, state.pickEp);
    state.flash = msg + nextEpHint();
    return render();
  }
  state.pack = pack;
  state.fileSel = 0;
  state.overlay = "files";
  state.overlayLines = buildFileLines();
  render();
}

async function playEpisode() {
  const pack = state.pack;
  const v = pack?.videos[state.fileSel];
  state.overlay = null;
  if (!pack || !v) return render();
  state.flash = "starting episode…";
  render();
  await primeStream(pack.id, v.idx); // buffer the head so IINA doesn't open an empty stream
  const msg = await playFile(pack, v.idx, state.pickImdb);
  recordPlay(state.pickMovie, state.pickEp);
  state.flash = msg;
  return render();
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

  // the episode picker (season packs / anime batches)
  if (state.overlay === "files") {
    if (key === "\x1b[A" || key === "k") state.fileSel = Math.max(0, state.fileSel - 1);
    else if (key === "\x1b[B" || key === "j")
      state.fileSel = Math.min((state.pack?.videos.length ?? 1) - 1, state.fileSel + 1);
    else if (key === "\r" || key === "\n") return playEpisode();
    else if (key === "\x1b" || key === "q") {
      state.overlay = null;
      return render();
    } else return;
    state.overlayLines = buildFileLines();
    return render();
  }

  // search input mode (Home): typed keys build the query — note "q" types here,
  // it doesn't quit, so this must come before the quit check below
  if (state.mode === "search") {
    if (key === "\r" || key === "\n") {
      // results are already live — ⏎ just leaves the input so arrows navigate
      state.mode = "normal";
      return render();
    }
    if (key === "\x1b") {
      state.mode = "normal";
      state.searchBuf = "";
      scheduleSearch(); // empty query → back to the landing
      return;
    }
    if (key === "\x7f" || key === "\b") {
      state.searchBuf = state.searchBuf.slice(0, -1);
      renderList();
      return scheduleSearch();
    }
    // accept typed text; a paste/fast typing can arrive as a multi-char chunk,
    // so take every printable character rather than only single keys
    if (!key.startsWith("\x1b")) {
      const typed = [...key].filter((c) => c >= " " && c !== "\x7f").join("");
      if (typed) {
        state.searchBuf += typed;
        renderList();
        return scheduleSearch();
      }
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
    state.grid.scroll = 0;
    state.showPrices = false;
    if (state.tab === "home") ensureHomeLoaded(); // non-blocking: recents now, trending as it lands
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
    if (state.view === "detail") state.series = null;
    state.view = state.view === "detail" ? "list" : state.view;
    state.showPrices = false;
    return render();
  }
  if (key === "t") return openUrl(selMovie?.trailer ?? "");
  if (key === "b") return openUrl(selMovie?.url ?? "");
  if (key === "p") {
    if (state.tab !== "home") {
      state.showPrices = !state.showPrices;
      return render();
    }
    if (!selMovie) return;
    if (isSeries(selMovie)) {
      // a series needs an episode chosen first — open the episode browser
      if (state.view === "detail" && state.series?.episodes.length) return streamEpisode(state.series);
      state.view = "detail";
      loadSeries(selMovie);
      return render();
    }
    return startStream(selMovie);
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
  // series detail: ↑↓ moves episode, ←→ changes season
  if (state.tab === "home" && state.view === "detail" && state.series) {
    const s = state.series;
    if (key === "\x1b[A") {
      s.epSel = Math.max(0, s.epSel - 1);
      return renderDetail();
    }
    if (key === "\x1b[B") {
      s.epSel = Math.min(Math.max(0, s.episodes.length - 1), s.epSel + 1);
      return renderDetail();
    }
    if (key === "\x1b[D") {
      if (s.seasonIdx > 0) {
        s.seasonIdx--;
        loadSeasonEpisodes(s);
      }
      return;
    }
    if (key === "\x1b[C") {
      if (s.seasonIdx < s.seasons.length - 1) {
        s.seasonIdx++;
        loadSeasonEpisodes(s);
      }
      return;
    }
    if (key === "\r") return streamEpisode(s);
    // n → advance to the next episode and stream it (binge without re-picking)
    if (key === "n" && s.epSel < s.episodes.length - 1) {
      s.epSel++;
      renderDetail();
      return streamEpisode(s);
    }
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
    if (state.view === "list" && selMovie) {
      state.view = "detail";
      if (state.tab === "home" && isSeries(selMovie)) loadSeries(selMovie);
    }
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
      dub: { type: "boolean" },
      sub: { type: "boolean" }, // explicit default; --dub overrides
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) return console.log(HELP);
  dubMode = Boolean(values.dub) && !values.sub;

  // headless streaming: cine stream <query> — fzf a title, fzf a source, play
  const [cmd, ...args] = positionals;
  if (cmd === "stream" || cmd === "play") {
    const query = args.join(" ").trim();
    if (!query) return console.error("usage: cine stream <title>");
    return streamCli(query);
  }

  // siren subcommands: cine watch [title] [--imax] [-c id], cine unwatch <title>
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
