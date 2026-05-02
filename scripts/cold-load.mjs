#!/usr/bin/env node
/**
 * Cold-load reliability tester for the edgesharp playground.
 *
 * Hits the live playground (or any IMAGEMODE_URL) with a curated set of
 * public test images at the widths Next.js's <Image> srcSet emits.
 * Records HTTP status, latency, content-type, body size, and whether the
 * response was the 1×1 fallback pixel.
 *
 * Run:
 *   node scripts/cold-load.mjs
 *   IMAGEMODE_URL=https://playground.edgesharp.teamchong.net node scripts/cold-load.mjs
 *   IMAGEMODE_URL=http://localhost:8787 node scripts/cold-load.mjs
 *
 * Each request appends a unique `?cb=<rand>` cache-bust query so we always
 * exercise the L3 cold-transform path. Without this, Cache API/R2 would
 * mask cold-burst regressions on repeated runs.
 */
import { performance } from "node:perf_hooks";

const TARGET = process.env.IMAGEMODE_URL || "https://playground.edgesharp.teamchong.net";
const WIDTHS = [640, 1200, 3840];
const QUALITY = 75;
const ACCEPT = "image/avif,image/webp,image/png,image/jpeg,*/*";
// Concurrency 2 keeps us under most origins' rate limits. Picsum throws 403
// at higher concurrency; that's an origin issue, not edgesharp's, but it
// muddies the error rate. Cold-burst behavior on the Worker is exercised by
// 51 distinct (url, width) pairs regardless of concurrency.
const CONCURRENCY = 2;

// Use a per-run random seed so each invocation hits cold paths (the worker's
// cache key includes the source URL, so reusing seeds across runs would mask
// cold-transform regressions behind R2 hits).
const RUN_SEED = Math.floor(Math.random() * 1_000_000_000);

const TEST_IMAGES = [
  // Picsum, varied sizes
  `https://picsum.photos/seed/${RUN_SEED}-a/2000/1500`,
  `https://picsum.photos/seed/${RUN_SEED}-b/2400/1600`,
  `https://picsum.photos/seed/${RUN_SEED}-c/3200/2400`,
  `https://picsum.photos/seed/${RUN_SEED}-d/1600/1200`,
  `https://picsum.photos/seed/${RUN_SEED}-e/2880/1920`,
  `https://picsum.photos/seed/${RUN_SEED}-f/4000/3000`,
  `https://picsum.photos/seed/${RUN_SEED}-g/1920/1080`,
  `https://picsum.photos/seed/${RUN_SEED}-h/2560/1440`,
  `https://picsum.photos/seed/${RUN_SEED}-i/3000/2000`,
  `https://picsum.photos/seed/${RUN_SEED}-j/2200/1467`,
  `https://picsum.photos/seed/${RUN_SEED}-k/1500/1000`,
  `https://picsum.photos/seed/${RUN_SEED}-l/2048/1365`,
  `https://picsum.photos/seed/${RUN_SEED}-m/3840/2160`,
  `https://picsum.photos/seed/${RUN_SEED}-n/1200/800`,
  `https://picsum.photos/seed/${RUN_SEED}-o/2700/1800`,
  // Wikimedia Commons, varies in source format. These are stable URLs (the
  // cache will hit on repeated runs); included to verify the User-Agent fix
  // and PNG decode path.
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/800px-PNG_transparency_demonstration_1.png",
  "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/Aldrin_Apollo_11.jpg/800px-Aldrin_Apollo_11.jpg",
];

function buildUrl(srcUrl, width) {
  const cb = Math.random().toString(36).slice(2, 10);
  const u = new URL("/_next/image", TARGET);
  u.searchParams.set("url", srcUrl);
  u.searchParams.set("w", String(width));
  u.searchParams.set("q", String(QUALITY));
  u.searchParams.set("cb", cb);
  return u.toString();
}

async function probe(srcUrl, width) {
  const started = performance.now();
  const reqUrl = buildUrl(srcUrl, width);
  try {
    const res = await fetch(reqUrl, { headers: { Accept: ACCEPT } });
    const buf = await res.arrayBuffer();
    const elapsed = performance.now() - started;
    return {
      ok: res.ok,
      status: res.status,
      elapsedMs: elapsed,
      bytes: buf.byteLength,
      type: res.headers.get("Content-Type") ?? "",
      fallback: res.headers.get("X-Edgesharp-Fallback"),
      srcUrl,
      width,
    };
  } catch (err) {
    const elapsed = performance.now() - started;
    return {
      ok: false,
      status: 0,
      elapsedMs: elapsed,
      bytes: 0,
      type: "",
      fallback: null,
      error: err instanceof Error ? err.message : String(err),
      srcUrl,
      width,
    };
  }
}

async function pool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
}

async function main() {
  console.log(`edgesharp cold-load tester`);
  console.log(`target:      ${TARGET}`);
  console.log(`images:      ${TEST_IMAGES.length}`);
  console.log(`widths:      ${WIDTHS.join(", ")}`);
  console.log(`probes:      ${TEST_IMAGES.length * WIDTHS.length}`);
  console.log(`concurrency: ${CONCURRENCY}`);
  console.log("");

  const probes = [];
  for (const src of TEST_IMAGES) {
    for (const w of WIDTHS) {
      probes.push({ src, w });
    }
  }

  const startedAll = performance.now();
  const results = await pool(probes, ({ src, w }) => probe(src, w), CONCURRENCY);
  const totalElapsed = performance.now() - startedAll;

  const successes = results.filter((r) => r.ok && !r.fallback);
  // Categorize failures:
  //   edgesharp-fault: 5xx from the worker, or X-Edgesharp-Fallback header set.
  //                    These are things our worker can be held accountable for.
  //   origin-fault:    4xx from the worker representing upstream 4xx/5xx, or
  //                    network errors hitting the origin. Out of our control;
  //                    a Picsum 403 doesn't mean edgesharp is broken.
  const edgesharpFaults = results.filter((r) => r.fallback || r.status >= 500);
  const originFaults = results.filter(
    (r) => !r.ok && !r.fallback && r.status < 500,
  );

  console.log(`Results (${results.length} probes in ${fmtMs(totalElapsed)})`);
  console.log("");

  if (edgesharpFaults.length > 0) {
    console.log(`Edgesharp faults (${edgesharpFaults.length}):`);
    for (const r of edgesharpFaults) {
      const flag = r.fallback ? `fallback=${r.fallback}` : `status=${r.status}`;
      const detail = r.error ? ` err=${r.error}` : "";
      console.log(`  w=${r.width} ${flag} ${fmtMs(r.elapsedMs)} ${r.srcUrl}${detail}`);
    }
    console.log("");
  }

  if (originFaults.length > 0) {
    console.log(`Origin-side failures, not edgesharp's problem (${originFaults.length}):`);
    for (const r of originFaults) {
      console.log(`  w=${r.width} status=${r.status} ${fmtMs(r.elapsedMs)} ${r.srcUrl}`);
    }
    console.log("");
  }

  if (successes.length > 0) {
    const latencies = successes.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? latencies[latencies.length - 1];
    const totalBytes = successes.reduce((acc, r) => acc + r.bytes, 0);
    const avgBytes = totalBytes / successes.length;

    console.log(`Successes (${successes.length}):`);
    console.log(`  p50 latency: ${fmtMs(p50)}`);
    console.log(`  p95 latency: ${fmtMs(p95)}`);
    console.log(`  p99 latency: ${fmtMs(p99)}`);
    console.log(`  avg bytes:   ${fmtBytes(avgBytes)}`);
    console.log(`  total bytes: ${fmtBytes(totalBytes)}`);
    console.log("");
  }

  const edgesharpRate = edgesharpFaults.length / results.length;
  const originRate = originFaults.length / results.length;
  console.log(`Edgesharp fault rate: ${(edgesharpRate * 100).toFixed(1)}% (${edgesharpFaults.length}/${results.length})`);
  console.log(`Origin fault rate:    ${(originRate * 100).toFixed(1)}% (${originFaults.length}/${results.length})`);

  // Gate CI on edgesharp faults only. Origin faults are noise from public test
  // images getting rate-limited or going 404, not a regression in the worker.
  // Threshold defaults to 10% to absorb the giant-source AVIF fallback that
  // happens deterministically; tighten via env var if you want to be stricter.
  const threshold = parseFloat(process.env.EDGESHARP_FAIL_THRESHOLD ?? "0.10");
  const failed = edgesharpRate > threshold;
  if (failed) {
    console.log("");
    console.log(`FAIL: edgesharp fault rate ${(edgesharpRate * 100).toFixed(1)}% > threshold ${(threshold * 100).toFixed(1)}%`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("tester crashed:", err);
  process.exit(2);
});
