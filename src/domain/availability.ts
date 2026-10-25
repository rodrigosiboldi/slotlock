/**
 * Availability: at which instants can a service start on a resource?
 *
 * Pure functions over Temporal values: no clock, no database, no I/O. Opening hours are wall-clock
 * times in the resource's zone; bookings and time off are absolute instants. Temporal resolves the
 * daylight-saving edge cases: on the night clocks go back, a 00:00–06:00 window lasts seven real
 * hours and 02:30 happens twice (both are offered, with different offsets); on the night they go
 * forward, 02:30 does not exist and a window opening then opens at 03:30.
 */

export interface OpeningHours {
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
  /** Minutes after local midnight, 0–1439. */
  opensAt: number;
  /** Minutes after local midnight, 1–1440 (1440 = midnight at the end of the day). */
  closesAt: number;
}

/** Half-open interval [start, end). */
export interface Interval {
  start: Temporal.Instant;
  end: Temporal.Instant;
}

export interface ServiceTiming {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
}

export interface Schedule {
  timezone: string;
  openingHours: OpeningHours[];
  service: ServiceTiming;
}

/** Longest range a single availability query may cover, in days. */
export const MAX_RANGE_DAYS = 31;

/**
 * Every bookable slot starting on a local date in [from, to] (inclusive): inside opening hours,
 * on the slot grid, outside every busy interval once buffers are added, and within the
 * minimum-notice and maximum-advance limits.
 *
 * `busy` holds the blocked intervals of confirmed bookings (buffers included) and time off.
 */
export function computeSlots(
  schedule: Schedule,
  busy: Interval[],
  range: { from: Temporal.PlainDate; to: Temporal.PlainDate },
  now: Temporal.Instant,
): Interval[] {
  const { service } = schedule;
  const earliest = now.add({ minutes: service.minNoticeMinutes });
  const latest = latestStart(schedule, now);
  const blocked = mergeIntervals(busy);
  const lastStartDate = range.to.add({ days: 1 });
  const slots: Interval[] = [];
  let cursor = 0; // index into `blocked`; candidate starts only move forward

  // Windows that started the day before `from` can still hold slots starting on `from`.
  for (const window of openingWindows(schedule, range.from.subtract({ days: 1 }), range.to)) {
    for (
      let start = window.start;
      Temporal.Instant.compare(start.add({ minutes: service.durationMinutes }), window.end) <= 0;
      start = start.add({ minutes: service.slotIntervalMinutes })
    ) {
      const localDate = start.toZonedDateTimeISO(schedule.timezone).toPlainDate();
      if (Temporal.PlainDate.compare(localDate, range.from) < 0) continue;
      if (Temporal.PlainDate.compare(localDate, lastStartDate) >= 0) break;
      if (Temporal.Instant.compare(start, earliest) < 0) continue;
      if (Temporal.Instant.compare(start, latest) > 0) break;

      const slot = { start, end: start.add({ minutes: service.durationMinutes }) };
      const guard = blockedInterval(slot, service);
      while (cursor < blocked.length && Temporal.Instant.compare((blocked[cursor] as Interval).end, guard.start) <= 0) {
        cursor++;
      }
      const next = blocked[cursor];
      if (next && Temporal.Instant.compare(next.start, guard.end) < 0) continue;
      slots.push(slot);
    }
  }
  return slots;
}

export type StartProblem = "outside_opening_hours" | "off_grid" | "too_soon" | "too_far_ahead" | "time_off";

/**
 * Why a requested start is not acceptable, or null if it is. Customer rules (slot grid, minimum
 * notice, maximum advance) apply to publishable keys only; staff with a secret key may book any
 * time the resource is open. Overlap with other bookings is deliberately not checked here: the
 * database's exclusion constraint is the single judge of that.
 */
export function checkStart(
  schedule: Schedule,
  timeOff: Interval[],
  start: Temporal.Instant,
  now: Temporal.Instant,
  options: { customerRules: boolean },
): StartProblem | null {
  const { service } = schedule;
  const slot = { start, end: start.add({ minutes: service.durationMinutes }) };
  const localDate = start.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const window = openingWindows(schedule, localDate.subtract({ days: 1 }), localDate).find((w) => contains(w, slot));
  if (!window) return "outside_opening_hours";

  if (options.customerRules) {
    const minutesFromOpening = window.start.until(start).total({ unit: "minutes" });
    if (!Number.isInteger(minutesFromOpening / service.slotIntervalMinutes)) return "off_grid";
    if (Temporal.Instant.compare(start, now.add({ minutes: service.minNoticeMinutes })) < 0) return "too_soon";
    if (Temporal.Instant.compare(start, latestStart(schedule, now)) > 0) return "too_far_ahead";
  }
  const guard = blockedInterval(slot, service);
  if (timeOff.some((interval) => overlaps(interval, guard))) return "time_off";
  return null;
}

/** The interval a booking keeps its resource busy: the slot widened by the service's buffers. */
export function blockedInterval(
  slot: Interval,
  service: Pick<ServiceTiming, "bufferBeforeMinutes" | "bufferAfterMinutes">,
): Interval {
  return {
    start: slot.start.subtract({ minutes: service.bufferBeforeMinutes }),
    end: slot.end.add({ minutes: service.bufferAfterMinutes }),
  };
}

/**
 * Opening hours as absolute intervals for every local date in [from, to]. Windows that touch
 * (Monday 22:00–24:00 and Tuesday 00:00–02:00) merge into one, so a booking can cross midnight.
 */
export function openingWindows(
  schedule: Pick<Schedule, "timezone" | "openingHours">,
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): Interval[] {
  const windows: Interval[] = [];
  for (let date = from; Temporal.PlainDate.compare(date, to) <= 0; date = date.add({ days: 1 })) {
    for (const hours of schedule.openingHours) {
      if (hours.weekday !== date.dayOfWeek) continue;
      const start = wallClock(date, hours.opensAt, schedule.timezone);
      const end = wallClock(date, hours.closesAt, schedule.timezone);
      if (Temporal.Instant.compare(start, end) < 0) windows.push({ start, end });
    }
  }
  return mergeIntervals(windows);
}

/** Sorts intervals and merges the ones that overlap or touch. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => Temporal.Instant.compare(a.start, b.start));
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && Temporal.Instant.compare(interval.start, last.end) <= 0) {
      if (Temporal.Instant.compare(interval.end, last.end) > 0) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** "HH:MM" (00:00–24:00) to minutes after midnight. */
export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
  if (!match) throw new RangeError(`Invalid time of day: ${value}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > 1440) throw new RangeError(`Invalid time of day: ${value}`);
  return minutes;
}

/** Minutes after midnight to "HH:MM". */
export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function wallClock(date: Temporal.PlainDate, minuteOfDay: number, timeZone: string): Temporal.Instant {
  // "compatible" disambiguation: a time inside a spring-forward gap moves forward by the gap's
  // length; a repeated time during fall-back resolves to the earlier instant (as RFC 5545 does).
  if (minuteOfDay === 1440) return date.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant();
  const plainTime = new Temporal.PlainTime(Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  return date.toZonedDateTime({ timeZone, plainTime }).toInstant();
}

function latestStart(schedule: Schedule, now: Temporal.Instant): Temporal.Instant {
  return now.toZonedDateTimeISO(schedule.timezone).add({ days: schedule.service.maxAdvanceDays }).toInstant();
}

function overlaps(a: Interval, b: Interval): boolean {
  return Temporal.Instant.compare(a.start, b.end) < 0 && Temporal.Instant.compare(b.start, a.end) < 0;
}

function contains(outer: Interval, inner: Interval): boolean {
  return Temporal.Instant.compare(outer.start, inner.start) <= 0 && Temporal.Instant.compare(inner.end, outer.end) <= 0;
}
