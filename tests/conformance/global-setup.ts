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

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
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
