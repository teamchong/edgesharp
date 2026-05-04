import { parseArgs } from "node:util";

const OG_HELP = `edgesharp og — purge or refresh cached OG cards on your Worker.

Usage:
  edgesharp og purge   <page-url>     Delete every cached card for one page
  edgesharp og refresh <origin-url>   Delete every cached card from an origin

Options:
  --worker <url>   Your og Worker URL (or set EDGESHARP_OG_URL)
  --json           Print the Worker's full JSON response
  --quiet          Print only on error
  -h, --help       Show this help

Examples:
  edgesharp og purge https://yoursite.com/article \\
    --worker https://og.example.com

  EDGESHARP_OG_URL=https://og.example.com \\
    edgesharp og refresh https://yoursite.com

The Worker authorizes by Referer against ALLOWED_ORIGINS. The CLI
sends the page-url (purge) or origin-url (refresh) in the Referer
header, so the calling URL must be on your Worker's allowlist.`;

interface PurgeResponse {
  purged: string[];
  referer: string;
}

interface RefreshResponse {
  origin: string;
  scanned: number;
  purged: number;
  purgedOrphan: number;
  skippedForeign: number;
}

interface Flags {
  worker?: string;
  json: boolean;
  quiet: boolean;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseUrl(input: string, label: string): URL {
  try {
    return new URL(input);
  } catch {
    return fail(`invalid ${label}: ${input}`);
  }
}

async function runPurge(worker: URL, page: URL, flags: Flags): Promise<void> {
  const res = await fetch(new URL("/purge", worker), {
    method: "POST",
    headers: { Referer: page.toString() },
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`purge failed (${res.status}): ${body.slice(0, 500).trim()}`);
  }
  const body = (await res.json()) as PurgeResponse;
  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  if (!flags.quiet) {
    const count = body.purged.length;
    process.stdout.write(
      `purged ${count} cached variant${count === 1 ? "" : "s"} for ${body.referer}\n`,
    );
  }
}

async function runRefresh(worker: URL, originUrl: URL, flags: Flags): Promise<void> {
  // /refresh keys off Referer's origin — strip any path the user passed.
  const referer = new URL("/", originUrl);
  const res = await fetch(new URL("/refresh", worker), {
    method: "POST",
    headers: { Referer: referer.toString() },
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`refresh failed (${res.status}): ${body.slice(0, 500).trim()}`);
  }
  const body = (await res.json()) as RefreshResponse;
  if (flags.json) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }
  if (!flags.quiet) {
    const parts = [`scanned ${body.scanned}`, `purged ${body.purged}`];
    if (body.purgedOrphan) parts.push(`${body.purgedOrphan} orphan${body.purgedOrphan === 1 ? "" : "s"} cleaned`);
    if (body.skippedForeign) parts.push(`${body.skippedForeign} foreign skipped`);
    process.stdout.write(`refresh ${body.origin}: ${parts.join(", ")}\n`);
  }
}

export async function runOgCommand(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        worker: { type: "string" },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(OG_HELP + "\n");
    process.exit(0);
  }
  if (positionals.length === 0) {
    process.stderr.write(OG_HELP + "\n");
    process.exit(1);
  }

  const [subcommand, target = ""] = positionals;
  if (subcommand !== "purge" && subcommand !== "refresh") {
    fail(`unknown og subcommand: ${subcommand}`);
  }
  if (!target) {
    fail(`og ${subcommand} requires a URL argument`);
  }

  const flags: Flags = {
    worker: values.worker,
    json: !!values.json,
    quiet: !!values.quiet,
  };
  const workerSpec = flags.worker ?? process.env.EDGESHARP_OG_URL;
  if (!workerSpec) {
    fail("missing --worker URL (or set EDGESHARP_OG_URL)");
  }

  const worker = parseUrl(workerSpec, "worker URL");
  const targetUrl = parseUrl(target, "URL");

  if (subcommand === "purge") {
    await runPurge(worker, targetUrl, flags);
  } else {
    await runRefresh(worker, targetUrl, flags);
  }
}
