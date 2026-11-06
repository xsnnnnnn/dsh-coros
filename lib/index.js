/**
 * dsh-coros-mcp — host half (Cordis plugin) for DeepSeek Harness.
 *
 * The bundle patch inserts this plugin. At load time it registers the DSH MCP
 * client pointed at the bridge shipped inside this package, so no absolute path
 * ever appears in a user's profile configuration, and DSH version upgrades do
 * not invalidate a machine-specific path.
 *
 * Update resilience (why this file has two registration paths):
 *   1. Primary: import `@deepseek-ai/dsh-mcp-client` (runtime package resolved
 *      from the DSH installation) and mount it with `ctx.plugin`. Verified on
 *      DSH 0.2.1-rc.5 and 0.2.2-rc.1.
 *   2. Fallback: if that import/API ever changes in a future DSH release, create
 *      the same MCP-client row through the core Loader (`ctx.loader.create`),
 *      which is the same code path profile patches use. This keeps the plugin
 *      working across minor-version refactors of the MCP-client package.
 *
 * The version gate lives in `package.json` `engines.dsh`; it is a bottomless
 * range on purpose (see README "DSH 升级后还会失效吗").
 *
 * All paths are resolved at runtime from `import.meta.url`; the package is
 * therefore relocatable (profile node_modules, linked checkout, tarball install).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = path.join(HERE, 'proxy.mjs');
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const FALLBACK_ROW_ID = 'dsh-coros-mcp-server';
/** Test hook: force the Loader fallback path to verify it without patching DSH. */
const FORCE_FALLBACK_ENV = 'COROS_MCP_FORCE_LOADER_FALLBACK';

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
  if (env.DSH_DESKTOP_NODE_EXECUTABLE && existsSync(env.DSH_DESKTOP_NODE_EXECUTABLE)) {
    return { command: env.DSH_DESKTOP_NODE_EXECUTABLE, env: {} };
  }

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

/**
 * Resolve the MCP client plugin module exactly once per host process.
 * Returns `null` when the runtime package is unavailable (or when the fallback
 * test hook is enabled), so `apply` can use the Loader path instead.
 */
export async function loadMcpClientPlugin() {
  if (process.env[FORCE_FALLBACK_ENV] === '1') return null;
  if (cachedPlugin !== undefined) return cachedPlugin;
  try {
    cachedPlugin = await import(MCP_CLIENT_PACKAGE);
  } catch {
    cachedPlugin = null;
  }
  return cachedPlugin;
}

/** The Loader service (core cordis loader) — used only by the fallback path. */
function findLoader(ctx) {
  try {
    if (ctx?.loader?.create) return ctx.loader;
    const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : undefined;
    return loader?.create ? loader : undefined;
  } catch {
    return undefined;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mount the MCP client through the Loader (the same mechanism profile patches
 * use). Works even when importing the package from plugin code is unsupported.
 */
async function registerWithLoaderRow(ctx, config) {
  const loader = findLoader(ctx);
  if (!loader) return false;
  try {
    await loader.create({
      id: FALLBACK_ROW_ID,
      name: MCP_CLIENT_PACKAGE,
      config: mcpClientConfig(config),
    });
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`[coros-mcp] loader fallback could not mount the MCP client: ${errorText(error)}`);
    return false;
  }
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

  // Cleanup for the Loader fallback row. Registered synchronously because
  // cordis effects belong to the apply phase; disposing this plugin then
  // removes the child row and its tools.
  let fallbackRowId;
  try {
    ctx.effect?.(
      () => () => {
        if (!fallbackRowId) return;
        try {
          findLoader(ctx)?.remove?.(fallbackRowId);
        } catch {
          /* already gone */
        }
      },
      'coros-mcp.loader-fallback',
    );
  } catch {
    /* effect unavailable: the row would simply outlive the plugin */
  }

  // Path 1: normal JS registration (works on the DSH releases we tested).
  try {
    const mod = await loadMcpClientPlugin();
    if (mod?.apply) {
      const fiber = ctx.plugin(mod, mcpClientConfig(config));
      if (fiber && typeof fiber.await === 'function') {
        fiber.await().catch((error) => {
          ctx.logger?.warn?.(`[coros-mcp] MCP client did not start: ${errorText(error)}`);
        });
      }
      return;
    }
    ctx.logger?.warn?.(`[coros-mcp] ${MCP_CLIENT_PACKAGE} import returned no plugin; trying the Loader fallback`);
  } catch (error) {
    ctx.logger?.warn?.(`[coros-mcp] ${MCP_CLIENT_PACKAGE} import failed (${errorText(error)}); trying the Loader fallback`);
  }

  // Path 2: Loader row fallback, used when the runtime package API changes.
  if (await registerWithLoaderRow(ctx, config)) {
    fallbackRowId = FALLBACK_ROW_ID;
    ctx.logger?.info?.('[coros-mcp] MCP client mounted through the Loader fallback');
    return;
  }

  ctx.logger?.warn?.(
    '[coros-mcp] could not attach the DSH MCP client (both the direct import and the Loader fallback failed). ' +
      'COROS tools are unavailable. Run "node lib/proxy.mjs --status" for the bridge, then install a plugin build for the current DSH version.',
  );
}

export const inject = [];
