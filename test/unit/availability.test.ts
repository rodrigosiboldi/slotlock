import { describe, expect, test } from "bun:test";
import {
  checkStart,
  computeSlots,
  formatClock,
  type Interval,
  mergeIntervals,
  type OpeningHours,
  parseClock,
  type Schedule,
  type ServiceTiming,
} from "../../src/domain/availability";

const MADRID = "Europe/Madrid";
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];

function service(overrides: Partial<ServiceTiming> = {}): ServiceTiming {
  return {
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    slotIntervalMinutes: 30,
    minNoticeMinutes: 0,
    maxAdvanceDays: 365,
    ...overrides,
  };
}

function hours(opens: string, closes: string, weekdays = ALL_WEEK): OpeningHours[] {
  return weekdays.map((weekday) => ({ weekday, opensAt: parseClock(opens), closesAt: parseClock(closes) }));
}

function schedule(openingHours: OpeningHours[], timing: Partial<ServiceTiming> = {}): Schedule {
  return { timezone: MADRID, openingHours, service: service(timing) };
}

const instant = (value: string) => Temporal.Instant.from(value);
const date = (value: string) => Temporal.PlainDate.from(value);
const interval = (start: string, end: string): Interval => ({ start: instant(start), end: instant(end) });
// "now" for tests that are not about notice or advance: early enough, within the 365-day horizon.
const longAgo = instant("2026-01-01T00:00:00Z");

/** Slot starts as local wall-clock time with offset, e.g. "2026-10-27T09:00:00+01:00". */
function starts(slots: Interval[], timeZone = MADRID): string[] {
  return slots.map((slot) => slot.start.toZonedDateTimeISO(timeZone).toString({ timeZoneName: "never" }));
}

describe("computeSlots", () => {
  test("offers every start on the grid whose slot fits inside opening hours", () => {
    const slots = computeSlots(
      schedule(hours("09:00", "12:00")),
      [],
      { from: date("2026-10-27"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(slots)).toEqual([
      "2026-10-27T09:00:00+01:00",
      "2026-10-27T09:30:00+01:00",
      "2026-10-27T10:00:00+01:00",
      "2026-10-27T10:30:00+01:00",
      "2026-10-27T11:00:00+01:00",
    ]);
    expect(slots[0]?.end.toString()).toBe("2026-10-27T09:00:00Z");
  });

  test("keeps the resource free for the buffers of both bookings", () => {
    // An existing booking 10:00–11:00 local whose service adds 15 minutes of cleanup.
    const busy = [interval("2026-10-27T09:00:00Z", "2026-10-27T10:15:00Z")];
    const slots = computeSlots(
      schedule(hours("09:00", "14:00"), { bufferAfterMinutes: 15 }),
      busy,
      { from: date("2026-10-27"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(slots)).toEqual([
      "2026-10-27T11:30:00+01:00",
      "2026-10-27T12:00:00+01:00",
      "2026-10-27T12:30:00+01:00",
      "2026-10-27T13:00:00+01:00",
    ]);
  });

  test("a slot may end exactly when the next booking starts", () => {
    const busy = [interval("2026-10-27T09:00:00Z", "2026-10-27T10:00:00Z")];
    const slots = computeSlots(
      schedule(hours("09:00", "12:00")),
      busy,
      { from: date("2026-10-27"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(slots)).toEqual(["2026-10-27T09:00:00+01:00", "2026-10-27T11:00:00+01:00"]);
  });

  test("honours minimum notice and maximum advance", () => {
    const now = instant("2026-10-27T08:10:00Z"); // 09:10 in Madrid
    const slots = computeSlots(
      schedule(hours("09:00", "12:00"), { minNoticeMinutes: 60, maxAdvanceDays: 1 }),
      [],
      { from: date("2026-10-27"), to: date("2026-10-30") },
      now,
    );
    expect(starts(slots)).toEqual([
      "2026-10-27T10:30:00+01:00",
      "2026-10-27T11:00:00+01:00",
      "2026-10-28T09:00:00+01:00",
    ]);
  });

  test("on the night clocks go back, 02:00 happens twice and the night lasts seven hours", () => {
    // Sunday 25 October 2026: 03:00 CEST becomes 02:00 CET.
    const slots = computeSlots(
      schedule(hours("00:00", "06:00", [7]), { slotIntervalMinutes: 60 }),
      [],
      { from: date("2026-10-25"), to: date("2026-10-25") },
      longAgo,
    );
    expect(starts(slots)).toEqual([
      "2026-10-25T00:00:00+02:00",
      "2026-10-25T01:00:00+02:00",
      "2026-10-25T02:00:00+02:00",
      "2026-10-25T02:00:00+01:00",
      "2026-10-25T03:00:00+01:00",
      "2026-10-25T04:00:00+01:00",
      "2026-10-25T05:00:00+01:00",
    ]);
  });

  test("on the night clocks go forward, 02:00–03:00 does not exist", () => {
    // Sunday 29 March 2026: 02:00 CET becomes 03:00 CEST.
    const slots = computeSlots(
      schedule(hours("00:00", "06:00", [7]), { slotIntervalMinutes: 60 }),
      [],
      { from: date("2026-03-29"), to: date("2026-03-29") },
      longAgo,
    );
    expect(starts(slots)).toEqual([
      "2026-03-29T00:00:00+01:00",
      "2026-03-29T01:00:00+01:00",
      "2026-03-29T03:00:00+02:00",
      "2026-03-29T04:00:00+02:00",
      "2026-03-29T05:00:00+02:00",
    ]);
  });

  test("a window that opens inside the spring-forward gap opens when the clocks land", () => {
    const slots = computeSlots(
      schedule(hours("02:30", "05:00", [7]), { slotIntervalMinutes: 60 }),
      [],
      { from: date("2026-03-29"), to: date("2026-03-29") },
      longAgo,
    );
    expect(starts(slots)).toEqual(["2026-03-29T03:30:00+02:00"]);
  });

  test("windows touching at midnight merge, so a booking can cross it", () => {
    const openingHours = [
      { weekday: 1, opensAt: parseClock("22:00"), closesAt: parseClock("24:00") },
      { weekday: 2, opensAt: parseClock("00:00"), closesAt: parseClock("02:00") },
    ];
    const timing = { durationMinutes: 120, slotIntervalMinutes: 60 };
    const both = computeSlots(
      schedule(openingHours, timing),
      [],
      { from: date("2026-10-26"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(both)).toEqual([
      "2026-10-26T22:00:00+01:00",
      "2026-10-26T23:00:00+01:00",
      "2026-10-27T00:00:00+01:00",
    ]);
    // Asking for Tuesday only still sees the window that opened on Monday.
    const tuesday = computeSlots(
      schedule(openingHours, timing),
      [],
      { from: date("2026-10-27"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(tuesday)).toEqual(["2026-10-27T00:00:00+01:00"]);
  });

  test("time off removes every slot it touches", () => {
    const timeOff = [interval("2026-10-27T09:15:00Z", "2026-10-27T09:45:00Z")]; // 10:15–10:45 local
    const slots = computeSlots(
      schedule(hours("09:00", "12:00")),
      timeOff,
      { from: date("2026-10-27"), to: date("2026-10-27") },
      longAgo,
    );
    expect(starts(slots)).toEqual(["2026-10-27T09:00:00+01:00", "2026-10-27T11:00:00+01:00"]);
  });

  test("only weekdays with opening hours have slots", () => {
    const weekdaysOnly = schedule(hours("09:00", "10:00", [1, 2, 3, 4, 5]));
    const slots = computeSlots(weekdaysOnly, [], { from: date("2026-10-30"), to: date("2026-11-02") }, longAgo);
    expect(starts(slots)).toEqual(["2026-10-30T09:00:00+01:00", "2026-11-02T09:00:00+01:00"]);
  });
});

describe("computeSlots and checkStart agree", () => {
  const crossMidnight = [
    { weekday: 1, opensAt: parseClock("18:00"), closesAt: parseClock("24:00") },
    { weekday: 2, opensAt: parseClock("00:00"), closesAt: parseClock("02:00") },
  ];
  const allDay = hours("00:00", "24:00");

  test("the grid never depends on the range asked for", () => {
    const sched = schedule(allDay, { durationMinutes: 90, slotIntervalMinutes: 90 });
    const tuesday = (from: string) =>
      starts(computeSlots(sched, [], { from: date(from), to: date("2026-10-27") }, longAgo)).filter((s) =>
        s.startsWith("2026-10-27"),
      );
    const asked = tuesday("2026-10-27");
    expect(asked).toEqual(tuesday("2026-10-24"));
    expect(asked[0]).toBe("2026-10-27T00:00:00+01:00");
    expect(asked[1]).toBe("2026-10-27T01:30:00+01:00");
    expect(asked).toHaveLength(16);
  });

  test("a slot that crosses midnight is offered and accepted", () => {
    const sched = schedule(crossMidnight, { durationMinutes: 90, slotIntervalMinutes: 30 });
    const monday = starts(computeSlots(sched, [], { from: date("2026-10-26"), to: date("2026-10-26") }, longAgo));
    expect(monday.at(-1)).toBe("2026-10-26T23:30:00+01:00");
    const at2300 = instant("2026-10-26T22:00:00Z");
    expect(checkStart(sched, [], at2300, longAgo, { customerRules: true })).toBeNull();
  });

  test("every slot offered can be booked under customer rules", () => {
    const schedules = [
      schedule(crossMidnight, { durationMinutes: 90, slotIntervalMinutes: 30 }),
      schedule(allDay, { durationMinutes: 90, slotIntervalMinutes: 90 }),
      schedule(hours("00:00", "06:00", [7]), { durationMinutes: 60, slotIntervalMinutes: 30 }),
      schedule(hours("08:00", "23:00"), { durationMinutes: 90, slotIntervalMinutes: 30, bufferAfterMinutes: 10 }),
    ];
    // A fortnight that contains the end of summer time (25 October 2026).
    for (const sched of schedules) {
      const slots = computeSlots(sched, [], { from: date("2026-10-19"), to: date("2026-11-01") }, longAgo);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        expect(checkStart(sched, [], slot.start, longAgo, { customerRules: true })).toBeNull();
      }
    }
  });
});

describe("checkStart", () => {
  const club = schedule(hours("08:00", "23:00"), { durationMinutes: 90, minNoticeMinutes: 60, maxAdvanceDays: 14 });
  const now = instant("2026-10-27T08:00:00Z"); // 09:00 in Madrid
  const customer = { customerRules: true };
  const staff = { customerRules: false };

  test("accepts a start on the grid inside opening hours", () => {
    expect(checkStart(club, [], instant("2026-10-27T18:30:00Z"), now, customer)).toBeNull();
  });

  test("rejects slots that end after closing time", () => {
    expect(checkStart(club, [], instant("2026-10-27T21:00:00Z"), now, customer)).toBe("outside_opening_hours");
  });

  test("customers must use the slot grid; staff may not", () => {
    const offGrid = instant("2026-10-27T18:10:00Z");
    expect(checkStart(club, [], offGrid, now, customer)).toBe("off_grid");
    expect(checkStart(club, [], offGrid, now, staff)).toBeNull();
  });

  test("customers must respect notice and advance limits; staff may not", () => {
    const inHalfAnHour = instant("2026-10-27T08:30:00Z");
    const inThreeWeeks = instant("2026-11-17T18:30:00Z");
    expect(checkStart(club, [], inHalfAnHour, now, customer)).toBe("too_soon");
    expect(checkStart(club, [], inThreeWeeks, now, customer)).toBe("too_far_ahead");
    expect(checkStart(club, [], inHalfAnHour, now, staff)).toBeNull();
  });

  test("nobody can book over time off", () => {
    const timeOff = [interval("2026-10-27T18:00:00Z", "2026-10-27T19:00:00Z")];
    expect(checkStart(club, timeOff, instant("2026-10-27T18:30:00Z"), now, staff)).toBe("time_off");
  });
});

describe("helpers", () => {
  test("mergeIntervals joins overlapping and touching intervals", () => {
    const merged = mergeIntervals([
      interval("2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z"),
      interval("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z"),
      interval("2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"),
      interval("2026-01-01T10:30:00Z", "2026-01-01T10:45:00Z"),
    ]);
    expect(merged.map((i) => `${i.start}/${i.end}`)).toEqual([
      "2026-01-01T09:00:00Z/2026-01-01T11:00:00Z",
      "2026-01-01T12:00:00Z/2026-01-01T13:00:00Z",
    ]);
  });

  test("parseClock and formatClock round-trip, 24:00 included", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("07:05")).toBe(425);
    expect(parseClock("24:00")).toBe(1440);
    expect(formatClock(1440)).toBe("24:00");
    expect(formatClock(425)).toBe("07:05");
    for (const bad of ["24:01", "7:00", "25:00", "12:60", "noon"]) expect(() => parseClock(bad)).toThrow(RangeError);
  });
});
