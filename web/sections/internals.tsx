import {
  BookOpenCheck,
  Clock3,
  FileWarning,
  FlaskConical,
  Gauge,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Repeat2,
  Send,
} from "lucide-react";
import { useI18n } from "@/i18n";

interface Item {
  icon: LucideIcon;
  title: { en: string; es: string };
  body: { en: string; es: string };
  path: string;
}

const ITEMS: Item[] = [
  {
    icon: LockKeyhole,
    title: { en: "Overlap is impossible, not unlikely", es: "Solaparse es imposible, no improbable" },
    body: {
      en: "An exclusion constraint over (court, [start − buffer, end + buffer)) using btree_gist. It holds under any concurrency and for every code path, even writes that skip the API.",
      es: "Una restricción de exclusión sobre (pista, [inicio − margen, fin + margen)) con btree_gist. Se cumple con cualquier concurrencia y por cualquier camino, incluso escrituras que no pasan por la API.",
    },
    path: "drizzle/0001_booking_guarantees.sql",
  },
  {
    icon: Clock3,
    title: { en: "Time zones done right", es: "Zonas horarias bien hechas" },
    body: {
      en: "Opening hours are wall-clock times in each court's IANA zone, computed with the Temporal API. The night clocks go back, 02:30 happens twice — both are offered, with different offsets.",
      es: "Los horarios son horas de reloj en la zona IANA de cada pista, calculadas con la API Temporal. La noche del cambio de hora, las 02:30 ocurren dos veces y se ofrecen las dos, con distinto desfase.",
    },
    path: "src/domain/availability.ts",
  },
  {
    icon: Repeat2,
    title: { en: "Retries that can't duplicate", es: "Reintentos que no duplican" },
    body: {
      en: "Idempotency-Key on every POST, Stripe-style: the same key returns the same response for 24 h; the same key with a different body is refused.",
      es: "Idempotency-Key en cada POST, como Stripe: la misma clave devuelve la misma respuesta durante 24 h; la misma clave con otro cuerpo se rechaza.",
    },
    path: "src/services/idempotency.ts",
  },
  {
    icon: Send,
    title: { en: "Transactional outbox", es: "Outbox transaccional" },
    body: {
      en: "Events are written inside the booking's transaction. Dispatchers claim deliveries with FOR UPDATE SKIP LOCKED and retry with backoff: 30 s, 2 min, 10 min, 1 h, 6 h.",
      es: "Los eventos se escriben dentro de la transacción de la reserva. Los despachadores toman entregas con FOR UPDATE SKIP LOCKED y reintentan con espera creciente: 30 s, 2 min, 10 min, 1 h, 6 h.",
    },
    path: "src/services/webhooks.ts",
  },
  {
    icon: Gauge,
    title: { en: "Rate limits that scale out", es: "Límites que escalan" },
    body: {
      en: "A sliding-window counter kept in Postgres and updated in a single statement, so every serverless instance shares it. Standard RateLimit-* headers on every response.",
      es: "Un contador de ventana deslizante en Postgres, actualizado en una sola sentencia, compartido por todas las instancias serverless. Cabeceras RateLimit-* en cada respuesta.",
    },
    path: "src/services/rate-limit.ts",
  },
  {
    icon: FileWarning,
    title: { en: "Errors you can branch on", es: "Errores con los que se puede programar" },
    body: {
      en: "RFC 9457 problem+json with stable types, field-level validation errors and a request id that also appears in the structured logs.",
      es: "problem+json (RFC 9457) con tipos estables, errores por campo y un request id que también aparece en los logs estructurados.",
    },
    path: "src/lib/problem.ts",
  },
  {
    icon: BookOpenCheck,
    title: { en: "Documented by construction", es: "Documentada por construcción" },
    body: {
      en: "Zod schemas drive request validation, the TypeScript types and the OpenAPI 3.1 document. The reference is generated from the code, never written by hand.",
      es: "Los esquemas de Zod generan la validación, los tipos de TypeScript y el documento OpenAPI 3.1. La referencia sale del código, nunca se escribe a mano.",
    },
    path: "src/http/schemas.ts",
  },
  {
    icon: KeyRound,
    title: { en: "Secure by default", es: "Segura por defecto" },
    body: {
      en: "API keys stored as SHA-256 hashes, webhook secrets encrypted with AES-256-GCM, scopes per key, and webhook targets on private networks refused before and at delivery.",
      es: "Claves guardadas como hash SHA-256, secretos de webhooks cifrados con AES-256-GCM, permisos por clave y destinos en redes privadas rechazados al registrar y al entregar.",
    },
    path: "src/services/api-keys.ts",
  },
  {
    icon: FlaskConical,
    title: { en: "Tested where it hurts", es: "Probada donde duele" },
    body: {
      en: "Tests for both DST transitions, buffers, 100 simultaneous bookings, signatures and retries, SSRF guards — on a real Postgres (PGlite, in-process) in about ten seconds.",
      es: "Tests de los dos cambios de hora, márgenes, 100 reservas simultáneas, firmas y reintentos, protección SSRF, sobre un Postgres real (PGlite, en proceso) en unos diez segundos.",
    },
    path: "test",
  },
];

export function InternalsSection({ repositoryUrl }: { repositoryUrl: string }) {
  const { t, lang } = useI18n();
  return (
    <section id="internals" className="scroll-mt-24">
      <div className="mb-10 max-w-2xl">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-brand">04 · {t.nav.internals}</p>
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{t.internals.title}</h2>
        <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{t.internals.lead}</p>
      </div>
      <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map(({ icon: Icon, title, body, path }) => (
          <article key={path} className="flex flex-col gap-3 bg-card p-6 sm:p-7">
            <Icon className="size-5 text-brand" aria-hidden />
            <h3 className="text-lg font-semibold tracking-tight">{title[lang]}</h3>
            <p className="text-pretty leading-relaxed text-muted-foreground">{body[lang]}</p>
            <a
              href={`${repositoryUrl}/${path === "test" ? "tree" : "blob"}/main/${path}`}
              className="mt-auto w-fit pt-2 font-mono text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              {t.internals.source}: {path}
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
