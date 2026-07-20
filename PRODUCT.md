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
- Piped output falls back to a plain text list for scripting.
- Flags: `-c`, `-d DD/MM`, `--list`, `--clear`, `--no-cache`.

## Where it's headed

- Nothing planned. Candidates if wanted: other chains (Odeon/Cinepolis),
  a "notify me when tickets open" watch mode, seat availability detail.

## Known ceilings

- Prices in the `p` overlay are hardcoded (same as the original project).
- IMDB matching is title-search-based; Greek-only titles may not match
  (movie shows "?" rating).
- Poster cell sizing assumes ~1:2 terminal cell aspect ratio.
