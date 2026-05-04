#!/usr/bin/env node
import { runOgCommand } from "./og-cli.js";

const TOP_HELP = `edgesharp — utilities for the edgesharp Cloudflare Worker.

Subcommands:
  edgesharp og purge   <page-url>     Delete every cached OG card for one page
  edgesharp og refresh <origin-url>   Delete every cached OG card from an origin

Run 'edgesharp og --help' for og-specific options.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    process.stderr.write(TOP_HELP + "\n");
    process.exit(1);
  }
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(TOP_HELP + "\n");
    process.exit(0);
  }

  const [topCommand, ...rest] = args;
  if (topCommand === "og") {
    await runOgCommand(rest);
    return;
  }

  process.stderr.write(`error: unknown command: ${topCommand}\n${TOP_HELP}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
