import { describe, expect, test } from "bun:test";
import {
  pyList,
  pyBool,
  stripHtml,
  isoDay,
  fmtDay,
  wrap,
  isCacheFresh,
  pickImdbMatch,
  parseBookingData,
  resolveDate,
  stripAnsi,
  parseRtSearch,
  parseRtScorecard,
  RT_ICONS,
  sortValue,
  SORTS,
  parseDefaultIface,
  isTunnelIface,
  parseKnaben,
  parseNyaaRss,
  humanSize,
  pickVideoFile,
} from "./cine";

test("pickVideoFile picks the largest video, ignoring samples and non-video", () => {
  const files = [
    { name: "readme.txt", length: 100 },
    { name: "sample.mkv", length: 50_000_000 },
    { components: ["Movie", "movie.mkv"], length: 8_000_000_000 },
    { name: "cover.jpg", length: 200_000 },
  ];
  expect(pickVideoFile(files)).toBe(2); // the 8GB mkv (via components path)
  expect(pickVideoFile([{ name: "notes.nfo", length: 10 }])).toBe(-1);
});

test("parseKnaben builds magnets and formats size", () => {
  const out = parseKnaben({
    hits: [
      { title: "The Matrix 1999 1080p", seeders: "552", bytes: 1992277407, tracker: "The Pirate Bay", hash: "D7A46713EAEE18C746B3254B7D1492A50FD9D6CE" },
      { title: "no hash skipped", seeders: 3 },
    ],
  });
  expect(out.length).toBe(1); // the hash-less hit is dropped
  expect(out[0].magnet).toContain("urn:btih:D7A46713");
  expect(out[0].magnet).toContain("tr=udp"); // trackers appended
  expect(out[0].seeders).toBe(552);
  expect(out[0].size).toBe("1.9 GB");
});

test("parseNyaaRss pulls magnets from infoHash", () => {
  const xml = `<rss><channel><item>
    <title>[SubsPlease] Frieren (01) 1080p</title>
    <nyaa:seeders>210</nyaa:seeders>
    <nyaa:size>1.4 GiB</nyaa:size>
    <nyaa:infoHash>abc123def4567890abc123def4567890abc123de</nyaa:infoHash>
  </item></channel></rss>`;
  const out = parseNyaaRss(xml);
  expect(out.length).toBe(1);
  expect(out[0].seeders).toBe(210);
  expect(out[0].size).toBe("1.4 GiB");
  expect(out[0].magnet).toContain("urn:btih:abc123def4");
});

test("humanSize scales bytes", () => {
  expect(humanSize(0)).toBe("?");
  expect(humanSize(1500)).toBe("1.5 KB");
  expect(humanSize(1992277407)).toBe("1.9 GB");
});

test("VPN gate trusts a tunnel only when it carries the default route", () => {
  const via = (iface: string) =>
    `   route to: default\ndestination: default\n       gateway: 10.0.0.1\n  interface: ${iface}\n      flags: <UP,GATEWAY>`;
  expect(parseDefaultIface(via("en0"))).toBe("en0");
  expect(parseDefaultIface(via("utun4"))).toBe("utun4");
  expect(parseDefaultIface("nothing here")).toBeNull();
  // a utun on the default route = VPN; a physical iface = exposed
  expect(isTunnelIface("utun4")).toBe(true);
  expect(isTunnelIface("wg0")).toBe(true);
  expect(isTunnelIface("en0")).toBe(false);
  expect(isTunnelIface(null)).toBe(false);
});

test("sortValue orders by each key, missing scores last", () => {
  const m = (rating: number | null, critic: number | null, audience: number | null, minutes: number) =>
    ({ rating, minutes, rt: critic === null && audience === null ? null : { critic, audience } }) as any;
  const good = m(8.4, 95, 97, 172);
  const bad = m(5.7, 31, 89, 115);
  const unknown = m(null, null, null, 80);
  expect(sortValue(good, "imdb")).toBeGreaterThan(sortValue(bad, "imdb"));
  expect(sortValue(bad, "imdb")).toBeGreaterThan(sortValue(unknown, "imdb"));
  expect(sortValue(good, "critics")).toBeGreaterThan(sortValue(bad, "critics"));
  expect(sortValue(bad, "audience")).toBeLessThan(sortValue(good, "audience"));
  // runtime sorts shortest first (higher value = earlier)
  expect(sortValue(unknown, "runtime")).toBeGreaterThan(sortValue(bad, "runtime"));
  expect(SORTS).toEqual(["imdb", "critics", "audience", "runtime"]);
});

test("pyList parses arrays and python-style stringified lists", () => {
  expect(pyList(["01", "21"])).toEqual(["01", "21"]);
  expect(pyList("['01', '21', '22']")).toEqual(["01", "21", "22"]);
  expect(pyList("[]")).toEqual([]);
  expect(pyList("")).toEqual([]);
  expect(pyList("garbage")).toEqual([]);
});

test("pyBool", () => {
  expect(pyBool("True")).toBe(true);
  expect(pyBool("False")).toBe(false);
});

test("stripHtml flattens markup and entities", () => {
  expect(stripHtml("<p>Hello&nbsp;<b>world</b> &amp; you</p>")).toBe("Hello world & you");
});

test("wrap respects width", () => {
  const lines = wrap("aaa bbb ccc ddd", 7);
  expect(lines).toEqual(["aaa bbb", "ccc ddd"]);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(7);
});

test("fmtDay marks today", () => {
  expect(fmtDay("2026-07-25", "2026-07-20")).toBe("Sat 25/07");
  expect(fmtDay("2026-07-20", "2026-07-20")).toBe("Mon 20/07 (today)");
});

describe("isCacheFresh", () => {
  const now = new Date("2026-07-20T18:00:00");
  const movie = (days: string[]) =>
    ({ days: Object.fromEntries(days.map((d) => [d, [{}]])) }) as any;
  const payload = (cachedAt: string, days: string[]) =>
    ({ cachedAt, cinemaId: "21", cinemaName: "x", movies: [movie(days)] }) as any;

  test("fresh cache with future days", () => {
    expect(isCacheFresh(payload("2026-07-20T12:00:00", ["2026-07-21"]), now)).toBe(true);
  });
  test("expired after 12h", () => {
    expect(isCacheFresh(payload("2026-07-20T01:00:00", ["2026-07-21"]), now)).toBe(false);
  });
  test("stale when all days are in the past", () => {
    expect(isCacheFresh(payload("2026-07-20T12:00:00", ["2026-07-19"]), now)).toBe(false);
  });
});

test("pickImdbMatch prefers a recent movie result", () => {
  const list = [
    { id: "tt1", l: "Old", y: 1999, qid: "movie" },
    { id: "tt2", l: "Show", y: 2026, qid: "tvSeries" },
    { id: "tt3", l: "New", y: 2026, qid: "movie" },
  ];
  expect(pickImdbMatch(list, 2026)?.id).toBe("tt3");
  expect(pickImdbMatch([list[0]], 2026)?.id).toBe("tt1"); // falls back to any movie
});

test("parseBookingData extracts movies and grouped showtimes", () => {
  const bookingData = {
    filters: { cinemas: [{ value: "21", display: "The Mall" }] },
    screens: [
      {
        cinemaId: "21", scheduledFilmId: "F1", showtime: "2026-07-21T21:30:00",
        screenName: "CINEMA 5", soldoutStatus: false, isSphera: false, isDolby: true,
        is3D: false, isImax: false, isImax3D: false, isLimited: false,
      },
      {
        cinemaId: "21", scheduledFilmId: "F1", showtime: "2026-07-21T18:00:00",
        screenName: "CINEMA 5", soldoutStatus: true, isSphera: false, isDolby: false,
        is3D: false, isImax: false, isImax3D: false, isLimited: false,
      },
      { cinemaId: "99", scheduledFilmId: "F1", showtime: "2026-07-21T20:00:00",
        screenName: "X", soldoutStatus: false, isSphera: false, isDolby: false,
        is3D: false, isImax: false, isImax3D: false, isLimited: false },
    ],
    records: [
      {
        movieId: "F1", title: "TEST MOVIE", desc: "<p>A plot.</p>", vid: "abc",
        thumb: "/media/poster.jpg", dur: "115", url: "https://example.com/movie",
        genre: "DRAMA", pg: "K15", cinemas: "['21']", dates: "['2026-07-21']",
      },
      { movieId: "F2", title: "ELSEWHERE", desc: "", vid: "", thumb: "", dur: "90",
        url: "", genre: "", pg: "", cinemas: "['99']", dates: "[]" },
    ],
  };
  const html = `<script>var bookingData = ${JSON.stringify(bookingData)}</script>`;
  const { cinemaName, movies } = parseBookingData(html, "21");

  expect(cinemaName).toBe("The Mall");
  expect(movies).toHaveLength(1);
  const m = movies[0];
  expect(m.title).toBe("TEST MOVIE");
  expect(m.plot).toBe("A plot.");
  expect(m.trailer).toBe("https://www.youtube.com/watch?v=abc");
  expect(m.minutes).toBe(115);
  const times = m.days["2026-07-21"];
  expect(times.map((t) => t.hour)).toEqual(["18:00", "21:30"]); // sorted, other cinema excluded
  expect(times[0].soldout).toBe(true);
  expect(times[1].dolby).toBe(true);
});

test("resolveDate maps DD/MM onto the day list", () => {
  const days = ["2026-07-20", "2026-07-25"];
  expect(resolveDate("25/07", days)).toBe("2026-07-25");
  expect(resolveDate("5/8", days)).toBe(null);
  expect(resolveDate("nonsense", days)).toBe(null);
});

test("stripAnsi removes escape codes", () => {
  expect(stripAnsi("\x1b[1;32mhi\x1b[0m")).toBe("hi");
});

test("every RT icon line is exactly 9 visible columns", () => {
  for (const [name, lines] of Object.entries(RT_ICONS)) {
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect({ name, width: stripAnsi(line).length }).toEqual({ name, width: 9 });
    }
  }
});

test("parseRtSearch prefers recent releases and requires a name match", () => {
  const row = (url: string, year: number, name: string) =>
    `<search-page-media-row release-year="${year}"><a href="${url}">${name}</a></search-page-media-row>`;
  const html =
    row("https://www.rottentomatoes.com/m/the_odyssey_1997", 1997, "The Odyssey") +
    row("https://www.rottentomatoes.com/m/the_odyssey_2026", 2026, "The Odyssey");
  expect(parseRtSearch(html, 2026, "The Odyssey")).toBe(
    "https://www.rottentomatoes.com/m/the_odyssey_2026",
  );
  expect(
    parseRtSearch(row("https://www.rottentomatoes.com/m/old_movie", 1997, "Old Movie"), 2026, "old movie"),
  ).toBe("https://www.rottentomatoes.com/m/old_movie");
  // unrelated results are rejected even when they're the right year (VAIANA case)
  const unrelated =
    row("https://www.rottentomatoes.com/m/varanasi", 2027, "Varanasi") +
    row("https://www.rottentomatoes.com/m/moana_2016", 2016, "Moana");
  expect(parseRtSearch(unrelated, 2026, "vaiana")).toBe(null);
  expect(parseRtSearch(unrelated, 2026, "Moana")).toBe("https://www.rottentomatoes.com/m/moana_2016");
  expect(parseRtSearch("<html>no rows</html>", 2026, "x")).toBe(null);
});

test("parseRtScorecard maps scores and icon states", () => {
  const sc = {
    criticsScore: { score: "82", certified: true, sentiment: "POSITIVE", reviewCount: 369 },
    audienceScore: { score: "97", scoreType: "VERIFIED", certified: true, sentiment: "POSITIVE", reviewCount: 5547 },
  };
  const html = `<script id="media-scorecard-json" type="application/json">${JSON.stringify(sc)}</script>`;
  const rt = parseRtScorecard(html, "https://rt/m/x")!;
  expect(rt.critic).toBe(82);
  expect(rt.criticState).toBe("certified");
  expect(rt.criticCount).toBe(369);
  expect(rt.audience).toBe(97);
  expect(rt.audienceState).toBe("verified");
  expect(rt.audienceCount).toBe(5547);

  const rotten = parseRtScorecard(
    `<script id="media-scorecard-json">${JSON.stringify({
      criticsScore: { score: "40", certified: false, sentiment: "NEGATIVE", reviewCount: 10 },
      audienceScore: { score: "55", scoreType: "", certified: false, sentiment: "NEGATIVE", reviewCount: 99 },
    })}</script>`,
    "u",
  )!;
  expect(rotten.criticState).toBe("rotten");
  expect(rotten.audienceState).toBe("spilled");

  expect(parseRtScorecard("<html></html>", "u")).toBe(null);
});
