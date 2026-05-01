/**
 * edgesharp latency benchmarks.
 *
 * Measures end-to-end latency through wrangler dev for:
 *   - Cold start (first request, WASM Liftoff compilation)
 *   - Warm (TurboFan-optimized, no cache)
 *   - Cached (Cache API / R2 hit)
 *
 * Run with:
 *   node tests/origin-server.mjs &
 *   npx wrangler dev --port 8787 --var ORIGIN:http://localhost:3456
 *   npx tsx tests/benchmark.ts
 */

const BASE_URL = process.env.IMAGEMODE_TEST_URL ?? "http://localhost:8787";

interface BenchmarkResult {
  name: string;
  cold: number;
  warm: number;
  cached: number;
  outputSize: number;
}

async function benchmark(
  name: string,
  path: string,
  width: number,
  quality: number,
): Promise<BenchmarkResult> {
  const url = `${BASE_URL}/_next/image?url=${encodeURIComponent(path)}&w=${width}&q=${quality}`;
  const headers = { Accept: "image/jpeg" };

  // Unique cache buster for cold/warm measurements
  const buster = `&_t=${Date.now()}_${Math.random()}`;
  const noCacheUrl = url + buster;

  // Cold: first request to a unique URL (forces WASM transform)
  const coldStart = performance.now();
  const coldRes = await fetch(noCacheUrl, { headers });
  const coldBody = await coldRes.arrayBuffer();
  const cold = performance.now() - coldStart;

  if (coldRes.status !== 200) {
    console.error(`  ${name}: cold request failed with status ${coldRes.status}`);
    return { name, cold: -1, warm: -1, cached: -1, outputSize: 0 };
  }

  // Warm: second request with different cache buster (DO is warm, no cache hit)
  // Run 5 warm requests and take the median
  const warmTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const warmBuster = `&_t=${Date.now()}_warm_${i}_${Math.random()}`;
    const warmUrl = url + warmBuster;
    const warmStart = performance.now();
    const warmRes = await fetch(warmUrl, { headers });
    await warmRes.arrayBuffer();
    warmTimes.push(performance.now() - warmStart);
  }
  warmTimes.sort((a, b) => a - b);
  const warm = warmTimes[Math.floor(warmTimes.length / 2)]; // median

  // Cached: same URL as cold request (should hit Cache API or R2)
  const cachedStart = performance.now();
  const cachedRes = await fetch(noCacheUrl, { headers });
  await cachedRes.arrayBuffer();
  const cached = performance.now() - cachedStart;

  return { name, cold, warm, cached, outputSize: coldBody.byteLength };
}

async function main() {
  console.log("edgesharp latency benchmark");
  console.log("===========================");
  console.log(`Target: ${BASE_URL}`);
  console.log("");

  // Warmup request to ensure wrangler dev is ready
  await fetch(`${BASE_URL}/`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));

  const results: BenchmarkResult[] = [];

  // JPEG benchmarks
  results.push(await benchmark("JPEG 2000x1500 → 640px", "/photo.jpg", 640, 75));
  results.push(await benchmark("JPEG 2000x1500 → 1080px", "/photo.jpg", 1080, 75));
  results.push(await benchmark("JPEG 2000x1500 → 1920px", "/photo.jpg", 1920, 75));
  results.push(await benchmark("JPEG 2000x1500 → 3840px", "/photo.jpg", 3840, 75));

  // PNG benchmarks
  results.push(await benchmark("PNG 512x512 → 64px", "/icon.png", 64, 80));
  results.push(await benchmark("PNG 512x512 → 256px", "/icon.png", 256, 80));
  results.push(await benchmark("PNG 512x512 → 384px", "/icon.png", 384, 80));

  // Quality benchmarks (same size, different quality)
  results.push(await benchmark("JPEG 640px q=30", "/photo.jpg", 640, 30));
  results.push(await benchmark("JPEG 640px q=75", "/photo.jpg", 640, 75));
  results.push(await benchmark("JPEG 640px q=100", "/photo.jpg", 640, 100));

  // Print results table
  console.log("Results:");
  console.log("");
  console.log(
    "| Test | Cold (ms) | Warm (ms) | Cached (ms) | Output (KB) |",
  );
  console.log(
    "|------|-----------|-----------|-------------|-------------|",
  );

  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.cold.toFixed(0)} | ${r.warm.toFixed(0)} | ${r.cached.toFixed(0)} | ${(r.outputSize / 1024).toFixed(1)} |`,
    );
  }

  console.log("");

  // Summary stats
  const validWarm = results.filter((r) => r.warm > 0).map((r) => r.warm);
  const validCached = results.filter((r) => r.cached > 0).map((r) => r.cached);
  const avgWarm = validWarm.reduce((a, b) => a + b, 0) / validWarm.length;
  const avgCached = validCached.reduce((a, b) => a + b, 0) / validCached.length;

  console.log(`Average warm latency:   ${avgWarm.toFixed(0)}ms`);
  console.log(`Average cached latency: ${avgCached.toFixed(0)}ms`);
  console.log(`Warm/Cached speedup:    ${(avgWarm / avgCached).toFixed(1)}x`);
}

main().catch(console.error);
