import { BadgeCheck, CircleDot, ShieldAlert, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import type { DemoConfig } from "@/api";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatClockTime, formatWhen } from "@/time";
import { LivePill } from "./calendar";

interface FeedItem {
  kind: "event" | "webhook";
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
  signatureValid?: boolean;
}

interface Entry {
  key: string;
  type: string;
  bookingId: string | undefined;
  summary: { resourceId?: string; startsAt?: string; customer?: string };
  eventAt?: string;
  deliveredAt?: string;
  signatureValid?: boolean;
}

/** The demo's live log: outbox events as they are written, and webhook receipts as they arrive. */
export function WebhooksSection({ config }: { config: DemoConfig }) {
  const { t, lang } = useI18n();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const source = new EventSource("/demo/feed");
    source.addEventListener("open", () => setLive(true));
    source.addEventListener("error", () => setLive(false));
    const onItem = (message: MessageEvent<string>) => {
      const item = JSON.parse(message.data) as FeedItem;
      setEntries((current) => merge(current, item).slice(0, 14));
    };
    source.addEventListener("event", onItem as EventListener);
    source.addEventListener("webhook", onItem as EventListener);
    return () => source.close();
  }, []);

  const courtName = (id?: string) => config.courts.find((court) => court.id === id)?.name ?? "Center Court (race)";

  return (
    <section id="webhooks" className="scroll-mt-24">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-brand">
            <Webhook className="size-3.5" aria-hidden /> 03 · {t.nav.webhooks}
          </p>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t.webhooks.title}</h2>
          <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{t.webhooks.lead}</p>
        </div>
        <LivePill live={live} />
      </div>

      <Card className="gap-0 py-0">
        {entries.length === 0 ? (
          <p className="px-6 py-14 text-center text-muted-foreground">{t.webhooks.empty}</p>
        ) : (
          <ol className="divide-y">
            {entries.map((entry) => {
              const latency =
                entry.eventAt && entry.deliveredAt
                  ? Math.max(0, new Date(entry.deliveredAt).getTime() - new Date(entry.eventAt).getTime())
                  : null;
              return (
                <li
                  key={entry.key}
                  className="grid animate-[rise-in_350ms_var(--ease-out)] gap-2 px-5 py-4 sm:grid-cols-[7rem_11rem_1fr_auto] sm:items-center sm:gap-4 sm:px-6"
                >
                  <time className="font-mono text-xs text-muted-foreground">
                    {formatClockTime(entry.deliveredAt ?? entry.eventAt ?? new Date().toISOString(), lang)}
                  </time>
                  <span
                    className={cn(
                      "w-fit rounded-md px-2 py-0.5 font-mono text-xs",
                      entry.type === "booking.cancelled"
                        ? "bg-danger-subtle text-danger-text"
                        : "bg-success-subtle text-success-text",
                    )}
                  >
                    {entry.type}
                  </span>
                  <span className="min-w-0 truncate text-sm">
                    {courtName(entry.summary.resourceId)}
                    {entry.summary.startsAt && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {formatWhen(entry.summary.startsAt, config.timezone, lang)}
                      </span>
                    )}
                    {entry.summary.customer && (
                      <span className="text-muted-foreground"> · {entry.summary.customer}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    {entry.deliveredAt ? (
                      entry.signatureValid ? (
                        <span className="flex items-center gap-1.5 text-success-text">
                          <BadgeCheck className="size-4" aria-hidden />
                          {t.webhooks.delivered} · {t.webhooks.verified}
                          {latency !== null && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {t.webhooks.after} {latency} ms
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-danger-text">
                          <ShieldAlert className="size-4" aria-hidden />
                          {t.webhooks.invalid}
                        </span>
                      )
                    ) : (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <CircleDot className="size-4 animate-[live-pulse_1.2s_ease-in-out_infinite]" aria-hidden />
                        {t.webhooks.written}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </section>
  );
}

function merge(entries: Entry[], item: FeedItem): Entry[] {
  const data = (item.kind === "webhook" ? (item.data.data as Record<string, unknown> | undefined) : item.data) ?? {};
  const bookingId = typeof data.id === "string" ? data.id : undefined;
  const existing = entries.find((entry) => entry.bookingId === bookingId && entry.type === item.type);
  if (existing && bookingId) {
    return entries.map((entry) =>
      entry === existing
        ? item.kind === "webhook"
          ? { ...entry, deliveredAt: item.at, signatureValid: item.signatureValid }
          : { ...entry, eventAt: item.at }
        : entry,
    );
  }
  const customer = data.customer as { name?: string } | undefined;
  return [
    {
      key: item.id,
      type: item.type,
      bookingId,
      summary: {
        resourceId: typeof data.resourceId === "string" ? data.resourceId : undefined,
        startsAt: typeof data.startsAt === "string" ? data.startsAt : undefined,
        customer: customer?.name,
      },
      ...(item.kind === "event" ? { eventAt: item.at } : { deliveredAt: item.at, signatureValid: item.signatureValid }),
    },
    ...entries,
  ];
}
