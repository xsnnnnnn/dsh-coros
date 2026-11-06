/**
 * dsh-coros-mcp — shared configuration, token cache and OAuth 2.0 refresh helpers.
 *
 * The on-disk token cache is byte-compatible with COROS' official MCP gateway CLI
 * (~/.coros-mcp-skill-gateway-ts/<region>/token.json), so an existing login keeps
 * working and the official CLI can still manage the same cache:
 *
 *   { access_token, refresh_token, expires_at_epoch, token_type, scope, client_id }
 *
 * Nothing here talks to COROS unless a refresh is actually needed.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Official COROS MCP issuers, one per region. */
export const REGIONAL_ISSUERS = {
  cn: 'https://mcpcn.coros.com',
  eu: 'https://mcpeu.coros.com',
  us: 'https://mcpus.coros.com',
  default: 'https://mcp.coros.com',
};

export const DEFAULT_REGION = 'cn';
/** Official COROS MCP CLI cache — reused for zero-migration logins. */
export const LEGACY_CACHE_ROOT = path.join(homedir(), '.coros-mcp-skill-gateway-ts');
export const EXPIRY_SKEW_SECONDS = 300;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_SCOPES = 'openid offline_access mcp.tools';

/** DSH home directory ($DSH_HOME, default ~/.dsh). */
export function dshHome(env = process.env) {
  return env.DSH_HOME ? expandHome(String(env.DSH_HOME)) : path.join(homedir(), '.dsh');
}

/**
 * Canonical token location owned by this plugin: <DSH home>/coros-mcp.
 * Kept outside the profile so a profile config backup never captures tokens.
 */
export function defaultCacheRoot(env = process.env) {
  return path.join(dshHome(env), 'coros-mcp');
}

export const DEFAULT_CACHE_ROOT = defaultCacheRoot();

export class CorosConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorosConfigError';
  }
}

/** Expand a leading `~` so config values written by humans work. */
export function expandHome(value) {
  if (typeof value !== 'string' || !value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

/** Token cache roots in priority order: explicit > plugin-owned > legacy official CLI. */
export function candidateCacheRoots(options = {}, env = process.env) {
  const explicit = options.cacheRoot || env.COROS_MCP_CACHE_ROOT;
  if (explicit) return [expandHome(String(explicit))];
  const roots = [defaultCacheRoot(env), LEGACY_CACHE_ROOT];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

/** Token cache root: explicit option > COROS_MCP_CACHE_ROOT > <DSH home>/coros-mcp */
export function resolveCacheRoot(options = {}, env = process.env) {
  return candidateCacheRoots(options, env)[0];
}

function trimTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * Locate the token cache file.
 * With an explicit region only that region is considered; otherwise the newest
 * `<cacheRoot>/<region>/token.json` wins (mirrors the official CLI behaviour).
 */
export function findTokenFile(cacheRoot, region) {
  if (region) {
    const file = path.join(cacheRoot, region, 'token.json');
    return existsSync(file) ? { region, file } : undefined;
  }
  if (!existsSync(cacheRoot)) return undefined;
  const found = [];
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(cacheRoot, entry.name, 'token.json');
    if (existsSync(file)) found.push({ region: entry.name, file, mtime: statSync(file).mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0];
}

/** First token cache found across the candidate roots (priority order wins). */
export function findTokenInRoots(roots, region) {
  for (const root of roots) {
    const hit = findTokenFile(root, region);
    if (hit) return { ...hit, root };
  }
  return undefined;
}

/**
 * Resolve region / issuer / MCP endpoint / token file from options + environment.
 * `loggedIn: false` means the caller must authenticate before any API call.
 */
export function resolveTarget(options = {}, env = process.env) {
  const roots = candidateCacheRoots(options, env);
  const explicitRegion = options.region || env.COROS_MCP_REGION || undefined;
  const cached = findTokenInRoots(roots, explicitRegion);
  const region = explicitRegion || cached?.region || DEFAULT_REGION;
  const issuer = trimTrailingSlash(
    options.issuer || env.COROS_MCP_ISSUER || REGIONAL_ISSUERS[region] || REGIONAL_ISSUERS.default,
  );
  const mcpUrl = trimTrailingSlash(options.mcpUrl || env.COROS_MCP_URL || `${issuer}/mcp`);
  const cacheRoot = cached?.root ?? roots[0];
  const tokenFile = cached?.file ?? path.join(cacheRoot, region, 'token.json');
  return { cacheRoot, cacheRoots: roots, region, issuer, mcpUrl, tokenFile, loggedIn: Boolean(cached) };
}

export function readToken(file) {
  const token = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof token.access_token !== 'string' || !token.access_token) {
    throw new CorosConfigError(`${file} has no access_token; run "coros-mcp-login login-start" again`);
  }
  return token;
}

/** Atomic token write (tmp + rename) so a crash can never truncate a good cache. */
export function writeToken(file, token) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, 'utf8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* chmod is best effort on Windows */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function deleteToken(file) {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function tokenExpiryEpoch(token) {
  return Number(token?.expires_at_epoch ?? 0);
}

export function isTokenFresh(token, skewSeconds = EXPIRY_SKEW_SECONDS) {
  const expiresAt = tokenExpiryEpoch(token);
  if (!expiresAt) return false;
  return Math.floor(Date.now() / 1000) + skewSeconds < expiresAt;
}

/**
 * Cross-process advisory lock around a token file.
 *
 * COROS rotates the refresh_token on every refresh, so two refreshers racing
 * with the same refresh_token make one of them fail with invalid_grant and can
 * leave the account needing a brand-new login. The bridge and the login CLI
 * therefore serialise token reads/refreshes/writes through `<token.json>.lock`.
 * A lock older than `staleMs` is considered abandoned (crashed process).
 */
export const TOKEN_LOCK_TIMEOUT_MS = 30000;
export const TOKEN_LOCK_STALE_MS = 60000;

export function tokenLockPath(tokenFile) {
  return `${tokenFile}.lock`;
}

export async function withTokenLock(tokenFile, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? TOKEN_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? TOKEN_LOCK_STALE_MS;
  const lockFile = tokenLockPath(tokenFile);
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > staleMs) {
          unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CorosConfigError(`timed out waiting for the token lock ${lockFile}; remove it if no other COROS process is running`);
      }
      await new Promise((resolve) => setTimeout(resolve, 60 + Math.floor(Math.random() * 120)));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      /* lock already gone */
    }
  }
}

/**
 * Exchange the stored refresh_token for a fresh access token and persist it.
 *
 * Refresh is serialised through `withTokenLock`: inside the lock the cache is
 * re-read, so a token that another process already rotated is returned as-is
 * instead of consuming the same (now invalid) refresh_token twice.
 * Returns the new token record (same shape as the cache file).
 */
export async function refreshToken(issuer, tokenFile, token, options = {}) {
  const force = options.force === true;
  const expectedAccessToken = options.expectedAccessToken ?? token?.access_token;
  return withTokenLock(
    tokenFile,
    async () => {
      let current = token;
      try {
        current = readToken(tokenFile);
      } catch {
        /* keep the caller's copy when the cache is unreadable */
      }

      const rotatedByAnotherProcess =
        force &&
        expectedAccessToken !== undefined &&
        current?.access_token !== expectedAccessToken &&
        isTokenFresh(current, options.skewSeconds ?? EXPIRY_SKEW_SECONDS);
      if (rotatedByAnotherProcess) return current;
      if (!force && isTokenFresh(current, options.skewSeconds ?? EXPIRY_SKEW_SECONDS)) return current;
      if (!current?.refresh_token || !current?.client_id) {
        throw new CorosConfigError(
          `no refresh_token/client_id in ${tokenFile}; run "coros-mcp-login login-start" then "coros-mcp-login login-finish"`,
        );
      }

      const endpoint = options.tokenEndpoint ?? `${trimTrailingSlash(issuer)}/oauth2/token`;
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: String(current.client_id),
        refresh_token: String(current.refresh_token),
      });
      const response = await fetchJson(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
        },
        options.timeoutMs,
      );
      if (!response.ok) {
        throw new CorosConfigError(
          `token refresh failed (HTTP ${response.status}): ${JSON.stringify(response.body).slice(0, 300)}`,
        );
      }
      const payload = response.body;
      if (typeof payload.access_token !== 'string' || !payload.access_token) {
        throw new CorosConfigError('token refresh returned no access_token');
      }
      const next = {
        access_token: payload.access_token,
        refresh_token:
          typeof payload.refresh_token === 'string' && payload.refresh_token
            ? payload.refresh_token
            : current.refresh_token,
        expires_at_epoch: Math.floor(Date.now() / 1000) + Number(payload.expires_in ?? 3600),
        token_type: String(payload.token_type ?? current.token_type ?? 'Bearer'),
        scope: String(payload.scope ?? current.scope ?? ''),
        client_id: current.client_id,
      };
      writeToken(tokenFile, next);
      return next;
    },
    options,
  );
}

/**
 * Create a token provider that hands out a valid access token, refreshing when
 * it is within EXPIRY_SKEW_SECONDS of expiry or when `force` is set.
 * One provider per process; concurrent refreshes are single-flighted.
 */
export function createTokenProvider(target, options = {}) {
  const skewSeconds = options.skewSeconds ?? EXPIRY_SKEW_SECONDS;
  let cached;
  let inflight;

  function readDiskToken() {
    try {
      return readToken(target.tokenFile);
    } catch (error) {
      if (error instanceof CorosConfigError) return undefined;
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  return {
    async get(force = false) {
      const disk = readDiskToken();
      if (disk) cached = disk;
      if (!cached) {
        throw new CorosConfigError(
          `no COROS login found at ${target.tokenFile}; run "coros-mcp-login login-start" then "coros-mcp-login login-finish"`,
        );
      }
      if (!force && isTokenFresh(cached, skewSeconds)) return cached;
      if (!inflight) {
        inflight = refreshToken(target.issuer, target.tokenFile, cached, {
          ...options,
          force,
          expectedAccessToken: cached.access_token,
        }).finally(() => {
          inflight = undefined;
        });
      }
      cached = await inflight;
      return cached;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * Fetch wrapper with a hard timeout. Returns { ok, status, headers, body }
 * where body is parsed JSON when possible, otherwise raw text.
 * Network errors are re-thrown with a readable message.
 */
export async function fetchJson(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CorosConfigError(`request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new CorosConfigError(`request to ${url} failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: response.ok, status: response.status, headers, text, body };
}

/** Short human-readable status of the stored login (never prints token values). */
export function describeAuth(target, token) {
  const region = target.region;
  const expiresAt = tokenExpiryEpoch(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresIn = expiresAt ? expiresAt - nowSeconds : undefined;
  return {
    region,
    issuer: target.issuer,
    mcpUrl: target.mcpUrl,
    cacheRoot: target.cacheRoot,
    tokenFile: target.tokenFile,
    loggedIn: Boolean(token),
    tokenType: token?.token_type,
    scope: token?.scope,
    hasRefreshToken: Boolean(token?.refresh_token),
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : undefined,
    expiresInSeconds: expiresIn,
    expired: expiresIn !== undefined ? expiresIn <= 0 : undefined,
  };
}

/** Format bytes-free status for CLI output. */
export function formatAuthStatus(status) {
  const lines = [
    `region:        ${status.region}`,
    `issuer:        ${status.issuer}`,
    `mcp endpoint:  ${status.mcpUrl}`,
    `cache root:    ${status.cacheRoot}`,
    `token file:    ${status.tokenFile}`,
    `logged in:     ${status.loggedIn ? 'yes' : 'no'}`,
  ];
  if (status.loggedIn) {
    lines.push(`scope:         ${status.scope || '-'}`);
    lines.push(`refresh token: ${status.hasRefreshToken ? 'yes' : 'no'}`);
    const left = status.expiresInSeconds;
    const human =
      left === undefined
        ? 'unknown'
        : left <= 0
          ? `expired ${Math.abs(left)}s ago`
          : `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m left`;
    lines.push(`access token:  ${human} (${status.expiresAt ?? 'unknown expiry'})`);
  }
  return lines.join('\n');
}
