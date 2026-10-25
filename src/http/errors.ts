import type { Context } from "hono";
import type { AppEnv } from "../context";
import { type FieldError, ProblemError, problems } from "../lib/problem";

/** Renders a ProblemError as an application/problem+json response. */
export function problemResponse(c: Context<AppEnv>, problem: ProblemError): Response {
  const body = problem.toBody(c.req.path, c.get("requestId") ?? "");
  return new Response(JSON.stringify(body), {
    status: problem.status,
    headers: { "content-type": "application/problem+json", ...problem.headers },
  });
}

/** Unhandled errors: known problems pass through, anything else becomes a logged 500. */
export function onError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof ProblemError) return problemResponse(c, error);
  if (isMalformedJson(error)) {
    return problemResponse(c, problems.validation([{ path: "body", message: "Body is not valid JSON." }]));
  }
  (c.get("log") ?? console).error("unhandled error", { error });
  return problemResponse(c, problems.internal());
}

export function onNotFound(c: Context<AppEnv>): Response {
  return problemResponse(c, problems.notFound("Route"));
}

/** Hook for every validated route: Zod issues become a 400 problem listing each field. */
export function validationHook(
  result: { success: true } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
  c: Context<AppEnv>,
): Response | undefined {
  if (result.success) return undefined;
  const errors: FieldError[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
  return problemResponse(c, problems.validation(errors));
}

function isMalformedJson(error: Error): boolean {
  return error instanceof SyntaxError || error.message.includes("Malformed JSON");
}
