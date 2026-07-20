<h1 align="center">🎬 cine</h1>

<p align="center">
  Village Cinemas (Greece) showtimes in your terminal — IMDB ratings, real posters, zero dependencies.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-bun-f9f1e1" alt="bun" />
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero deps" />
  <img src="https://img.shields.io/badge/platform-macOS-blue" alt="macOS" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT" />
</p>

`cine` shows what's playing at your Village cinema as a wall of movie posters,
sorted by IMDB rating, in a full-screen TUI. Arrow around the grid, hit ⏎ for
the detail view — plot, every day's showtimes, the poster up close, and
Rotten Tomatoes scores with ANSI recreations of the real icons (Certified
Fresh, fresh tomato, rotten splat, Verified Hot, popcorn bucket, spilled
bucket). Images render natively in your terminal (Kitty graphics protocol in
Ghostty/kitty/WezTerm, half-block mosaic anywhere else). It remembers your
cinema, caches for 12 hours, and opens trailers and booking pages straight in
the browser.

A TypeScript rewrite of [village_crawler](https://github.com/johneliades/village_crawler),
reshaped into an interactive TUI.

## Run it

```bash
git clone https://github.com/nitrimandylis/cine.git
cd cine
bun run compile   # → ~/.bun/bin/cine, and man cine into your manpath
cine
man cine          # full reference, offline
```

## Keys

| Key | Action |
|-----|--------|
| `↑` `↓` `←` `→` | move around the poster grid |
| `⏎` | detail view — poster, plot, every day's showtimes |
| `s` | cycle sort: IMDB → Tomatometer → Popcornmeter → runtime |
| `w` | watch/unwatch: get pinged via [siren](https://github.com/nitrimandylis/siren) when tickets open |
| `t` | open trailer in browser |
| `b` | open booking page |
| `p` | ticket price table |
| `c` | switch cinema (becomes the new default) |
| `r` | refresh (skip cache) |
| `q` / `esc` | quit / back |

Showtime colors: cyan = on sale, yellow = few seats left, red `✗` = sold out —
as reported by Village's own flags, which often lag real availability (the
live seat map sits behind a captcha'd booking step).

Flags for scripting: `-c <id>`, `-d DD/MM`, `--list`, `--clear`, `--no-cache`.
Piped output (`cine -c 21 | cat`) prints a plain list instead of the TUI.

## Ticket alerts

`cine` manages the watch list of [siren](https://github.com/nitrimandylis/siren)
(a GitHub Actions watcher that pings your phone when Village opens booking)
through the GitHub API — no workflow editing, ever:

```bash
cine watch                      # list active watches
cine watch "avatar 4" --imax    # pinged when IMAX tickets open
cine unwatch "avatar 4"
```

Or just press `w` on any movie in the TUI. Requires an authed `gh`.

## Under the hood

```mermaid
flowchart LR
    A[villagecinemas.gr<br/>bookingData JSON] --> C[parse + group<br/>showtimes]
    B[IMDB suggestion API<br/>+ public GraphQL] --> D[rating · plot · poster]
    C --> E[12h cache<br/>~/.cache/cine]
    D --> E
    E --> F[TUI<br/>raw ANSI + stdin]
    F --> G[Kitty graphics<br/>poster via sips]
    F --> H[open trailer /<br/>booking page]
```

No npm packages at runtime — `fetch` for the network, `sips(1)` for image
conversion, `open(1)` for the browser, hand-rolled ANSI for the TUI.

## License

MIT
