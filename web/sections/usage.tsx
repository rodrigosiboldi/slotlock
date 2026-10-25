import { Check, Copy, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Client, DemoConfig, Slot } from "@/api";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { addDays, todayIn } from "@/time";

export function UsageSection({ client, config }: { client: Client; config: DemoConfig }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const date = addDays(todayIn(config.timezone), 2);
  // A slot that is actually free, so the first run of the snippet succeeds and the second gets 409.
  const [example, setExample] = useState<Slot | null>(null);
  useEffect(() => {
    void client.availability(date).then((slots) => setExample(slots.at(-1) ?? null));
  }, [client, date]);
  const resourceId = example?.resourceId ?? config.courts[0]?.id ?? "";
  const startsAt = example?.start ?? `${date}T20:00:00+01:00`;
  const script = [
    `export SLOTLOCK=${config.publicUrl}`,
    `export KEY=${config.publishableKey}`,
    "",
    `# What's free on ${date}?`,
    `curl -s "$SLOTLOCK/v1/availability?serviceId=${config.matchServiceId}&from=${date}" \\`,
    `  -H "Authorization: Bearer $KEY"`,
    "",
    "# Book it. Run this twice: the second answer is 409 slot-unavailable.",
    `curl -s "$SLOTLOCK/v1/bookings" -H "Authorization: Bearer $KEY" \\`,
    `  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \\`,
    `  -d '{"serviceId":"${config.matchServiceId}","resourceId":"${resourceId}",`,
    `       "startsAt":"${startsAt}","customer":{"name":"Ada","email":"ada@example.com"}}'`,
  ].join("\n");

  return (
    <section id="usage" className="scroll-mt-24">
      <div className="mb-8 max-w-2xl">
        <p className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-brand">
          <Terminal className="size-3.5" aria-hidden /> 05 · curl
        </p>
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t.usage.title}</h2>
        <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{t.usage.lead}</p>
      </div>
      <div className="relative overflow-hidden rounded-xl border bg-card">
        <Button
          variant="outline"
          size="sm"
          className="absolute top-3 right-3"
          onClick={async () => {
            await navigator.clipboard.writeText(script);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t.usage.copied : t.usage.copy}
        </Button>
        <pre className="overflow-x-auto p-6 pr-28 font-mono text-[13px] leading-relaxed">
          <code>
            {script.split("\n").map((line, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: static lines
                key={index}
                className={line.startsWith("#") ? "text-muted-foreground" : undefined}
              >
                {line}
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </section>
  );
}
