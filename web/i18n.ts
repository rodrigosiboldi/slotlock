import { createContext, useContext } from "react";

export type Lang = "en" | "es";

const en = {
  nav: {
    race: "The race",
    calendar: "Live calendar",
    webhooks: "Webhooks",
    internals: "Under the hood",
    docs: "API reference",
  },
  hero: {
    kicker: "Booking API · Hono · Bun · TypeScript · PostgreSQL",
    title: "The booking API that can't double-book.",
    lead: "Two people can't book the same court at the same time — and here it isn't application code that stops them, it's Postgres itself. Every panel on this page talks to the live API. Try to break it.",
    run: "Run the race",
    docs: "Read the API reference",
    status: "Live status",
    api: "API",
    database: "Postgres",
    constraint: "no-overlap constraint",
    checking: "checking…",
    down: "unreachable",
  },
  race: {
    title: "200 players. One court. One moment.",
    lead: "Press start and your browser fires 200 real booking requests at the same slot, all at once. Open DevTools → Network if you want to watch them leave.",
    start: "Start the race",
    again: "Run it again",
    running: "Racing…",
    sent: "Sent",
    accepted: "Accepted",
    refused: "Refused",
    time: "Time",
    winner: (name: string, refused: number) =>
      `${name} got the court. The other ${refused} were refused by Postgres: the exclusion constraint answered 23P01 and the API turned it into 409 slot-unavailable.`,
    noEvents:
      "And none of the refused requests left a trace: their transactions rolled back, so the outbox — and the webhook log below — only ever saw the winner.",
    how: "No locks and no “check, then insert” in application code. The table itself forbids overlapping confirmed bookings:",
    raw: "Show the raw responses",
    hideRaw: "Hide the raw responses",
    limited: "Easy — that's a lot of races. Try again in a minute.",
    failed: "Something went wrong reaching the API.",
  },
  calendar: {
    title: "Live calendar",
    lead: "Free start times for a 90-minute match at the demo club, straight from GET /v1/availability. Open this page in a second tab and book here: the other tab updates within a second, over Server-Sent Events.",
    live: "Live",
    reconnecting: "Reconnecting",
    free: "Free start",
    taken: "Unavailable",
    yours: "Yours",
    hint: "Times in Madrid (Europe/Madrid). Each match is 90 minutes plus 10 minutes of court cleanup.",
    book: "Book",
    dialogTitle: (court: string, when: string) => `Book ${court} · ${when}`,
    dialogLead: "A real booking on the demo club. It vanishes when the club resets tonight.",
    name: "Name",
    email: "Email",
    confirm: "Confirm booking",
    cancel: "Cancel",
    booked: (court: string, when: string) => `Booked: ${court}, ${when}.`,
    lost: "Too late — someone took that slot a moment ago.",
    rejected: "That slot can't be booked anymore.",
    changed: "Updated just now",
  },
  webhooks: {
    title: "Webhooks, signed and delivered",
    lead: "Every booking writes an event to an outbox in the same transaction. A dispatcher signs it (Standard Webhooks, HMAC-SHA256) and delivers it — here, to a receiver on this same server that verifies the signature like yours would.",
    empty: "Waiting for the next booking. Make one in the calendar, or run the race.",
    written: "event written",
    delivered: "delivered",
    verified: "signature verified",
    invalid: "signature invalid",
    after: "after",
  },
  internals: {
    title: "Under the hood",
    lead: "What it takes for a booking system to be correct when it's busy, explained by where it lives in the code.",
    source: "Source",
  },
  usage: {
    title: "Try it from your terminal",
    lead: "This is the demo club's publishable key. It's safe to share: it can only read the catalogue and availability, and book.",
    copy: "Copy",
    copied: "Copied",
  },
  footer: {
    built: "Built by Rodrigo Siboldi with Hono, Bun, TypeScript and PostgreSQL.",
    reset: "The demo club resets every night.",
  },
};

type Dictionary = typeof en;

const es: Dictionary = {
  nav: {
    race: "La carrera",
    calendar: "Calendario en vivo",
    webhooks: "Webhooks",
    internals: "Por dentro",
    docs: "Referencia de la API",
  },
  hero: {
    kicker: "API de reservas · Hono · Bun · TypeScript · PostgreSQL",
    title: "La API de reservas que no puede reservar dos veces.",
    lead: "Dos personas no pueden reservar la misma pista a la misma hora, y aquí no lo impide el código de la aplicación: lo impide Postgres. Todo lo que ves en esta página habla con la API real. Intenta romperla.",
    run: "Correr la carrera",
    docs: "Ver la referencia de la API",
    status: "Estado en vivo",
    api: "API",
    database: "Postgres",
    constraint: "restricción anti-solapamiento",
    checking: "comprobando…",
    down: "sin respuesta",
  },
  race: {
    title: "200 jugadores. Una pista. El mismo instante.",
    lead: "Pulsa empezar y tu navegador lanza 200 peticiones reales de reserva al mismo turno, todas a la vez. Abre DevTools → Red si quieres verlas salir.",
    start: "Empezar la carrera",
    again: "Otra vez",
    running: "Corriendo…",
    sent: "Enviadas",
    accepted: "Aceptadas",
    refused: "Rechazadas",
    time: "Tiempo",
    winner: (name: string, refused: number) =>
      `${name} se quedó con la pista. Postgres rechazó las otras ${refused}: la restricción de exclusión respondió 23P01 y la API lo convirtió en 409 slot-unavailable.`,
    noEvents:
      "Y ninguna de las rechazadas dejó rastro: sus transacciones se deshicieron, así que el outbox (y el registro de webhooks de abajo) solo vio a la ganadora.",
    how: "Sin bloqueos ni «comprobar y luego insertar» en el código. La propia tabla prohíbe que se solapen dos reservas confirmadas:",
    raw: "Ver las respuestas tal cual",
    hideRaw: "Ocultar las respuestas",
    limited: "Calma: son muchas carreras seguidas. Prueba otra vez en un minuto.",
    failed: "Algo falló al hablar con la API.",
  },
  calendar: {
    title: "Calendario en vivo",
    lead: "Horarios libres para un partido de 90 minutos en el club de prueba, directos de GET /v1/availability. Abre esta página en otra pestaña y reserva aquí: la otra se actualiza en menos de un segundo, por Server-Sent Events.",
    live: "En vivo",
    reconnecting: "Reconectando",
    free: "Libre",
    taken: "No disponible",
    yours: "Tuya",
    hint: "Horas de Madrid (Europe/Madrid). Cada partido dura 90 minutos más 10 de limpieza de la pista.",
    book: "Reservar",
    dialogTitle: (court: string, when: string) => `Reservar ${court} · ${when}`,
    dialogLead: "Una reserva real en el club de prueba. Desaparece cuando el club se reinicia esta noche.",
    name: "Nombre",
    email: "Email",
    confirm: "Confirmar reserva",
    cancel: "Cancelar",
    booked: (court: string, when: string) => `Reservado: ${court}, ${when}.`,
    lost: "Tarde: alguien se quedó con ese turno hace un momento.",
    rejected: "Ese turno ya no se puede reservar.",
    changed: "Actualizado ahora",
  },
  webhooks: {
    title: "Webhooks, firmados y entregados",
    lead: "Cada reserva escribe un evento en un outbox dentro de la misma transacción. Un despachador lo firma (Standard Webhooks, HMAC-SHA256) y lo entrega; aquí, a un receptor en este mismo servidor que verifica la firma como lo haría el tuyo.",
    empty: "Esperando la próxima reserva. Haz una en el calendario o corre la carrera.",
    written: "evento escrito",
    delivered: "entregado",
    verified: "firma verificada",
    invalid: "firma inválida",
    after: "en",
  },
  internals: {
    title: "Por dentro",
    lead: "Lo que hace falta para que un sistema de reservas sea correcto cuando está lleno de gente, y dónde vive cada cosa en el código.",
    source: "Código",
  },
  usage: {
    title: "Pruébala desde tu terminal",
    lead: "Esta es la clave publicable del club de prueba. Se puede compartir: solo lee el catálogo y la disponibilidad, y reserva.",
    copy: "Copiar",
    copied: "Copiado",
  },
  footer: {
    built: "Hecho por Rodrigo Siboldi con Hono, Bun, TypeScript y PostgreSQL.",
    reset: "El club de prueba se reinicia cada noche.",
  },
};

export const dictionaries: Record<Lang, Dictionary> = { en, es };

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("slotlock.lang");
    if (saved === "en" || saved === "es") return saved;
  } catch {
    // storage unavailable (private mode): fall back to the browser language
  }
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

export const I18nContext = createContext<{ lang: Lang; t: Dictionary; setLang(lang: Lang): void }>({
  lang: "en",
  t: en,
  setLang: () => {},
});

export const useI18n = () => useContext(I18nContext);
