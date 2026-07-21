# cine

## What it is

A terminal UI for Village Cinemas (Greece): what's playing, when, and whether
it's any good. Scrapes villagecinemas.gr's booking data, enriches every movie
with its IMDB rating/plot (keyless suggestion API + GraphQL) and Rotten
Tomatoes critic + audience scores (server-rendered search page + embedded
scorecard JSON), and presents it as an interactive poster grid sorted by
rating — posters render in the terminal (Kitty graphics protocol in
Ghostty/kitty/WezTerm, half-block mosaic elsewhere), and RT states show as
ANSI recreations of the official icon set.

A TypeScript/Bun rewrite of [village_crawler](https://github.com/johneliades/village_crawler)
with a full TUI instead of static output. Zero runtime dependencies; system
tools (`sips`, `open`) do the heavy lifting. Ships as a compiled standalone
binary (`bun run compile` → `~/.bun/bin/cine`) with a man page.

## Current state (v0.1.0)

- Interactive TUI: poster-grid main view (all movies, sorted by rating,
  arrow keys to move), ⏎ detail view with big poster + every day's
  showtimes, `t` trailer, `b` booking page, `p` price table, `c` cinema
  switcher, `r` refresh, `q` quit. Selection moves repaint only text;
  posters (small pre-scaled thumbs) re-emit only when the grid scrolls —
  Ghostty didn't render id-based Kitty placements (a=p), so cine sticks to
  direct a=T draws.
- Remembers the last-used cinema (`~/.config/cine/config.json`).
- 12-hour JSON cache + poster cache (`~/.cache/cine/`), auto-invalidated
  when stale or all dates have passed.
- `s` cycles the sort (IMDB → Tomatometer → Popcornmeter → runtime),
  persisted in config. Showtimes color-code availability: yellow = few
  seats (Village's isLimited flag), red ✗ = sold out.
- siren integration: `w` in the TUI or `cine watch/unwatch <title>` edits
  the watches.json of nitrimandylis/siren via `gh api`, so ticket alerts
  never require touching GitHub Actions.
- Piped output falls back to a plain text list for scripting.
- **Streaming hub:** `⇥` switches Village ⇄ Stream (tab labels). Stream reuses the poster
  grid/detail to search any title (IMDB suggestion), then `p` opens a source
  picker (seeders/size/source) and streams the chosen magnet into IINA —
  sources from Knaben (movies/TV) + Nyaa (anime), played via `rqbit`'s HTTP
  stream endpoint. Series: opening one in Home shows a **season/episode
  browser**. TV uses IMDB GraphQL (seasons via `←→`, episodes via `↑↓`, titles +
  ratings) and searches `Show SxxEyy`. **Anime** is detected via AniList and gets
  a flat episode list numbered the way Nyaa releases are, searching by romaji +
  episode (e.g. `Sousou no Frieren 05`) — a false anime match is harmless since
  the SxxEyy search still runs too. A season pack / batch then flows into an
  **episode picker** over the torrent's files (natural-sorted E02→E10). Subtitles: an English `.srt` is fetched by IMDB id from
  yifysubtitles (keyless, cached in `~/.cache/cine/subs/`) for any movie, plus
  any `.srt` shipped in the torrent, plus embedded MKV tracks — all attached to
  IINA (external English first). Needs `rqbit` (`brew install rqbit`).
- **Home landing + UX** (`2026-07-21`): Home opens on a grouped grid —
  **Recently played** (local `history.json`, deduped, cap 30) above **Trending
  movies** / **Trending TV** (IMDB `advancedTitleSearch` by popularity, 12h
  cache in `~/.cache/cine/trending.json`), drawn as one scrolling grid with
  labeled `── … ──` dividers. **Live search** (`/`) queries the suggestion API
  as you type (250ms debounce, stale-response guard) instead of ⏎-to-search.
  The **source picker** parses a **quality** column (2160p/HDR/x265/WEB-DL…)
  out of release names; picking one **buffers the file head** (showing MB ·
  speed) before opening IINA — rqbit serves the stream only from byte 0 and (in
  8.1.1) returns an immediate empty EOF at 0%, so opening IINA too early hangs it
  at "loading media…"; cine reads the stream itself until the head is buffered,
  then hands off. Series get **✓ watched markers**,
  **resume** (selection jumps to the next unwatched episode), **`n` play-next**,
  and AniList episode **titles** for anime.
- **Headless stream** (`cine stream <title>`): the Stream pipeline without the
  TUI, lobster-style. `fzf` picks the title (IMDB suggestion); a **series** then
  steps through season → episode (IMDB seasons/episodes → `SxxEyy`, or AniList
  romaji + episode number for anime), a movie skips straight to the source pick
  (Knaben/Nyaa, highest-seeded first). A season-pack source adds one more `fzf`
  over the torrent's files. Same `rqbit` head-buffer + IINA handoff and history
  recording (episode saved for resume) as the tab. Needs `fzf` alongside
  `rqbit`/IINA (each checked with a clear error).
- Flags: `-c`, `-d DD/MM`, `--list`, `--clear`, `--no-cache`.

## Where it's headed

- **Streaming hub — shipped** (see Current state; design notes in the gitignored
  `docs/superpowers/specs/2026-07-21-streaming-hub-design.md`). Torrent-native
  rather than streaming-site scrapers, which are a dead/daily-breaking arms race
  (lobster archived, ani-cli on a key-rotation treadmill) — a magnet is a content
  hash, so near-zero maintenance. Source picker with a parsed quality column —
  shipped (see Home landing + UX above).
- Other candidates if wanted: other chains (Odeon/Cinepolis),
  publishing the repo.
- Ruled out: full seat maps — Village's addtickets step rejects requests
  without a reCAPTCHA Enterprise token (verified: HTTP 400), and the seat
  plan only unlocks after it; automating past a captcha is off the table.
  The soldout/isLimited flags are the best keyless signal, but Village
  rarely populates them (observed 0 set across 532 sessions), so the
  showtime colors mirror the website's own badges — no better.

## Known ceilings

- Prices in the `p` overlay are hardcoded (same as the original project).
- IMDB matching is title-search-based; Greek-only titles may not match
  (movie shows "?" rating).
- Poster cell sizing assumes ~1:2 terminal cell aspect ratio.
