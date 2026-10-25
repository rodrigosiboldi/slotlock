import type { Lang } from "@/i18n";

/** Date helpers for the page. API times carry their offset, so wall-clock parts are read as-is. */

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

export function addDays(date: string, days: number): string {
  const noon = new Date(`${date}T12:00:00Z`);
  noon.setUTCDate(noon.getUTCDate() + days);
  return noon.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function dayLabel(date: string, lang: Lang): { weekday: string; day: string } {
  const value = new Date(`${date}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: "UTC" }).format(value),
    day: new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", timeZone: "UTC" }).format(value),
  };
}

/** "HH:MM" of an RFC 3339 time with offset, as written (the resource's local time). */
export function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

export function toMinutes(clock: string): number {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

export function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatWhen(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: new Date(iso).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatClockTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(
    new Date(iso),
  );
}
