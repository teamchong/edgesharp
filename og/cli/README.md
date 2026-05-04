# edgesharp-og (CLI)

Command-line wrapper around the [edgesharp-og](../README.md) Worker's
`/purge` and `/refresh` endpoints, so you don't have to remember the
`curl -X POST -H 'Referer: ...'` dance every time you re-edit a post.

```bash
# Purge a single page's cached cards
npx edgesharp-og purge https://yoursite.com/article \
  --worker https://og.example.com

# Refresh every cached card from one origin
npx edgesharp-og refresh https://yoursite.com \
  --worker https://og.example.com
```

## Install

No install required — `npx` fetches and runs the latest published version.

To pin a version:

```bash
pnpm add -g edgesharp-og        # then `edgesharp-og purge ...`
```

## Usage

```
edgesharp-og purge   <page-url>     Delete every cached card for one page
edgesharp-og refresh <origin-url>   Delete every cached card from an origin
```

| Option | Effect |
|---|---|
| `--worker <url>` | Your og Worker URL. Required unless `EDGESHARP_OG_URL` is set. |
| `--json` | Print the Worker's full JSON response instead of a one-line summary. Useful for piping into `jq` or for CI scripting. |
| `--quiet` | Silent on success. Errors still go to stderr; exit code is the signal. |
| `-h`, `--help` | Show usage and exit. |

The `EDGESHARP_OG_URL` env var is the recommended way to set the
Worker URL once and forget. `--worker` overrides it when both are set.

```bash
export EDGESHARP_OG_URL=https://og.example.com
edgesharp-og purge https://yoursite.com/article
edgesharp-og refresh https://yoursite.com
```

## Authorization

The og Worker authorizes by **Referer** — the request must come from
an origin in `ALLOWED_ORIGINS` (a Secret you set on your deployed
Worker). The CLI sends:

| Command | Referer header |
|---|---|
| `purge <page-url>` | the page URL exactly as you typed it |
| `refresh <origin-url>` | the origin (path stripped), e.g. `https://yoursite.com/` |

The CLI doesn't introduce any new auth surface — the Worker enforces
the same allowlist whether the caller is `curl`, a browser, or this
CLI. If the URL you're calling about isn't on `ALLOWED_ORIGINS`, you
get a `403` and the CLI prints the Worker's reason on stderr:

```
$ edgesharp-og purge https://attacker.example.com/x \
    --worker https://og.example.com
error: purge failed (403): Referer origin 'https://attacker.example.com' not in ALLOWED_ORIGINS
$ echo $?
1
```

There's no Cloudflare API token, account ID, or auth header involved.
Everything goes through the Worker's existing per-request authorization.

## Exit codes

| Code | When |
|---|---|
| 0 | Worker returned 2xx |
| 1 | Any error: missing `--worker`, invalid URL, network failure, non-2xx response from Worker |

Stdout stays clean on error so scripts can rely on `--json` output
being parseable. The Worker's response body (capped at 500 chars to
keep logs readable) goes to stderr alongside the status code.

## Examples

**One-off purge after editing a post:**

```bash
edgesharp-og purge https://yoursite.com/blog/my-post \
  --worker https://og.example.com
```

**Force a re-render across the whole site after a template change:**

```bash
edgesharp-og refresh https://yoursite.com \
  --worker https://og.example.com
```

**In a CI step after a content deploy:**

```yaml
- name: Refresh OG cards
  env:
    EDGESHARP_OG_URL: https://og.example.com
  run: npx edgesharp-og refresh https://yoursite.com --json
```

**Programmatic consumer (parse and act on counts):**

```bash
result=$(edgesharp-og refresh https://yoursite.com --json)
purged=$(echo "$result" | jq -r .purged)
echo "Refreshed $purged cards"
```

## Local development

```bash
cd og/cli
pnpm install
pnpm test       # node:test, no browser, no Worker needed
pnpm run build  # tsc -> dist/cli.js
```

Tests use `node:test` and a local mock HTTP server, so they don't need
a Worker, network, or any Cloudflare credentials.

For end-to-end testing against your real Worker:

```bash
node dist/cli.js purge https://your-allowed-origin.com/page \
  --worker https://your-og-worker.example.com
```
