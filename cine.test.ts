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
} from "./cine";

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
