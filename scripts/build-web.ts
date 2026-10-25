/**
 * Builds the demo page (React + shadcn/ui + Tailwind) into ./public with Bun's bundler.
 * Vercel serves ./public from its CDN; the standalone server serves it with serveStatic.
 *
 *   bun run build
 */
import { cp, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

const started = performance.now();
await rm("public/assets", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["./web/index.html"],
  outdir: "./public",
  minify: true,
  sourcemap: "linked",
  target: "browser",
  naming: { chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [tailwind],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs) {
  const size = output.size >= 1024 ? `${(output.size / 1024).toFixed(1)} KB` : `${output.size} B`;
  console.log(`  ${output.path.replace(process.cwd(), ".")}  ${size}`);
}
// Files referenced by URL rather than imported (the social preview image).
await cp("web/static", "public", { recursive: true });
console.log(`Built the demo page in ${Math.round(performance.now() - started)} ms`);
