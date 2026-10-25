/** The demo page's client for the Slotlock API. Everything goes through the public /v1 API. */

export interface DemoConfig {
  name: string;
  timezone: string;
  publishableKey: string;
  matchServiceId: string;
  courts: { id: string; name: string }[];
  publicUrl: string;
  repositoryUrl: string;
}

export interface Slot {
  resourceId: string;
  start: string;
  end: string;
}

export interface OpeningHours {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  reason?: string;
}

export interface Race {
  raceId: string;
  ticket: string;
  resourceId: string;
  serviceId: string;
  startsAt: string;
  attempts: number;
}

export async function loadConfig(): Promise<DemoConfig> {
  const response = await fetch("/demo/config");
  if (!response.ok) throw new Error(`config ${response.status}`);
  return response.json();
}

export function createClient(config: DemoConfig) {
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${config.publishableKey}`,
    ...extra,
  });

  return {
    async availability(date: string): Promise<Slot[]> {
      const query = new URLSearchParams({ serviceId: config.matchServiceId, from: date });
      const response = await fetch(`/v1/availability?${query}`, { headers: headers() });
      if (!response.ok) throw new Error(`availability ${response.status}`);
      return ((await response.json()) as { slots: Slot[] }).slots;
    },

    async openingHours(): Promise<Map<string, OpeningHours[]>> {
      const response = await fetch("/v1/resources?limit=100", { headers: headers() });
      if (!response.ok) throw new Error(`resources ${response.status}`);
      const { data } = (await response.json()) as { data: { id: string; openingHours: OpeningHours[] }[] };
      return new Map(data.map((resource) => [resource.id, resource.openingHours]));
    },

    async book(input: {
      resourceId: string;
      startsAt: string;
      name: string;
      email: string;
      serviceId?: string;
      race?: string;
    }): Promise<{ status: number; body: unknown; ms: number }> {
      const started = performance.now();
      const response = await fetch("/v1/bookings", {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(input.race ? { "x-slotlock-race": input.race } : {}),
        }),
        body: JSON.stringify({
          serviceId: input.serviceId ?? config.matchServiceId,
          resourceId: input.resourceId,
          startsAt: input.startsAt,
          customer: { name: input.name, email: input.email },
          metadata: { source: input.race ? "race" : "landing" },
        }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body, ms: performance.now() - started };
    },

    async startRace(): Promise<{ status: number; race?: Race }> {
      const response = await fetch("/demo/race", { method: "POST" });
      if (!response.ok) return { status: response.status };
      return { status: response.status, race: (await response.json()) as Race };
    },

    health: async () => {
      const started = performance.now();
      const response = await fetch("/healthz");
      const body = response.ok ? ((await response.json()) as { version: string }) : null;
      return { ok: response.ok, version: body?.version ?? "", ms: Math.round(performance.now() - started) };
    },

    readiness: async () => {
      const response = await fetch("/readyz");
      return response.ok
        ? ((await response.json()) as { database: { latencyMs: number; noOverlapConstraint: boolean } })
        : null;
    },

    headers,
  };
}

export type Client = ReturnType<typeof createClient>;

/**
 * Server-Sent Events over fetch, so requests can carry an Authorization header (EventSource
 * cannot). Reconnects with the server's retry hint and resumes from the last event id.
 */
export function subscribe(
  url: string,
  init: { headers?: Record<string, string> },
  handlers: { event(name: string, data: string): void; state?(open: boolean): void },
): () => void {
  let stopped = false;
  let lastEventId = "";
  let retryMs = 1000;
  let controller: AbortController | null = null;

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await fetch(url, {
          headers: {
            ...init.headers,
            accept: "text/event-stream",
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        handlers.state?.(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
            let name = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) name = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
              else if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
              else if (line.startsWith("retry:")) retryMs = Number(line.slice(6)) || retryMs;
            }
            if (data.length > 0) handlers.event(name, data.join("\n"));
          }
        }
      } catch {
        // dropped or refused: fall through to the retry below
      }
      handlers.state?.(false);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
