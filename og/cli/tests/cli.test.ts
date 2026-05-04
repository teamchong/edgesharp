import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface CapturedRequest {
  method: string;
  url: string;
  referer: string | null;
}

interface MockServerHandle {
  url: string;
  close: () => void;
  requests: CapturedRequest[];
}

interface MockResponse {
  status: number;
  body: object | string;
}

function startMockServer(handler: (req: CapturedRequest) => MockResponse): Promise<MockServerHandle> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const captured: CapturedRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      referer: req.headers.referer ?? null,
    };
    requests.push(captured);
    const result = handler(captured);
    res.statusCode = result.status;
    if (typeof result.body === "string") {
      res.end(result.body);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result.body));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server.address() returned non-object"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        requests,
      });
    });
  });
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], envOverrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Wipe any inherited EDGESHARP_OG_URL so test setup is explicit per-case.
  delete env.EDGESHARP_OG_URL;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined || v === "") {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  // Spawn node directly with the tsx loader — avoids npm/npx noise (npmrc
  // warnings would pollute the stderr that several tests assert against).
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ stdout, stderr, code }));
  });
}

test("purge: sends POST /purge with the page URL as Referer", async () => {
  const server = await startMockServer(() => ({
    status: 200,
    body: { purged: ["/og/", "/og/article.html", "/x/"], referer: "https://yoursite.com/article" },
  }));
  try {
    const result = await runCli([
      "purge",
      "https://yoursite.com/article",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].url, "/purge");
    assert.equal(server.requests[0].referer, "https://yoursite.com/article");
    assert.match(result.stdout, /purged 3 cached variants/);
    assert.match(result.stdout, /https:\/\/yoursite\.com\/article/);
    assert.equal(result.stderr, "");
  } finally {
    server.close();
  }
});

test("refresh: strips path from URL and sends origin/ as Referer", async () => {
  const server = await startMockServer(() => ({
    status: 200,
    body: {
      origin: "https://yoursite.com",
      scanned: 12,
      purged: 10,
      purgedOrphan: 2,
      skippedForeign: 1,
    },
  }));
  try {
    const result = await runCli([
      "refresh",
      "https://yoursite.com/some/path",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(server.requests[0].url, "/refresh");
    assert.equal(server.requests[0].referer, "https://yoursite.com/");
    assert.match(result.stdout, /scanned 12, purged 10, 2 orphans cleaned, 1 foreign skipped/);
  } finally {
    server.close();
  }
});

test("403 from Worker (origin not allowed): exit 1, body in stderr, stdout empty", async () => {
  const server = await startMockServer(() => ({
    status: 403,
    body: "Forbidden: origin attacker.com not in ALLOWED_ORIGINS",
  }));
  try {
    const result = await runCli([
      "purge",
      "https://attacker.com/x",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /purge failed \(403\)/);
    assert.match(result.stderr, /not in ALLOWED_ORIGINS/);
    assert.equal(result.stdout, "", "stdout must stay empty on auth failure (script-safe)");
  } finally {
    server.close();
  }
});

test("500 from Worker: exit 1, body capped to 500 chars in stderr", async () => {
  const longBody = "x".repeat(2000);
  const server = await startMockServer(() => ({
    status: 500,
    body: longBody,
  }));
  try {
    const result = await runCli([
      "refresh",
      "https://yoursite.com",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refresh failed \(500\)/);
    // Cap defends against runaway error bodies leaking into terminal/CI logs
    const xCount = (result.stderr.match(/x/g) ?? []).length;
    assert.ok(xCount <= 500, `expected stderr to cap body at 500 chars, got ${xCount}`);
  } finally {
    server.close();
  }
});

test("missing --worker without env: exit 1, no fetch attempted", async () => {
  let fetched = false;
  const server = await startMockServer(() => {
    fetched = true;
    return { status: 200, body: {} };
  });
  try {
    const result = await runCli(["purge", "https://yoursite.com/x"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing --worker URL/);
    assert.equal(result.stdout, "");
    assert.equal(fetched, false, "must not contact any host before validating config");
  } finally {
    server.close();
  }
});

test("EDGESHARP_OG_URL env var works as --worker fallback", async () => {
  const server = await startMockServer(() => ({
    status: 200,
    body: { purged: [], referer: "https://yoursite.com/x" },
  }));
  try {
    const result = await runCli(
      ["purge", "https://yoursite.com/x"],
      { EDGESHARP_OG_URL: server.url },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(server.requests[0].referer, "https://yoursite.com/x");
  } finally {
    server.close();
  }
});

test("--worker flag wins over EDGESHARP_OG_URL env var", async () => {
  let flagHit = false;
  const flagServer = await startMockServer(() => {
    flagHit = true;
    return { status: 200, body: { purged: [], referer: "https://yoursite.com/x" } };
  });
  let envHit = false;
  const envServer = await startMockServer(() => {
    envHit = true;
    return { status: 200, body: { purged: [], referer: "https://yoursite.com/x" } };
  });
  try {
    const result = await runCli(
      ["purge", "https://yoursite.com/x", "--worker", flagServer.url],
      { EDGESHARP_OG_URL: envServer.url },
    );
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(flagHit, true);
    assert.equal(envHit, false);
  } finally {
    flagServer.close();
    envServer.close();
  }
});

test("--help: exit 0, usage on stdout", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /edgesharp-og — purge or refresh/);
  assert.match(result.stdout, /EDGESHARP_OG_URL/);
});

test("no args: exit 1, usage on stderr (so stdout stays clean for scripts)", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /edgesharp-og — purge or refresh/);
});

test("invalid --worker URL: exit 1 before any network attempt", async () => {
  const result = await runCli([
    "purge", "https://yoursite.com/x",
    "--worker", "not a url",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid worker URL/);
});

test("invalid target URL: exit 1, no fetch", async () => {
  let fetched = false;
  const server = await startMockServer(() => { fetched = true; return { status: 200, body: {} }; });
  try {
    const result = await runCli([
      "purge", "::not-a-url",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid URL/);
    assert.equal(fetched, false);
  } finally {
    server.close();
  }
});

test("--json: prints exact Worker JSON, parseable by callers", async () => {
  const server = await startMockServer(() => ({
    status: 200,
    body: { purged: ["/og/"], referer: "https://yoursite.com/x" },
  }));
  try {
    const result = await runCli([
      "purge", "https://yoursite.com/x",
      "--worker", server.url,
      "--json",
    ]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.purged, ["/og/"]);
    assert.equal(parsed.referer, "https://yoursite.com/x");
  } finally {
    server.close();
  }
});

test("--quiet: success keeps stdout and stderr both empty", async () => {
  const server = await startMockServer(() => ({
    status: 200,
    body: { purged: [], referer: "https://yoursite.com/x" },
  }));
  try {
    const result = await runCli([
      "purge", "https://yoursite.com/x",
      "--worker", server.url,
      "--quiet",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    server.close();
  }
});

test("unknown command: exit 1 with helpful error", async () => {
  const result = await runCli(["bogus", "x", "--worker", "http://example.com"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command/);
});

test("Worker URL never appears on stdout (always stderr) on error", async () => {
  const server = await startMockServer(() => ({
    status: 403,
    body: "denied",
  }));
  try {
    const result = await runCli([
      "purge", "https://yoursite.com/x",
      "--worker", server.url,
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "", "stdout must stay clean on error so script consumers can rely on it");
  } finally {
    server.close();
  }
});
