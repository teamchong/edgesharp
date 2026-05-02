/**
 * Global setup/teardown for protocol conformance tests.
 *
 * Starts:
 *   1. Origin server on port 3456 (serves test fixtures)
 *   2. Wrangler dev on port 8787 (edgesharp Worker)
 *
 * Both are killed after tests complete.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "../..");

let originServer: ChildProcess;
let wranglerDev: ChildProcess;

// Default 60s. CI runners spawn wrangler dev meaningfully slower than local
// (cold node, no pnpm cache, miniflare bootstrapping). Local runs hit the
// "Ready on" line in 1-3s; CI takes 15-30s on a cold runner.
async function waitForPort(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`).catch(() => null);
      if (res) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Port ${port} did not become available within ${timeoutMs}ms`);
}

export async function setup() {
  // Start origin server
  originServer = spawn("node", [join(__dirname, "../origin-server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, PORT: "3456" },
    stdio: "pipe",
  });

  // Wait for origin server
  await waitForPort(3456);

  // Start wrangler dev
  const port = Number(process.env.IMAGEMODE_WRANGLER_PORT ?? 8787);
  wranglerDev = spawn(
    "npx",
    [
      "wrangler", "dev",
      "--port", String(port),
      "--var", "ORIGIN:http://localhost:3456",
      // Override the demo-friendly "*" so allowlist-rejection tests still
      // exercise the host-not-allowed code path.
      "--var", "ALLOWED_ORIGINS:http://localhost:3456",
    ],
    {
      cwd: projectRoot,
      stdio: "pipe",
      env: { ...process.env },
    },
  );

  // Wait for wrangler dev
  await waitForPort(port);

  // Warm up the DO + WASM so the first conformance test doesn't pay the
  // entire cold-isolate boot + WASM compile + JPEG encoder warmup. CI
  // runners have variable CPU; the first transform can take 30+ seconds
  // on a slow shared runner. Two warmup hits cover both the WebP path
  // (used by most tests via the default Accept header) and the JPEG path
  // (used by the "Accept: */*" content-negotiation test).
  for (const accept of ["image/webp,*/*", "image/jpeg,*/*"]) {
    await fetch(`http://localhost:${port}/_next/image?url=/photo.jpg&w=640&q=75&warmup=${encodeURIComponent(accept)}`, {
      headers: { Accept: accept },
    }).catch(() => {});
  }
}

export async function teardown() {
  if (wranglerDev) {
    wranglerDev.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!wranglerDev.killed) wranglerDev.kill("SIGKILL");
  }
  if (originServer) {
    originServer.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!originServer.killed) originServer.kill("SIGKILL");
  }
}
