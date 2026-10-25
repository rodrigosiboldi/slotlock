/**
 * A tiny Prometheus registry: counters and histograms with labels, rendered in the
 * text exposition format (v0.0.4). Enough for a scrape target without pulling a client library.
 *
 * On serverless platforms each instance keeps its own numbers; scrape the standalone
 * server (Docker) for fleet-wide totals, or ship them to a push gateway.
 */
type Labels = Record<string, string | number>;

interface Metric {
  render(): string;
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Registry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.register(name, () => new Counter(name, help));
  }

  histogram(name: string, help: string, buckets = DEFAULT_BUCKETS): Histogram {
    return this.register(name, () => new Histogram(name, help, buckets));
  }

  render(): string {
    return `${[...this.metrics.values()].map((metric) => metric.render()).join("\n")}\n`;
  }

  private register<T extends Metric>(name: string, create: () => T): T {
    const existing = this.metrics.get(name);
    if (existing) return existing as T;
    const metric = create();
    this.metrics.set(name, metric);
    return metric;
  }
}

export class Counter implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels, value: by });
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] as number)) entry.counts[i] = (entry.counts[i] as number) + 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: bound })} ${counts[i]}`);
      });
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${roundTo(sum, 6)}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const body = entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(",");
  return `{${body}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The metrics the app records. One registry per app instance keeps tests isolated. */
export function createMetrics() {
  const registry = new Registry();
  return {
    registry,
    httpRequests: registry.counter("http_requests_total", "HTTP requests by method, route and status."),
    httpDuration: registry.histogram("http_request_duration_seconds", "HTTP request latency by route."),
    bookings: registry.counter("bookings_total", "Booking attempts by outcome."),
    webhookDeliveries: registry.counter("webhook_deliveries_total", "Webhook delivery attempts by outcome."),
    rateLimited: registry.counter("rate_limited_total", "Requests rejected by the rate limiter, by policy."),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
