import { CalendarDays } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Client, type DemoConfig, type OpeningHours, type Problem, type Slot, subscribe } from "@/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { addDays, clockOf, dayLabel, formatWhen, fromMinutes, todayIn, toMinutes, weekdayOf } from "@/time";

const STEP = 30;
const MATCH_MINUTES = 90;
const BUFFER_MINUTES = 10;
const DAYS = 7;

interface Mine {
  resourceId: string;
  start: string;
}

export function CalendarSection({ client, config }: { client: Client; config: DemoConfig }) {
  const { t, lang } = useI18n();
  const today = useMemo(() => todayIn(config.timezone), [config.timezone]);
  const [date, setDate] = useState(today);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [hours, setHours] = useState<Map<string, OpeningHours[]>>(new Map());
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ resourceId: string; start: number } | null>(null);
  const [pending, setPending] = useState<Slot | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [mine, setMine] = useState<Mine[]>(() => readMine());
  const dateRef = useRef(date);
  dateRef.current = date;

  const refresh = useCallback(
    async (which = dateRef.current) => {
      const next = await client.availability(which);
      if (which === dateRef.current) setSlots(next);
    },
    [client],
  );

  useEffect(() => {
    void client.openingHours().then(setHours);
  }, [client]);

  // Late in the evening today has nothing left to book: open on tomorrow instead.
  useEffect(() => {
    void client.availability(today).then((slots) => {
      if (slots.length < 4 && dateRef.current === today) setDate(addDays(today, 1));
    });
  }, [client, today]);

  useEffect(() => {
    setSlots(null);
    void refresh(date);
  }, [date, refresh]);

  // Two tabs, one calendar: every booking anywhere pushes an event down this stream.
  useEffect(
    () =>
      subscribe(
        `/v1/availability/stream?serviceId=${config.matchServiceId}`,
        { headers: client.headers() },
        {
          state: setLive,
          event: (name, data) => {
            if (name !== "availability.changed") return;
            const { resourceIds } = JSON.parse(data) as { resourceIds: string[] };
            setFlash(new Set(resourceIds));
            window.setTimeout(() => setFlash(new Set()), 1200);
            void refresh();
          },
        },
      ),
    [client, config.matchServiceId, refresh],
  );

  const rows = useMemo(() => {
    const anyCourt = config.courts[0];
    const day = (anyCourt ? hours.get(anyCourt.id) : undefined)?.filter((h) => h.weekday === weekdayOf(date)) ?? [];
    if (day.length === 0) return [];
    const opens = Math.min(...day.map((h) => toMinutes(h.opensAt)));
    const closes = Math.max(...day.map((h) => toMinutes(h.closesAt)));
    return Array.from({ length: Math.max(0, (closes - opens) / STEP) }, (_, i) => opens + i * STEP);
  }, [hours, date, config.courts]);

  const free = useMemo(() => {
    const set = new Set<string>();
    for (const slot of slots ?? []) set.add(`${slot.resourceId}@${toMinutes(clockOf(slot.start))}`);
    return set;
  }, [slots]);

  const mineToday = useMemo(() => {
    const set = new Set<string>();
    for (const booking of mine) {
      if (booking.start.slice(0, 10) !== date) continue;
      const start = toMinutes(clockOf(booking.start));
      for (let m = start; m < start + MATCH_MINUTES; m += STEP) set.add(`${booking.resourceId}@${m}`);
    }
    return set;
  }, [mine, date]);

  async function confirm(name: string, email: string) {
    if (!pending) return;
    const court = config.courts.find((c) => c.id === pending.resourceId)?.name ?? "";
    const when = formatWhen(pending.start, config.timezone, lang);
    const response = await client.book({ resourceId: pending.resourceId, startsAt: pending.start, name, email });
    setPending(null);
    if (response.status === 201) {
      const next = [...mine, { resourceId: pending.resourceId, start: pending.start }];
      setMine(next);
      writeMine(next);
      setMessage({ tone: "success", text: t.calendar.booked(court, when) });
    } else {
      const problem = response.body as Problem | null;
      setMessage({ tone: "danger", text: problem?.status === 409 ? t.calendar.lost : t.calendar.rejected });
    }
    void refresh();
  }

  return (
    <section id="calendar" className="scroll-mt-24">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-brand">
            <CalendarDays className="size-3.5" aria-hidden /> 02 · {t.nav.calendar}
          </p>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t.calendar.title}</h2>
          <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{t.calendar.lead}</p>
        </div>
        <LivePill live={live} />
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex gap-1 overflow-x-auto border-b p-2" role="tablist" aria-label={t.calendar.title}>
          {Array.from({ length: DAYS }, (_, offset) => {
            const value = addDays(today, offset);
            const label = dayLabel(value, lang);
            const active = value === date;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setDate(value)}
                className={cn(
                  "flex min-w-20 flex-col items-start rounded-md px-3 py-2 text-left transition-colors duration-200 ease-[var(--ease-out)]",
                  active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60",
                )}
              >
                <span className="text-xs uppercase tracking-wider">{label.weekday}</span>
                <span className="font-medium">{label.day}</span>
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <div
            className="grid min-w-[560px]"
            style={{ gridTemplateColumns: `4.5rem repeat(${config.courts.length}, minmax(0, 1fr))` }}
          >
            <div className="sticky left-0 border-b bg-card" />
            {config.courts.map((court) => (
              <div
                key={court.id}
                className={cn(
                  "border-b border-l px-3 py-3 text-sm font-medium transition-colors duration-700",
                  flash.has(court.id) && "bg-primary/10",
                )}
              >
                {court.name}
              </div>
            ))}
            {rows.map((minute) => (
              <Row
                key={minute}
                minute={minute}
                courts={config.courts}
                free={free}
                mine={mineToday}
                hover={hover}
                loading={slots === null}
                onHover={setHover}
                onPick={(resourceId) => {
                  const slot = slots?.find(
                    (s) => s.resourceId === resourceId && toMinutes(clockOf(s.start)) === minute,
                  );
                  if (slot) setPending(slot);
                }}
                bookLabel={t.calendar.book}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-5 text-muted-foreground">
            <Legend className="border border-success/70 bg-success-subtle" label={t.calendar.free} />
            <Legend className="bg-muted" label={t.calendar.taken} />
            <Legend className="bg-primary" label={t.calendar.yours} />
          </div>
          <p className="text-muted-foreground">{t.calendar.hint}</p>
        </div>
      </Card>

      {message && (
        <p
          role="status"
          className={cn(
            "mt-4 animate-[rise-in_300ms_var(--ease-out)] text-sm",
            message.tone === "success" ? "text-success-text" : "text-danger-text",
          )}
        >
          {message.text}
        </p>
      )}

      <BookingDialog
        slot={pending}
        courtName={config.courts.find((c) => c.id === pending?.resourceId)?.name ?? ""}
        when={pending ? formatWhen(pending.start, config.timezone, lang) : ""}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </section>
  );
}

function Row(props: {
  minute: number;
  courts: { id: string; name: string }[];
  free: Set<string>;
  mine: Set<string>;
  hover: { resourceId: string; start: number } | null;
  loading: boolean;
  onHover(value: { resourceId: string; start: number } | null): void;
  onPick(resourceId: string): void;
  bookLabel: string;
}) {
  const { minute, courts, free, mine, hover, loading } = props;
  const onTheHour = minute % 60 === 0;
  return (
    <>
      <div
        className={cn(
          "sticky left-0 bg-card px-3 py-1 text-right font-mono text-xs text-muted-foreground",
          onTheHour && "border-t",
        )}
      >
        {onTheHour ? fromMinutes(minute) : ""}
      </div>
      {courts.map((court) => {
        const key = `${court.id}@${minute}`;
        const isFree = free.has(key);
        const isMine = mine.has(key);
        const inPreview =
          hover?.resourceId === court.id && minute >= hover.start && minute < hover.start + MATCH_MINUTES;
        const inBufferPreview =
          hover?.resourceId === court.id &&
          minute >= hover.start + MATCH_MINUTES &&
          minute < hover.start + MATCH_MINUTES + BUFFER_MINUTES;
        return (
          <div key={key} className={cn("border-l p-0.5", onTheHour && "border-t")}>
            {isFree ? (
              <button
                type="button"
                aria-label={`${props.bookLabel} ${court.name} ${fromMinutes(minute)}`}
                onMouseEnter={() => props.onHover({ resourceId: court.id, start: minute })}
                onMouseLeave={() => props.onHover(null)}
                onFocus={() => props.onHover({ resourceId: court.id, start: minute })}
                onBlur={() => props.onHover(null)}
                onClick={() => props.onPick(court.id)}
                className={cn(
                  "group flex h-6 w-full items-center rounded-[5px] border border-success/45 bg-success-subtle px-2 text-left font-mono text-[11px] text-success-text transition-[background-color,border-color] duration-150 ease-[var(--ease-out)] hover:border-success focus-visible:outline-2",
                  inPreview && "border-primary bg-primary/20 text-foreground",
                )}
              >
                <span className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                  {fromMinutes(minute)}
                </span>
              </button>
            ) : (
              <div
                className={cn(
                  "h-6 rounded-[5px]",
                  loading ? "animate-[live-pulse_1.4s_ease-in-out_infinite] bg-muted/50" : "bg-muted/60",
                  isMine && "bg-primary",
                  (inPreview || inBufferPreview) && !isMine && "bg-primary/25",
                )}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function BookingDialog(props: {
  slot: Slot | null;
  courtName: string;
  when: string;
  onCancel(): void;
  onConfirm(name: string, email: string): Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("Demo visitor");
  const [email, setEmail] = useState("visitor@example.com");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.slot !== null} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            await props.onConfirm(name, email);
            setBusy(false);
          }}
          className="grid gap-5"
        >
          <DialogHeader>
            <DialogTitle>{t.calendar.dialogTitle(props.courtName, props.when)}</DialogTitle>
            <DialogDescription>{t.calendar.dialogLead}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="book-name">{t.calendar.name}</Label>
            <Input id="book-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="book-email">{t.calendar.email}</Label>
            <Input
              id="book-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              {t.calendar.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {t.calendar.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className={cn("inline-block size-3.5 rounded-[4px]", className)} aria-hidden />
      {label}
    </span>
  );
}

export function LivePill({ live }: { live: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs uppercase tracking-wider",
        live ? "border-success/40 text-success-text" : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          live ? "animate-[live-pulse_1.6s_ease-in-out_infinite] bg-success" : "bg-muted-foreground",
        )}
        aria-hidden
      />
      {live ? t.calendar.live : t.calendar.reconnecting}
    </span>
  );
}

function readMine(): Mine[] {
  try {
    return JSON.parse(sessionStorage.getItem("slotlock.mine") ?? "[]") as Mine[];
  } catch {
    return [];
  }
}

function writeMine(value: Mine[]): void {
  try {
    sessionStorage.setItem("slotlock.mine", JSON.stringify(value));
  } catch {
    // storage unavailable: "yours" highlighting just won't survive a reload
  }
}
