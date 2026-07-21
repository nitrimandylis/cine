# cine streaming hub — design

**Date:** 2026-07-21
**Status:** approved, pre-plan

## Goal

Turn cine from a Village-Cinemas-only tool into an "out or in" hub: one binary,
`Tab` switches between **Cinemas** (everything cine does today, unchanged) and
**Home** (browse any title and stream it into IINA). The Home tab reuses cine's
existing poster grid, detail view, and status bar so it looks native.

## Non-goals

- Not porting movie-tui. Built fresh in cine's style.
- No library/continue-watching/progress-tracking (movie-tui's sqlite layer). A
  title is streamed and forgotten. Add later only if wanted.
- cine does not manage a VPN in the MVP (see Level 0 vs Level 1 below).
- No streaming-site scrapers (lobster/Consumet). They are an unmaintainable
  arms race — dead upstream (lobster archived, ani-cli on a daily key-rotation
  treadmill, every Consumet provider returned HTTP 522 when tested 2026-07-21).
  We go torrent-native instead: a magnet is a content hash, so there is nothing
  to obfuscate or rotate — near-zero maintenance.

## Architecture

cine stays a single compiled Bun binary that shells out to system tools, exactly
as it already calls `sips` / `open` / `gh`. The Home tab adds three shell-outs
and two keyless HTTP sources — no bundled runtime deps, stays zero-dependency.

```
Home tab
  /  search        → IMDb suggestion API   (cine already has imdbLookup/IMDB_SUGGEST)
  ⏎  detail        → reuse renderDetail()   (poster + plot + rating)
  p  stream        → VPN gate → magnet resolve → rqbit → IINA
  v  vpn status    → default-route iface + public-IP org
```

### 1. Browse (reuse what exists)

- `/` in the Home tab runs a search against the IMDb suggestion endpoint cine
  already uses, and renders results in the existing poster grid (same
  `renderList` / `cellText` / `drawPoster` path). Enrichment (rating, poster)
  reuses `enrich()`.
- Metadata source is IMDb for everything, including anime — keeps one code path.
  Source *routing for magnets* (below) is what differs by content type.

### 2. Magnet resolution (tested live 2026-07-21, all keyless)

| Content | Source | Endpoint |
|---|---|---|
| Movies / TV | **Knaben** aggregator | `POST https://api.knaben.org/v1` `{query, order_by:"seeders", order_direction:"desc", size}` |
| Anime | **Nyaa** | `GET https://nyaa.si/?page=rss&q=<title>&c=1_2` |

- Knaben searches across FMHY-trusted indexers and returns magnets + seeder
  counts, so cine never touches a fake/ad-ridden site UI (the real danger the
  r/Piracy megathread warns about — the *site*, not the magnet). cine picks the
  highest-seeded hit, preferring known release groups (YIFY / GalaxyRG).
- Route to Nyaa when the IMDb entry looks like anime (genre "Animation" +
  Japanese origin); otherwise Knaben. When unsure, query Knaben.
- Indexer base URLs are config values (`~/.config/cine/config.json`) so an
  ISP-blocked domain is a one-line swap to a mirror, not a code change.

### 3. Playback — rqbit → IINA

Chosen over webtorrent-cli: Rust/native, much faster and better at seeking on
large files, `brew install rqbit`, actively maintained (v9.0.0-beta.2, 2026-01).
Streams while downloading with a real HTTP range-seek endpoint.

Flow on `p`:
1. `which rqbit` — if missing, status message: `brew install rqbit`.
2. VPN gate (below). Abort with a message if it fails and `--no-vpn-check` is off.
3. Resolve magnet (section 2). If none found → status message.
4. Confirmation overlay: title / size / seeders / source + VPN status + a
   one-line "torrenting — VPN required" caveat. `y` confirms.
5. Ensure rqbit server: if `GET http://127.0.0.1:3030/` fails, spawn
   `rqbit --http-api-listen-addr 127.0.0.1:3030 server start ~/.cache/cine/torrents`
   detached.
6. `POST /torrents` with the magnet → response gives torrent id + file list.
   Pick the largest video file's index.
7. `open -a IINA "http://127.0.0.1:3030/torrents/<id>/stream/<idx>"`. rqbit
   blocks the stream until pieces arrive and prioritises them, so IINA plays
   within seconds and supports seeking.
8. cine stays in the TUI (no suspend needed — IINA is a separate GUI app). The
   rqbit server keeps running for the session; cine stops it on quit.

Playback is isolated behind one `play()` function, so swapping rqbit for
webtorrent-cli later (or adding it as a fallback) touches nothing else.

### 4. VPN safety — Level 0 (detect-only gate)

**The risk:** torrent peers see your IP and your ISP sees the traffic. Verified
2026-07-21 the machine's exit IP was `AS6799 OTE, Athens` — fully exposed. In
the EU that is the DMCA-letter path, so cine refuses to stream without a tunnel.

**The gate:** before streaming, read the default-route interface via
`route -n get default`. A tunnel (`utunN` as the default route) → proceed. A
physical interface (`en0` / `en1`) → block with "No VPN detected — connect your
VPN (with kill switch) first."

**Gotcha handled:** presence of a `utun` interface is NOT a valid signal — the
test machine had six idle `utun` interfaces up with no VPN (macOS uses them for
Private Relay, Continuity, etc.). Only *the default route being a `utun`*
counts. This is why the gate checks the route, not `ifconfig`.

**Override:** `--no-vpn-check` flag for advanced users.

**What cine cannot do, and won't fake:** bind torrent traffic to the VPN, or
stop a leak if the VPN drops mid-stream. Neither rqbit nor webtorrent-cli
supports interface-binding on macOS. The drop case is covered by the VPN's own
kill switch (ProtonVPN app Kill Switch, Mullvad Lockdown, or `pf` rules baked
into a WireGuard `.conf`) — recommended in docs, not enforced by cine.

cine stays VPN-agnostic: the default-route gate recognises any full-tunnel VPN.

### 5. VPN status keybind

`v` in the Home tab shows a small overlay:
- Default-route interface (`route -n get default`) — the tunnel/physical signal.
- Public IP + org (`GET https://ipinfo.io/json`) — ground truth ("OTE" = not
  protected; a hosting/VPN ASN = protected).

Lets you eyeball "am I safe" before hitting `p`.

## Keybindings (Home tab)

- `Tab` — switch Cinemas ⇄ Home (global).
- `/` — search. `⏎` — detail. `p` — stream (free here; `p`=prices is
  Cinemas-only). `v` — VPN status. `q` — quit. Arrows/`j`/`k` — move.

## Config / cache additions

- `~/.config/cine/config.json`: `knabenBase`, `nyaaBase`, `noVpnCheck`.
- `~/.cache/cine/torrents/`: rqbit download dir.

## New external tools (shell-outs, like sips/open/gh — not bundled)

- `rqbit` (`brew install rqbit`) — torrent streaming.
- IINA (already present) — playback.
- A full-tunnel VPN with kill switch — user-provided.

## Known ceilings

- Anime-vs-movie routing is a heuristic (IMDb genre + origin); mis-routes fall
  back to Knaben.
- The VPN gate proves a tunnel is the default route at stream *start*; it can't
  prove a kill switch is on, so a mid-stream drop still relies on the user's VPN.
- rqbit server is per-session; a crash mid-stream needs a re-`p`.
