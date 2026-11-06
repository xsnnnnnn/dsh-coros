# dsh-coros-mcp

Bridges the official **COROS (高驰) MCP** server into DeepSeek Harness. One install exposes the full `mcp__coros__*` tool set: sleep, HRV, resting heart rate, recovery, training load, activities and FIT files, plus workout / training-plan CRUD and scheduling (34 tools on the current endpoint; may change with the server).

Self-contained: the stdio bridge, the OAuth login flow and token refresh all live in this package. No external CLI, no absolute paths in your profile, no local callback port.

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

## Install

Requires DeepSeek Harness `0.2.1` / `0.2.2` RC lines (enforced by `engines.dsh`) and Node.js ≥ 20 (the DSH runtime provides one).

```powershell
# tarball (recommended for sharing)
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'file:D:\path\to\dsh-coros-mcp-1.0.1.tgz'

# linked directory (development)
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\path\to\dsh-coros-mcp'

# straight from this GitHub repository
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:xsnnnnnn/dsh'
```

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
| Tools disappear after a DSH upgrade | check `engines.dsh` covers the new DSH version; otherwise the host refuses to load the plugin |

## Privacy

Tokens never leave the machine, are stored 0600 outside the profile, and are never printed; logs contain only region, endpoint and expiry metadata. The plugin makes no network request at startup — only tool calls, `--selftest` and explicit login/refresh commands reach COROS.

## Development

```powershell
npm test                 # 39 unit + mock-issuer end-to-end tests (no network)
npm run status           # offline status
npm run selftest         # real endpoint: initialize + tools/list
npm pack                 # prepack runs scripts/prepack-check.mjs
```

## Compatibility & license

- `engines.dsh`: `>=0.2.1-rc.1 <=0.2.1 || >=0.2.2-rc.1 <0.2.3-0`; `dsh.compatibility.dshReleases`: `0.2.1-rc.5`, `0.2.2-rc.1` = compatible.
- Node.js ≥ 20, no third-party runtime dependencies.
- MIT. COROS and 高驰 are trademarks of their owner; this project is unofficial.
- Protocol details were derived from the public COROS gateway endpoints and the official CLI's observable behaviour; no code from the UNLICENSED official npm packages is copied or bundled.

See [README.zh.md](README.zh.md) for the full Chinese documentation.
