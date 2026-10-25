/**
 * Vercel entry point (Bun runtime, Fluid compute): the demo page and the API in one Hono app.
 * Work that must outlive a response (webhook dispatch) is handed to waitUntil.
 */
import { waitUntil } from "@vercel/functions";
import { Hono } from "hono";
import { createRuntime } from "./bootstrap";
import { mountSite } from "./http/site";

const runtime = await createRuntime({ background: (task) => waitUntil(task) });

const app = new Hono();
mountSite(app);
app.route("/", runtime.app);

export default app;
