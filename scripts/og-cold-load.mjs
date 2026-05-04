#!/usr/bin/env node
/**
 * Cold-load reliability tester for the edgesharp-og Worker.
 *
 * Hits each (platform, template) pair with a Referer that the Worker
 * accepts, records status / latency / content-type / size, and reports
 * the og-fault rate (renders that returned non-200 or weren't PNG).
 *
 * Run:
 *   node scripts/og-cold-load.mjs
 *   OG_URL=https://edgesharp-og.teamchong.net node scripts/og-cold-load.mjs
 *   OG_URL=http://localhost:8788 OG_REFERER=http://localhost:8787/og/ node scripts/og-cold-load.mjs
 *
 * Cache-busts the og Worker by Referer string variation per probe — the
 * cache key includes the Referer URL, so different Referers always miss
 * cache. Origin (the host the Worker fetches via Referer) is unchanged
 * so the metadata extraction behaviour is exercised consistently.
 */
import { performance } from "node:perf_hooks";

const OG_URL = process.env.OG_URL || "https://edgesharp-og.teamchong.net";
const OG_REFERER_BASE =
  process.env.OG_REFERER || "https://playground.edgesharp.teamchong.net/og/";
const CONCURRENCY = 2;

const PLATFORMS = ["og", "x", "sq"];
const TEMPLATES = ["", "article.html"];

function buildProbes() {
  const probes = [];
  for (const platform of PLATFORMS) {
    for (const template of TEMPLATES) {
      probes.push({ platform, template });
    }
  }
  return probes;
}

async function probe({ platform, template }) {
  const cb = Math.random().toString(36).slice(2, 10);
  const url = `${OG_URL.replace(/\/$/, "")}/${platform}/${template}`;
  const referer = `${OG_REFERER_BASE}?cb=${cb}`;
  const started = performance.now();
  try {
    const res = await fetch(url, { headers: { Referer: referer } });
    const buf = await res.arrayBuffer();
    const elapsed = performance.now() - started;
    const ct = res.headers.get("Content-Type") ?? "";
    return {
      ok: res.ok && ct.startsWith("image/png"),
      status: res.status,
      contentType: ct,
      bytes: buf.byteLength,
      elapsedMs: elapsed,
      url,
      referer,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      bytes: 0,
      elapsedMs: performance.now() - started,
      url,
      referer,
      error: err instanceof Error ? err.message : String(err),
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
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(b) {
  return b < 1024
    ? `${b}B`
    : b < 1024 * 1024
      ? `${(b / 1024).toFixed(0)}KB`
      : `${(b / 1024 / 1024).toFixed(2)}MB`;
}

async function main() {
  console.log(`edgesharp-og cold-load tester`);
  console.log(`og worker:  ${OG_URL}`);
  console.log(`referer:    ${OG_REFERER_BASE}`);
  console.log(`probes:     ${PLATFORMS.length * TEMPLATES.length}`);
  console.log(`concurrency: ${CONCURRENCY}`);
  console.log("");

  const probes = buildProbes();
  const startedAll = performance.now();
  const results = await pool(probes, probe, CONCURRENCY);
  const totalElapsed = performance.now() - startedAll;

  const failures = results.filter((r) => !r.ok);
  const successes = results.filter((r) => r.ok);

  console.log(`Results (${results.length} probes in ${fmtMs(totalElapsed)})`);
  console.log("");

  if (failures.length > 0) {
    console.log(`Failures (${failures.length}):`);
    for (const r of failures) {
      const detail = r.error ? ` err=${r.error}` : "";
      console.log(`  ${r.url} → status=${r.status} ct=${r.contentType}${detail}`);
    }
    console.log("");
  }

  if (successes.length > 0) {
    const lat = successes.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length * 0.5)];
    const p95 = lat[Math.floor(lat.length * 0.95)] ?? lat[lat.length - 1];
    const p99 = lat[Math.floor(lat.length * 0.99)] ?? lat[lat.length - 1];
    const totalBytes = successes.reduce((acc, r) => acc + r.bytes, 0);
    console.log(`Successes (${successes.length}):`);
    console.log(`  p50 latency: ${fmtMs(p50)}`);
    console.log(`  p95 latency: ${fmtMs(p95)}`);
    console.log(`  p99 latency: ${fmtMs(p99)}`);
    console.log(`  avg bytes:   ${fmtBytes(totalBytes / successes.length)}`);
    console.log("");
  }

  const failRate = failures.length / results.length;
  const threshold = parseFloat(process.env.OG_FAIL_THRESHOLD ?? "0.10");
  console.log(`og fault rate: ${(failRate * 100).toFixed(1)}% (${failures.length}/${results.length})`);
  if (failRate > threshold) {
    console.log(`FAIL: og fault rate ${(failRate * 100).toFixed(1)}% > threshold ${(threshold * 100).toFixed(1)}%`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("tester crashed:", err);
  process.exit(2);
});
