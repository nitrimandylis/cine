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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

keys (inside the TUI):
  ↑/↓/←/→ move around the poster grid   ⏎ details   t trailer   b book
  p prices   c switch cinema   r refresh   q quit

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
};

type CachePayload = { cachedAt: string; cinemaId: string; cinemaName: string; movies: Movie[] };

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

async function imdbLookup(movie: Movie): Promise<void> {
  try {
    const q = movie.title.toLowerCase().trim();
    const first = q.replace(/[^a-z0-9]/g, "")[0] ?? "x";
    const res = await fetch(`${IMDB_SUGGEST}/${first}/${encodeURIComponent(q)}.json`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return;
    const hits: Suggestion[] = (await res.json()).d ?? [];
    const match = pickImdbMatch(hits, new Date().getFullYear());
    if (!match) return;

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
    if (!gql.ok) return;
    const t = (await gql.json()).data?.title;
    if (!t) return;
    movie.rating = t.ratingsSummary?.aggregateRating ?? null;
    movie.votes = t.ratingsSummary?.voteCount ?? 0;
    movie.imdbUrl = `https://www.imdb.com/title/${match.id}/`;
    movie.imdbPlot = t.plot?.plotText?.plainText ?? "";
    movie.imdbPoster = t.primaryImage?.url ?? "";
  } catch {
    // no IMDB data — the movie just shows "?" for its rating
  }
}

async function enrich(movies: Movie[], onProgress: (done: number, total: number) => void) {
  let done = 0;
  await Promise.all(
    movies.map((m) => imdbLookup(m).then(() => onProgress(++done, movies.length))),
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
    return isCacheFresh(payload, new Date()) ? payload : null;
  } catch {
    return null;
  }
}

function saveCache(payload: CachePayload) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(payload.cinemaId), JSON.stringify(payload));
}

function loadConfig(): { cinema?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: { cinema?: string }) {
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
  const hour = st.soldout
    ? `${A.red}${A.dim}${st.hour}✗${A.reset}`
    : `${A.cyan}${A.bold}${st.hour}${A.reset}`;
  return b ? `${hour}${A.dim}·${A.reset}${b}` : hour;
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

const kittyTransferred = new Set<number>();

/** Upload a PNG to the terminal once under a numeric image id (no placement). */
function kittyTransfer(png: string, id: number) {
  if (kittyTransferred.has(id)) return;
  const data = readFileSync(png).toString("base64");
  let out = "";
  for (let i = 0; i < data.length; i += 4096) {
    const chunk = data.slice(i, i + 4096);
    const ctrl = i === 0 ? `f=100,a=t,q=2,i=${id},m=${i + 4096 >= data.length ? 0 : 1}` : `m=${i + 4096 >= data.length ? 0 : 1}`;
    out += `\x1b_G${ctrl};${chunk}\x1b\\`;
  }
  process.stdout.write(out);
  kittyTransferred.add(id);
}

/** Place an already-transferred image at (row,col), scaled into rows×cols cells. */
function kittyPlace(id: number, row: number, col: number, rows: number, cols: number) {
  process.stdout.write(`\x1b[${row};${col}H\x1b_Ga=p,i=${id},q=2,C=1,r=${rows},c=${cols}\x1b\\`);
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
  detailToken: 0,
  posterPaths: new Map<string, string | null>(),
};

const imgIds = new Map<string, number>();

function imgId(movieId: string): number {
  if (!imgIds.has(movieId)) imgIds.set(movieId, imgIds.size + 1);
  return imgIds.get(movieId)!;
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

function sortMovies() {
  state.movies.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
}

function renderStatus(msg: string) {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  out(`\x1b[${Math.floor(rows / 2)};1H` + center(`${A.cyan}${msg}${A.reset}`, cols));
}

function header(cols: number): string {
  const left = ` ${A.bold}${A.cyan}CINE${A.reset}  ${A.bold}${state.cinemaName}${A.reset}`;
  const right = `${A.grey}${gridMovies().length} movies · sorted by IMDB${A.reset}`;
  const pad = Math.max(1, cols - visLen(left) - visLen(right) - 2);
  return left + " ".repeat(pad) + right + "\n" + A.grey + "─".repeat(cols) + A.reset + "\n";
}

const GRID_POSTER_ROWS = 11;

function renderList() {
  clearScreen();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  let buf = header(cols);

  const list = gridMovies();
  if (state.sel >= list.length) state.sel = Math.max(0, list.length - 1);
  if (!list.length) buf += "\n" + center(`${A.dim}No upcoming screenings.${A.reset}`, cols);

  const pCols = posterCellCols(null, GRID_POSTER_ROWS);
  const cellW = pCols + 3; // poster + gap
  const cellH = GRID_POSTER_ROWS + 3; // poster + title + meta + gap
  const perRow = Math.max(1, Math.floor((cols - 2) / cellW));
  state.perRow = perRow;
  const viewRows = Math.max(1, Math.floor((rows - 4) / cellH));
  const totalRows = Math.ceil(list.length / perRow);
  const selRow = Math.floor(state.sel / perRow);
  const scroll = Math.max(0, Math.min(selRow - viewRows + 1, totalRows - viewRows));

  const useKitty = kittySupported();
  const placements: { png: string; id: number; y: number; x: number }[] = [];

  for (let i = 0; i < viewRows * perRow; i++) {
    const idx = (scroll + Math.floor(i / perRow)) * perRow + (i % perRow);
    const movie = list[idx];
    if (!movie) break;
    const y = 3 + Math.floor(i / perRow) * cellH;
    const x = 2 + (i % perRow) * cellW;
    const selected = idx === state.sel;
    const png = state.posterPaths.get(movie.id) ?? null;

    if (png && useKitty) {
      placements.push({ png, id: imgId(movie.id), y, x });
    } else if (png) {
      posterHalfblockLines(png, GRID_POSTER_ROWS).forEach((line, li) => {
        buf += `\x1b[${y + li};${x}H${line}`;
      });
    } else {
      buf += `\x1b[${y + Math.floor(GRID_POSTER_ROWS / 2)};${x}H${A.grey}${center("(no poster)", pCols)}${A.reset}`;
    }

    const titleRaw = truncate(movie.title, pCols);
    const titlePad = titleRaw + " ".repeat(Math.max(0, pCols - visLen(titleRaw)));
    const title = selected ? `${A.inv}${A.bold}${titlePad}${A.reset}` : `${A.bold}${titlePad}${A.reset}`;
    buf += `\x1b[${y + GRID_POSTER_ROWS};${x}H${title}`;
    const marker = selected ? `${A.cyan}${A.bold}▸ ${A.reset}` : "";
    buf += `\x1b[${y + GRID_POSTER_ROWS + 1};${x}H${marker}${ratingStr(movie)} ${A.grey}${movie.minutes}′${A.reset}`;
  }

  const hints = ` ↑↓←→ move · ⏎ details · t trailer · b book · p prices · c cinema · r refresh · q quit`;
  buf += `\x1b[${rows};1H${A.grey}${truncate(hints, cols - 1)}${A.reset}`;
  out(buf);

  for (const p of placements) {
    kittyTransfer(p.png, p.id);
    kittyPlace(p.id, p.y, p.x, GRID_POSTER_ROWS, pCols);
  }

  if (state.showPrices) renderPrices(cols, rows);
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
  const m = gridMovies()[state.sel];
  if (!m) {
    state.view = "list";
    return renderList();
  }
  const token = ++state.detailToken;

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
  lines.push(`${A.grey}${m.minutes}′ · ${m.genre}${m.pg ? ` · ${m.pg}` : ""}${A.reset}`);
  lines.push("");
  const plot = m.imdbPlot || m.plot;
  if (plot) {
    lines.push(...wrap(plot, textW).map((l) => `${A.dim}${l}${A.reset}`));
    lines.push("");
  }
  const today = isoDay(new Date());
  for (const day of state.dayList) {
    const times = m.days[day];
    if (!times?.length) continue;
    lines.push(
      `${A.bold}${fmtDay(day, today)}${A.reset}  ` + times.map(showtimeStr).join("  "),
    );
  }
  lines.push("");
  if (m.imdbUrl) lines.push(`${A.grey}imdb     ${m.imdbUrl}${A.reset}`);
  if (m.trailer) lines.push(`${A.grey}trailer  ${m.trailer}${A.reset}`);
  if (m.url) lines.push(`${A.grey}book     ${m.url}${A.reset}`);

  lines.slice(0, rows - 5).forEach((l, i) => {
    buf += `\x1b[${4 + i};${textCol}H${truncate(l, textW)}`;
  });
  const hints = ` esc back · t trailer · b book · q quit`;
  buf += `\x1b[${rows};1H${A.grey}${hints}${A.reset}`;
  out(buf);

  const png = state.posterPaths.get(m.id) ?? (await ensurePoster(m));
  if (token !== state.detailToken || state.view !== "detail") return;
  if (png) {
    if (useKitty) {
      kittyTransfer(png, imgId(m.id));
      kittyPlace(imgId(m.id), 4, 3, posterRows, posterCellCols(png, posterRows));
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

async function handleKey(key: string) {
  const list = gridMovies();
  const selMovie = list[state.sel];

  if (key === "\x03" || key === "q") quit();

  if (state.view === "cinemas") {
    const n = Object.keys(CINEMAS).length;
    if (key === "\x1b[A") state.cinemaSel = (state.cinemaSel + n - 1) % n;
    else if (key === "\x1b[B") state.cinemaSel = (state.cinemaSel + 1) % n;
    else if (key === "\r") {
      const id = Object.keys(CINEMAS)[state.cinemaSel];
      saveConfig({ cinema: id });
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
    state.showPrices = !state.showPrices;
    return render();
  }
  if (key === "c") {
    state.view = "cinemas";
    state.cinemaSel = Math.max(0, Object.keys(CINEMAS).indexOf(state.cinemaId));
    return render();
  }
  if (key === "r") {
    state.view = "list";
    await loadData(state.cinemaId, true);
    return render();
  }
  const last = Math.max(0, list.length - 1);
  const step = state.view === "list" ? state.perRow : 1; // detail: ↑↓ step one movie
  if (key === "\x1b[C") {
    state.sel = Math.min(last, state.sel + 1);
    return render();
  }
  if (key === "\x1b[D") {
    state.sel = Math.max(0, state.sel - 1);
    return render();
  }
  if (key === "\x1b[A") {
    state.sel = Math.max(0, state.sel - step);
    return render();
  }
  if (key === "\x1b[B") {
    state.sel = Math.min(last, state.sel + step);
    return render();
  }
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
    console.log(`${movie.title} (${rating}) ${movie.minutes}′`);
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
  const { values } = parseArgs({
    options: {
      cinema: { type: "string", short: "c" },
      date: { type: "string", short: "d" },
      list: { type: "boolean" },
      clear: { type: "boolean" },
      "no-cache": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) return console.log(HELP);
  if (values.list) {
    for (const [id, name] of Object.entries(CINEMAS)) console.log(`${id}  ${name}`);
    return;
  }

  const config = loadConfig();
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
    saveCache({ cachedAt: new Date().toISOString(), cinemaId, cinemaName, movies });
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
