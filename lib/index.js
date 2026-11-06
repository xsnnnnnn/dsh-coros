/**
 * dsh-coros-mcp — host half (Cordis plugin) for DeepSeek Harness.
 *
 * The bundle patch inserts this plugin. At load time it registers the DSH MCP
 * client pointed at the stdio bridge shipped inside this package, so no absolute
 * path ever appears in a user's profile configuration.
 *
 * Verified against DSH 0.2.1-rc.5: a profile-installed bundle can import
 * `@deepseek-ai/dsh-mcp-client` (runtime packages resolve from profile code) and
 * `ctx.plugin(mcpClient, config)` mounts a working MCP client whose tools appear
 * as `mcp__<serverName>__<tool>`. Disposing the parent fiber removes the child
 * and its tools, so disabling the bundle disconnects COROS cleanly.
 *
 * All paths are resolved at runtime from `import.meta.url`; the package is
 * therefore relocatable (profile node_modules, linked checkout, tarball install).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = path.join(HERE, 'proxy.mjs');

export const name = 'dsh-coros-mcp';

/** True when a PATH-style bare command exists on this platform's PATH. */
function commandOnPath(command) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => extensions.some((extension) => existsSync(path.join(dir, `${command}${extension}`))));
}

/**
 * Node executable used to spawn the bridge.
 *
 * The plugin runs inside the DSH host, which may be Electron: `process.execPath`
 * can therefore be the desktop executable, not Node. Preference order:
 *   1. explicit `nodePath` config
 *   2. `DSH_DESKTOP_NODE_EXECUTABLE` (set by DSH for its child shells)
 *   3. the node runtime that ships with DSH desktop (`<DSH home>/dsh-runtimes/...`)
 *   4. `node` on PATH (CLI installs)
 *   5. the Electron binary re-entered as Node (ELECTRON_RUN_AS_NODE=1)
 */
export function resolveNodeExecutable(config = {}, env = process.env) {
  if (config.nodePath) return { command: config.nodePath, env: {} };
  if (env.DSH_DESKTOP_NODE_EXECUTABLE) return { command: env.DSH_DESKTOP_NODE_EXECUTABLE, env: {} };

  const dshHome = env.DSH_HOME;
  if (dshHome) {
    const candidates = [
      path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { command: candidate, env: {} };
    }
  }

  if (!process.versions.electron && commandOnPath('node')) return { command: 'node', env: {} };

  // Last resort: the Electron binary itself, explicitly re-entered as Node.
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Arguments for the bridge; explicit config overrides win over environment defaults. */
export function bridgeArgs(config = {}) {
  const args = [PROXY_PATH];
  if (config.cacheRoot) args.push('--cache-root', config.cacheRoot);
  if (config.region) args.push('--region', config.region);
  if (config.issuer) args.push('--issuer', config.issuer);
  if (config.mcpUrl) args.push('--mcp-url', config.mcpUrl);
  if (config.requestTimeoutMs) args.push('--timeout-ms', String(config.requestTimeoutMs));
  return args;
}

export function bridgeExists() {
  return existsSync(PROXY_PATH);
}

/** MCP client row config derived from the bundle entry config. */
export function mcpClientConfig(config = {}) {
  const node = resolveNodeExecutable(config);
  const row = {
    serverName: config.serverName ?? 'coros',
    transport: 'stdio',
    command: node.command,
    args: bridgeArgs(config),
    failOnStartupError: config.failOnStartupError ?? false,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 120000,
    reconnect: { enabled: true },
  };
  if (Object.keys(node.env).length > 0) row.env = { ...node.env };
  return row;
}

let cachedPlugin;

/** Resolve the MCP client plugin module exactly once per host process. */
export async function loadMcpClientPlugin() {
  if (cachedPlugin !== undefined) return cachedPlugin;
  try {
    const mod = await import('@deepseek-ai/dsh-mcp-client');
    cachedPlugin = mod;
  } catch {
    cachedPlugin = null;
  }
  return cachedPlugin;
}

export async function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('[coros-mcp] disabled by configuration');
    return;
  }
  if (!bridgeExists()) {
    ctx.logger?.warn?.('[coros-mcp] bridge script missing; plugin not connected');
    return;
  }
  const mod = await loadMcpClientPlugin();
  if (!mod?.apply) {
    ctx.logger?.warn?.(
      '[coros-mcp] cannot resolve @deepseek-ai/dsh-mcp-client in this host; COROS tools are unavailable',
    );
    return;
  }
  ctx.plugin(mod, mcpClientConfig(config));
}

export const inject = [];
