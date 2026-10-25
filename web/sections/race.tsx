import { Flag, RotateCcw, Zap } from "lucide-react";
import { useRef, useState } from "react";
import type { Client, Race as RaceTicket } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatWhen } from "@/time";

type Outcome = "idle" | "pending" | "won" | "lost" | "error";

interface Result {
  winner: number | null;
  sample: { won?: unknown; lost?: unknown };
  ms: number;
}

const ATTEMPTS = 200;

export function RaceSection({ client, timezone }: { client: Client; timezone: string }) {
  const { t, lang } = useI18n();
  const [dots, setDots] = useState<Outcome[]>(() => Array(ATTEMPTS).fill("idle"));
  const [running, setRunning] = useState(false);
  const [race, setRace] = useState<RaceTicket | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const counts = dots.reduce(
    (acc, outcome) => {
      if (outcome !== "idle") acc.sent++;
      if (outcome === "won") acc.won++;
      if (outcome === "lost") acc.lost++;
      return acc;
    },
    { sent: 0, won: 0, lost: 0 },
  );

  async function run() {
    setRunning(true);
    setNotice(null);
    setResult(null);
    setShowRaw(false);
    setDots(Array(ATTEMPTS).fill("idle"));
    const started = await client.startRace();
    if (!started.race) {
      setNotice(started.status === 429 ? t.race.limited : t.race.failed);
      setRunning(false);
      return;
    }
    const ticket = started.race;
    setRace(ticket);
    setDots(Array(ATTEMPTS).fill("pending"));
    const t0 = performance.now();
    timer.current = window.setInterval(() => setElapsed(performance.now() - t0), 47);

    const sample: Result["sample"] = {};
    let winner: number | null = null;
    await Promise.all(
      Array.from({ length: ticket.attempts }, async (_, index) => {
        try {
          const response = await client.book({
            serviceId: ticket.serviceId,
            resourceId: ticket.resourceId,
            startsAt: ticket.startsAt,
            name: `Player ${index + 1}`,
            email: `player${index + 1}@example.com`,
            race: ticket.ticket,
          });
          const outcome: Outcome = response.status === 201 ? "won" : response.status === 409 ? "lost" : "error";
          if (outcome === "won") {
            winner = index + 1;
            sample.won = response.body;
          } else if (outcome === "lost" && !sample.lost) {
            sample.lost = response.body;
          }
          setDots((current) => {
            const next = [...current];
            next[index] = outcome;
            return next;
          });
        } catch {
          setDots((current) => {
            const next = [...current];
            next[index] = "error";
            return next;
          });
        }
      }),
    );
    window.clearInterval(timer.current);
    const ms = performance.now() - t0;
    setElapsed(ms);
    setResult({ winner, sample, ms });
    setRunning(false);
  }

  const finished = result !== null;
  const winnerName = result?.winner ? `Player ${result.winner}` : "—";

  return (
    <section id="race" className="scroll-mt-24">
      <div className="mb-8 max-w-2xl">
        <p className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-brand">
          <Zap className="size-3.5" aria-hidden /> 01 · {t.nav.race}
        </p>
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t.race.title}</h2>
        <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{t.race.lead}</p>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="grid grid-cols-1 gap-0 p-0 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="border-b p-5 sm:p-8 lg:border-r lg:border-b-0">
            <div
              className="grid grid-cols-[repeat(10,minmax(0,1fr))] gap-2 sm:grid-cols-[repeat(20,minmax(0,1fr))]"
              role="img"
              aria-label={`${counts.won} ${t.race.accepted}, ${counts.lost} ${t.race.refused}`}
            >
              {dots.map((outcome, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the 200 dots are fixed positions
                  key={index}
                  title={`Player ${index + 1}`}
                  className={cn(
                    "aspect-square rounded-full border transition-[background-color,border-color,transform,opacity] duration-300 ease-[var(--ease-out)]",
                    outcome === "idle" && "border-border bg-transparent",
                    outcome === "pending" && "animate-[live-pulse_1.1s_ease-in-out_infinite] border-input bg-input",
                    outcome === "lost" && "border-transparent bg-danger/60",
                    outcome === "error" && "border-transparent bg-muted-foreground/40",
                    outcome === "won" &&
                      "z-10 scale-[1.35] border-transparent bg-primary animate-[winner-ring_1.4s_var(--ease-out)_3]",
                  )}
                />
              ))}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" onClick={run} disabled={running} className="min-w-44">
                {running ? (
                  t.race.running
                ) : finished ? (
                  <>
                    <RotateCcw aria-hidden /> {t.race.again}
                  </>
                ) : (
                  <>
                    <Flag aria-hidden /> {t.race.start}
                  </>
                )}
              </Button>
              {race && (
                <span className="font-mono text-sm text-muted-foreground">
                  Center Court · {formatWhen(race.startsAt, timezone, lang)}
                </span>
              )}
            </div>
            {notice && <p className="mt-4 text-sm text-danger-text">{notice}</p>}
          </div>

          <dl className="grid grid-cols-2 gap-px bg-border lg:grid-cols-1 lg:grid-rows-4">
            <Stat label={t.race.sent} value={counts.sent} />
            <Stat label={t.race.accepted} value={counts.won} tone="success" />
            <Stat label={t.race.refused} value={counts.lost} tone="danger" />
            <Stat label={t.race.time} value={`${(elapsed / 1000).toFixed(2)} s`} />
          </dl>
        </CardContent>

        {finished && (
          <div className="animate-[rise-in_400ms_var(--ease-out)] border-t bg-secondary/50 p-5 sm:p-8">
            <p className="max-w-3xl text-pretty text-lg leading-relaxed">{t.race.winner(winnerName, counts.lost)}</p>
            <p className="mt-3 max-w-3xl text-pretty leading-relaxed text-muted-foreground">{t.race.noEvents}</p>
            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <p className="mb-3 text-sm text-muted-foreground">{t.race.how}</p>
                <pre className="overflow-x-auto rounded-lg border bg-background p-4 font-mono text-[13px] leading-relaxed">
                  <code>
                    <span className="text-info-text">ALTER TABLE</span> bookings{"\n"}
                    {"  "}
                    <span className="text-info-text">ADD CONSTRAINT</span> bookings_no_overlap{"\n"}
                    {"  "}
                    <span className="text-info-text">EXCLUDE USING</span> gist ({"\n"}
                    {"    "}resource_id <span className="text-brand">WITH =</span>,{"\n"}
                    {"    "}tstzrange(blocked_from, blocked_until, <span className="text-success-text">'[)'</span>){" "}
                    <span className="text-brand">WITH &amp;&amp;</span>
                    {"\n"}
                    {"  "}) <span className="text-info-text">WHERE</span> (status ={" "}
                    <span className="text-success-text">'confirmed'</span>);
                  </code>
                </pre>
              </div>
              <div>
                <Button variant="outline" size="sm" onClick={() => setShowRaw((value) => !value)}>
                  {showRaw ? t.race.hideRaw : t.race.raw}
                </Button>
                {showRaw && (
                  <div className="mt-3 grid gap-3">
                    <RawResponse status="201 Created" tone="success" body={result.sample.won} />
                    <RawResponse status="409 Conflict" tone="danger" body={result.sample.lost} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "success" | "danger" }) {
  return (
    <div className="bg-card p-5 sm:px-8 sm:py-6">
      <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular mt-1 font-mono text-3xl font-medium tracking-tight",
          tone === "success" && "text-success-text",
          tone === "danger" && "text-danger-text",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function RawResponse({ status, tone, body }: { status: string; tone: "success" | "danger"; body: unknown }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div
        className={cn(
          "border-b px-4 py-2 font-mono text-xs",
          tone === "success" ? "text-success-text" : "text-danger-text",
        )}
      >
        {status}
      </div>
      <pre className="max-h-64 overflow-auto p-4 font-mono text-xs leading-relaxed text-muted-foreground">
        {JSON.stringify(body, null, 2)}
      </pre>
    </div>
  );
}
