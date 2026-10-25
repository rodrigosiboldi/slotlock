import { ArrowRight, BookOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient, type DemoConfig, loadConfig } from "@/api";
import { GithubIcon } from "@/components/github-icon";
import { Button } from "@/components/ui/button";
import { detectLang, dictionaries, I18nContext, type Lang, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { CalendarSection } from "@/sections/calendar";
import { InternalsSection } from "@/sections/internals";
import { RaceSection } from "@/sections/race";
import { UsageSection } from "@/sections/usage";
import { WebhooksSection } from "@/sections/webhooks";

export function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const i18n = useMemo(
    () => ({
      lang,
      t: dictionaries[lang],
      setLang(next: Lang) {
        setLangState(next);
        try {
          localStorage.setItem("slotlock.lang", next);
        } catch {
          // not persisted; the choice still applies to this visit
        }
      },
    }),
    [lang],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch(() => setFailed(true));
  }, []);

  const client = useMemo(() => (config ? createClient(config) : null), [config]);

  return (
    <I18nContext.Provider value={i18n}>
      <Header repositoryUrl={config?.repositoryUrl} />
      <main>
        <Hero client={client} />
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-28 px-5 pb-28 sm:px-8">
          {config && client ? (
            <>
              <RaceSection client={client} timezone={config.timezone} />
              <CalendarSection client={client} config={config} />
              <WebhooksSection config={config} />
              <InternalsSection repositoryUrl={config.repositoryUrl} />
              <UsageSection client={client} config={config} />
            </>
          ) : (
            <p className="text-muted-foreground">{failed ? "The demo API did not answer." : ""}</p>
          )}
        </div>
      </main>
      <Footer repositoryUrl={config?.repositoryUrl} />
    </I18nContext.Provider>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-primary" />
      <rect x="7" y="9" width="8" height="6" rx="1.6" className="fill-primary-foreground" opacity="0.28" />
      <rect x="17" y="9" width="8" height="6" rx="1.6" className="fill-primary-foreground" />
      <rect x="7" y="17" width="8" height="6" rx="1.6" className="fill-primary-foreground" opacity="0.28" />
      <rect x="17" y="17" width="8" height="6" rx="1.6" className="fill-primary-foreground" opacity="0.28" />
    </svg>
  );
}

function Header({ repositoryUrl }: { repositoryUrl: string | undefined }) {
  const { t, lang, setLang } = useI18n();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo />
          <span className="text-lg">Slotlock</span>
        </a>
        <nav className="hidden items-center gap-1 text-sm text-muted-foreground md:flex" aria-label="Sections">
          {(["race", "calendar", "webhooks", "internals"] as const).map((id) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-md px-3 py-2 transition-colors duration-200 hover:bg-secondary hover:text-foreground"
            >
              {t.nav[id]}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <fieldset className="m-0 flex rounded-md border p-0.5 font-mono text-xs">
            <legend className="sr-only">Language</legend>
            {(["en", "es"] as const).map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={cn(
                  "rounded-[5px] px-2 py-1 uppercase transition-colors duration-200",
                  lang === code ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {code}
              </button>
            ))}
          </fieldset>
          {repositoryUrl && (
            <Button variant="ghost" size="icon" asChild>
              <a href={repositoryUrl} aria-label="GitHub">
                <GithubIcon className="size-4" />
              </a>
            </Button>
          )}
          <Button variant="outline" size="sm" asChild className="hidden sm:inline-flex">
            <a href="/docs">
              <BookOpen aria-hidden /> {t.nav.docs}
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Hero({ client }: { client: ReturnType<typeof createClient> | null }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"checking" | "down" | { latencyMs: number; constraint: boolean }>("checking");
  const [health, setHealth] = useState<{ ok: boolean; version: string; ms: number } | null>(null);

  useEffect(() => {
    if (!client) return;
    client
      .health()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, version: "", ms: 0 }));
    client
      .readiness()
      .then((ready) =>
        setStatus(
          ready ? { latencyMs: ready.database.latencyMs, constraint: ready.database.noOverlapConstraint } : "down",
        ),
      )
      .catch(() => setStatus("down"));
  }, [client]);

  return (
    <section id="top" className="relative overflow-hidden">
      <div className="court-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-end gap-12 px-5 pt-20 pb-24 sm:px-8 sm:pt-28 lg:grid-cols-[1.25fr_1fr]">
        <div>
          <p className="mb-6 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{t.hero.kicker}</p>
          <h1 className="text-balance text-5xl leading-[1.02] font-semibold tracking-[-0.03em] sm:text-6xl lg:text-7xl">
            {t.hero.title}
          </h1>
          <p className="mt-7 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
            {t.hero.lead}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <a href="#race">
                {t.hero.run} <ArrowRight aria-hidden />
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href="/docs">
                <BookOpen aria-hidden /> {t.hero.docs}
              </a>
            </Button>
          </div>
        </div>

        <div className="rounded-xl border bg-card/90 p-5 font-mono text-[13px] shadow-2xl shadow-black/40 backdrop-blur">
          <p className="mb-4 text-xs uppercase tracking-[0.16em] text-muted-foreground">{t.hero.status}</p>
          <StatusLine
            label="GET /healthz"
            value={health === null ? t.hero.checking : health.ok ? `200 · ${health.ms} ms` : t.hero.down}
            ok={health?.ok === true}
          />
          <StatusLine
            label="GET /readyz"
            value={
              status === "checking"
                ? t.hero.checking
                : status === "down"
                  ? t.hero.down
                  : `200 · ${t.hero.database} ${status.latencyMs} ms`
            }
            ok={typeof status === "object"}
          />
          <StatusLine
            label="bookings_no_overlap"
            value={typeof status === "object" && status.constraint ? "present" : "…"}
            ok={typeof status === "object" && status.constraint}
          />
          <pre className="mt-5 overflow-x-auto border-t pt-5 leading-relaxed text-muted-foreground">
            <span className="text-info-text">EXCLUDE USING</span> gist ({"\n"}
            {"  "}resource_id <span className="text-brand">WITH =</span>,{"\n"}
            {"  "}tstzrange(blocked_from, blocked_until){"\n"}
            {"    "}
            <span className="text-brand">WITH &amp;&amp;</span>
            {"\n"}) <span className="text-info-text">WHERE</span> status ={" "}
            <span className="text-success-text">'confirmed'</span>
          </pre>
        </div>
      </div>
    </section>
  );
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2.5">
        <span
          className={cn(
            "size-2 rounded-full",
            ok ? "bg-success" : "animate-[live-pulse_1.2s_ease-in-out_infinite] bg-muted-foreground",
          )}
          aria-hidden
        />
        {label}
      </span>
      <span className={ok ? "text-success-text" : "text-muted-foreground"}>{value}</span>
    </div>
  );
}

function Footer({ repositoryUrl }: { repositoryUrl: string | undefined }) {
  const { t } = useI18n();
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-10 text-sm text-muted-foreground sm:px-8">
        <p>
          {t.footer.built} {t.footer.reset}
        </p>
        <div className="flex gap-5">
          <a className="hover:text-foreground" href="/docs">
            {t.nav.docs}
          </a>
          <a className="hover:text-foreground" href="/openapi.json">
            OpenAPI 3.1
          </a>
          {repositoryUrl && (
            <a className="hover:text-foreground" href={repositoryUrl}>
              GitHub
            </a>
          )}
          <a className="hover:text-foreground" href="https://rodrigosiboldi.com">
            rodrigosiboldi.com
          </a>
        </div>
      </div>
    </footer>
  );
}
