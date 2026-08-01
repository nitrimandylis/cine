---
name: cine-cli
description: Drive the cine CLI — Village Cinemas (Greece) showtimes with IMDB and Rotten Tomatoes verdicts, plus a torrent-backed streaming tab that plays into IINA. Use whenever the user asks what is playing at the cinema, wants showtimes or cinema tickets in Athens or Greece, mentions cine or Village Cinemas, wants to watch or stream a specific film or series, or wants a ticket alert when booking opens.
---

# cine

`cine` scrapes villagecinemas.gr, cross-references IMDB and Rotten Tomatoes, and renders it as a poster
wall. A second tab streams anything not playing near you into IINA over `rqbit`. Compiled Bun binary at
`~/.bun/bin/cine`. Full offline reference: `man cine`.

## What you can run headlessly

**Piped output is a plain list instead of the TUI**, which is what makes cine usable from a tool call:

```bash
cine --list              # cinema IDs and names, exits
cine | cat               # your remembered cinema's listings, plain text
cine -c 21 | cat         # a specific cinema by ID
cine -d 25/07 | cat      # filter the piped list to a date (DD/MM)
cine --no-cache | cat    # ignore the 12h cache, fetch fresh
cine --clear             # drop the cache for your cinema, then fetch
cine watch               # list active ticket alerts
```

Always pipe. `cine` on its own draws a full-screen TUI that a tool call cannot render or exit.

Answer "what's on this weekend" with `cine -d DD/MM | cat`, not by opening anything.

## Ticket alerts

```bash
cine watch <title>            # get pinged when booking opens
cine watch <title> --imax
cine watch <title> -c 21      # limit to one cinema
cine unwatch <title>
```

These edit the watch list in the `siren` repo via `gh api`, so a GitHub Action does the polling. They
are writes to a remote repository: confirm the title and cinema with the user before running one, and
run `cine watch` afterwards to show that it landed.

## Streaming

```bash
cine stream <title>          # fzf a title, fzf a source, play in IINA
cine stream <title> --dub    # prefer dual-audio anime (default: sub)
```

**`cine stream` is two or three fzf pickers deep and cannot be driven headlessly.** Series add a
season and episode step; a season-pack source adds a file picker. Hand the user the command rather than
spawning it. It needs `fzf`, `rqbit` and IINA installed; the Village side needs none of them.

## Things that will bite you

- **Availability colours are Village's own flags, not the live seat map.** Cyan is on sale, yellow is
  few seats, red ✗ is sold out, and all three lag reality because the real seat map sits behind a
  captcha cine does not fight. Report a sellout as "Village says sold out", never as fact.
- **The cache is 12 hours.** If the user says a showtime is missing or wrong, `cine --clear` before you
  conclude anything about the scraper. It also self-invalidates when the schema changes or when every
  cached showtime is in the past.
- **Titles are localized on Village and canonical on IMDB.** cine resolves them (VAIANA → Moana), so
  search by the title the user said and let it map. Don't pre-translate.
- **Everything is scraped from public endpoints with no API keys**, which means IMDB or RT changing their
  markup breaks enrichment while showtimes keep working. A movie with showtimes and no rating is that,
  not a missing movie.
- **Streaming is torrent-backed.** Nothing about the Village tab touches it, but be straight with the
  user about which half of the tool they are asking for.
