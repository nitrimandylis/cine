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
- Flags: `-c`, `-d DD/MM`, `--list`, `--clear`, `--no-cache`.

## Where it's headed

- Nothing planned. Candidates if wanted: other chains (Odeon/Cinepolis),
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
