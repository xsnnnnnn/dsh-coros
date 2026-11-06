# dsh-coros-mcp

<p>
  <a href="https://github.com/xsnnnnnn/dsh-coros"><img alt="GitHub repo" src="https://img.shields.io/badge/github-xsnnnnnn%2Fdsh--coros-181717?logo=github"></a>
  <img alt="DeepSeek Harness" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5%20%7C%200.2.2--rc.1-4B8BBE">
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Tests" src="https://img.shields.io/badge/tests-42%20passing-brightgreen">
</p>

Bridges the official **COROS (高驰) MCP** server into DeepSeek Harness. One install exposes the full `mcp__coros__*` tool set: sleep, HRV, resting heart rate, recovery, training load, activities and FIT files, plus workout / training-plan CRUD and scheduling (34 tools on the current endpoint; may change with the server).

Self-contained: the stdio bridge, the OAuth login flow and token refresh all live in this package. No external CLI, no absolute paths in your profile, no local callback port.

## Highlights

- **Zero runtime dependencies** — plain Node.js built-ins (`fetch`, `crypto`, `fs`, `http`); nothing to `npm install`.
- **Self-contained OAuth** — dynamic client registration + PKCE(S256) + COROS CLI login-session flow; `login-start` / `login-finish` are separate processes and open **no local port**.
- **Survives DSH upgrades** — `engines.dsh` is a bottomless minimum (`>=0.2.1-rc.1`), and if a future DSH changes the MCP-client JS API the plugin falls back to mounting the same row through the core Cordis Loader. It is not silently gated off by a version bump.
- **Tokens stay local** — `~/.dsh/coros-mcp/<region>/token.json` (0600), outside the profile config, never printed in logs, no telemetry, no third-party server in the data path.
- **Bridge fixes real MCP schema issues** — COROS serves `tools/list` schemas with top-level `$defs`/`$ref`; the bridge inlines them so providers do not reject `createScheduledWorkout` with `Pointer '/$defs/Section' does not exist`.
- **Rotation-safe refresh** — COROS rotates the refresh token on every refresh; bridge and login CLI serialise refreshes with one cross-process file lock.
- **Works Outside DSH too** — `lib/proxy.mjs` is a standard MCP stdio server usable from any MCP client.

---

## Architecture

```
DeepSeek Harness
  └─ dsh-coros-mcp (host plugin, this package)
        └─ registers the DSH MCP client (serverName=coros)
              │  JSON-RPC / stdio
              ▼
        lib/proxy.mjs   bridge: token cache, refresh with a file lock, tools/list $ref inlining
              │  HTTPS POST + Authorization: Bearer <access_token>
              ▼
        https://mcpcn.coros.com/mcp   (official COROS MCP, CN region)
```

The bridge exists because DSH's MCP client speaks stdio / static headers while the COROS endpoint requires expiring OAuth 2.0 bearer tokens.

Login (`lib/login.mjs`) uses COROS' gateway CLI login session: dynamic client registration + PKCE(S256) + browser authorization + polling for the one-time `loginTicket` + server-side code exchange. No local listener is started, so `login-start` and `login-finish` are independent processes and Windows has no port conflicts.

## Does a DSH upgrade disable it?

**No longer because of a version mismatch.** How it works:

- At profile start DSH evaluates `engines.dsh` (`app-boot` → `evaluatePluginCompatibility`) with `semver.satisfies(..., { includePrerelease: true })`. Earlier builds declared a **finite** range (the 0.2.1 line plus a single 0.2.2 RC); when DSH auto-updated to a newer RC the range no longer matched, so the plugin was skipped silently — that is why the COROS tools disappeared after a DSH update.
- Since 1.0.2 `engines.dsh` is a **bottomless minimum**: `>=0.2.1-rc.1`. With `includePrerelease: true` that covers 0.2.1, 0.2.2, future 0.2.x RCs, 0.3.x, 1.x — **normal DSH upgrades will not gate it out again**.
- Belt and braces: if a future DSH release changes the `@deepseek-ai/dsh-mcp-client` JS exports, the plugin falls back to mounting the same MCP-client row through the core Cordis Loader (`ctx.loader.create`, the same path profile patches use). Only when both registration paths fail does it log an explicit `[coros-mcp] could not attach the DSH MCP client` warning.
- The one case not guaranteed: a breaking DSH API change where both registration paths are gone. Install a freshly built plugin for that DSH version; tokens and login state are unaffected.

> A GitHub/tarball install does not auto-upgrade the plugin itself; re-run `dsh plugin add <new tgz>` when a new build is available.

## Install

Requires DeepSeek Harness ≥ `0.2.1-rc.1` (`engines.dsh` is a bottomless range, so future versions are not blocked) and Node.js ≥ 20 (the DSH runtime provides one).

```powershell
# tarball (recommended for sharing)
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:xsnnnnnn/dsh-coros'

# linked directory (development)
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\path\to\dsh-coros-mcp'
```

> No local build needed: download `dsh-coros-mcp-<version>.tgz` from [GitHub Releases](https://github.com/xsnnnnnn/dsh-coros/releases),
> or install straight from the repository: `dsh plugin --profile desktop add 'github:xsnnnnnn/dsh-coros'`.

Then enable `dsh-coros-mcp` in **Settings → Plugins** and restart DSH if needed.

> Migrating from a hand-wired setup: back up the profile `cordis.patch.yml` and delete the manual `id: mcp-coros` `@deepseek-ai/dsh-mcp-client` row. Keeping both registers the same `mcp__coros__*` tool names twice and the tool registration fails.

## Login

```powershell
node '<package>\lib\login.mjs' login-start    # prints/opens the authorization URL
node '<package>\lib\login.mjs' login-finish   # completes the session, caches the token
node '<package>\lib\login.mjs' login-status   # offline status
node '<package>\lib\login.mjs' refresh        # refresh now
node '<package>\lib\login.mjs' logout         # delete local token/pending files
```

- Tokens live in `~/.dsh/coros-mcp/<region>/token.json` (0600, atomic writes). That is outside the profile directory, so profile-config backups never capture them.
- Existing `~/.coros-mcp-skill-gateway-ts/<region>/token.json` (the official COROS CLI cache) is read as a fallback, so an existing login keeps working with zero migration. A new login writes to the plugin-owned path, which wins afterwards.
- Access tokens last 30 days. The **refresh token rotates on every refresh and the old value dies immediately**, so the bridge and the login CLI serialise refreshes with one file lock (`token.json.lock`).
- Region: inferred from the cache; override with `--region cn|eu|us` or configuration.

## Configuration

Optional `config:` fields on the bundle row (defaults are built in):

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `coros` | Tool prefix (`mcp__coros__*`) |
| `cacheRoot` | `$DSH_HOME/coros-mcp` | Token cache root |
| `region` | inferred | `cn` / `eu` / `us` |
| `issuer` | per region | Override the OAuth issuer |
| `mcpUrl` | `<issuer>/mcp` | Override the MCP endpoint |
| `nodePath` | auto-detected | Node executable used to spawn the bridge |
| `requestTimeoutMs` | `30000` | Per-request timeout towards COROS |
| `toolCallTimeoutMs` | `120000` | Per-tool-call timeout (DSH side) |
| `failOnStartupError` | `false` | Fail profile startup when the bridge cannot start |
| `enabled` | `true` | Keep installed but disconnected when `false` |

Environment fallbacks (lower priority): `COROS_MCP_CACHE_ROOT`, `COROS_MCP_REGION`, `COROS_MCP_ISSUER`, `COROS_MCP_URL`, `COROS_MCP_TIMEOUT_MS`.

## Standalone use

`lib/proxy.mjs` is a plain MCP stdio server and works with any MCP client:

```jsonc
{
  "mcpServers": {
    "coros": { "command": "node", "args": ["D:\\path\\to\\dsh-coros-mcp\\lib\\proxy.mjs"] }
  }
}
```

Diagnostics:

```powershell
node lib\proxy.mjs --status      # region / cache / expiry, offline
node lib\proxy.mjs --selftest    # real initialize + tools/list against COROS
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `mcp__coros__*` tools | `node lib\proxy.mjs --status`; search DSH logs for stderr lines starting with `[coros-mcp]` |
| `no COROS login found` | run `login-start` / `login-finish` |
| `token refresh failed (HTTP 400)` | refresh token rotated/revoked — log in again |
| `timed out waiting for the token lock` | delete `token.json.lock` after confirming no other COROS process runs |
| Tools disappear after a DSH upgrade | 1.0.2+ is no longer gated by the version check; if it still happens, search the DSH log for `[coros-mcp]` (likely an MCP-client API change) and install the plugin build for that DSH version |

## Privacy

Tokens never leave the machine, are stored 0600 outside the profile, and are never printed; logs contain only region, endpoint and expiry metadata. The plugin makes no network request at startup — only tool calls, `--selftest` and explicit login/refresh commands reach COROS.

## Development

```powershell
npm test                 # 39 unit + mock-issuer end-to-end tests (no network)
npm run status           # offline status
npm run selftest         # real endpoint: initialize + tools/list
npm pack                 # prepack runs scripts/prepack-check.mjs
```

## Repository layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Host half: registers the DSH MCP client (direct import + Loader fallback) |
| `lib/proxy.mjs` | stdio↔HTTP bridge (`--status` / `--selftest` / MCP stdio server) |
| `lib/login.mjs` | Self-contained OAuth: `login-start` / `login-finish` / `login-status` / `refresh` / `logout` |
| `lib/config.mjs` | Token cache, region resolution, refresh with a cross-process file lock |
| `cordis.patch.yml` · `dsh.plugin.json` | Bundle manifest and plugin metadata |
| `assets/icon.png` | Plugin icon (DSH plugin page / marketplace card) |
| `test/` | 42 offline tests, including the full mock-issuer login/refresh flow |
| `scripts/prepack-check.mjs` | Pre-publish static checks (manifest/icon/secret leakage) |

## Compatibility & license

- `engines.dsh`: `>=0.2.1-rc.1` (**no upper bound**, covers future releases; DSH evaluates with `includePrerelease: true`); `dsh.compatibility.dshReleases`: `0.2.1-rc.5`, `0.2.2-rc.1` = compatible.
- Node.js ≥ 20, no third-party runtime dependencies.
- MIT. COROS and 高驰 are trademarks of their owner; this project is unofficial.
- Protocol details were derived from the public COROS gateway endpoints and the official CLI's observable behaviour; no code from the UNLICENSED official npm packages is copied or bundled.

See [README.zh.md](README.zh.md) for the full Chinese documentation.
