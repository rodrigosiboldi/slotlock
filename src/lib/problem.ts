import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * RFC 9457 "Problem Details for HTTP APIs".
 * Every error the API returns has this shape and the `application/problem+json` media type.
 */
export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
  [extension: string]: unknown;
}

export interface FieldError {
  path: string;
  message: string;
}

/** Problem types are documented in docs/errors.md; the slug is the anchor there. */
export const PROBLEM_DOCS = "https://github.com/rodrigosiboldi/slotlock/blob/main/docs/errors.md";

export class ProblemError extends Error {
  readonly status: ContentfulStatusCode;
  readonly slug: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(init: {
    status: ContentfulStatusCode;
    slug: string;
    title: string;
    detail?: string;
    extensions?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) {
    super(init.detail ?? init.title);
    this.name = "ProblemError";
    this.status = init.status;
    this.slug = init.slug;
    this.title = init.title;
    this.detail = init.detail;
    this.extensions = init.extensions ?? {};
    this.headers = init.headers ?? {};
  }

  toBody(instance: string, requestId: string): ProblemBody {
    return {
      type: `${PROBLEM_DOCS}#${this.slug}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      instance,
      requestId,
      ...this.extensions,
    };
  }
}

/** The catalogue of errors the API can return. Keep docs/errors.md in sync. */
export const problems = {
  validation: (errors: FieldError[]) =>
    new ProblemError({
      status: 400,
      slug: "validation-error",
      title: "Invalid request",
      detail: "One or more fields failed validation.",
      extensions: { errors },
    }),
  unauthorized: (detail = "Send an API key as `Authorization: Bearer <key>`.") =>
    new ProblemError({ status: 401, slug: "unauthorized", title: "Authentication required", detail }),
  forbidden: (scope: string) =>
    new ProblemError({
      status: 403,
      slug: "insufficient-scope",
      title: "Insufficient scope",
      detail: `This API key lacks the \`${scope}\` scope.`,
      extensions: { requiredScope: scope },
    }),
  notFound: (what = "Resource") => new ProblemError({ status: 404, slug: "not-found", title: `${what} not found` }),
  conflict: (slug: string, title: string, detail?: string, extensions?: Record<string, unknown>) =>
    new ProblemError({
      status: 409,
      slug,
      title,
      ...(detail ? { detail } : {}),
      ...(extensions ? { extensions } : {}),
    }),
  unprocessable: (slug: string, title: string, detail?: string, extensions?: Record<string, unknown>) =>
    new ProblemError({
      status: 422,
      slug,
      title,
      ...(detail ? { detail } : {}),
      ...(extensions ? { extensions } : {}),
    }),
  rateLimited: (retryAfterSeconds: number) =>
    new ProblemError({
      status: 429,
      slug: "rate-limited",
      title: "Too many requests",
      detail: `Slow down and retry in ${retryAfterSeconds} s.`,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }),
  internal: () =>
    new ProblemError({
      status: 500,
      slug: "internal-error",
      title: "Internal server error",
      detail: "Something went wrong on our side. The request id helps us find it in the logs.",
    }),
};
