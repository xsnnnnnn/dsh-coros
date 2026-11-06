/**
 * dsh-coros-mcp — self-contained OAuth 2.0 login for the COROS MCP endpoint.
 *
 * No third-party dependencies and no local callback port: COROS' gateway exposes
 * a CLI login-session API, so `login-start` and `login-finish` are separate
 * processes that communicate through a pending file (same idea as the official
 * COROS CLI, protocol facts verified against the real endpoints).
 *
 *   login-start    Dynamic client registration (RFC 7591, public client) + PKCE
 *                  (S256) + COROS CLI login session -> pending-login.json and a
 *                  browser URL.
 *   login-finish   Poll the session claim (X-Poll-Token) until the user has
 *                  authorised, take the one-time login_ticket, replay the
 *                  authorize URL server-side (redirect: manual) to receive the
 *                  authorization code, then exchange code+verifier for tokens.
 *   login-status   Offline summary of token / pending state.
 *   refresh        Refresh the access token now (serialised behind a file lock
 *                  because COROS rotates the refresh_token on every refresh).
 *   logout         Delete the local token and pending files.
 *
 * Token cache format is identical to the official COROS MCP CLI, and the
 * plugin's bridge reads the same file.
 *
 * Usage:
 *   node lib/login.mjs login-start [--region cn|eu|us] [--issuer <url>] [--cache-root <dir>] [--no-browser] [--json]
 *   node lib/login.mjs login-finish [--timeout 300] [--interval 3] [--json]
 *   node lib/login.mjs login-status [--json]
 *   node lib/login.mjs refresh [--force] [--json]
 *   node lib/login.mjs logout [--json]
 */

import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CACHE_ROOT,
  DEFAULT_REGION,
  DEFAULT_SCOPES,
  LEGACY_CACHE_ROOT,
  REGIONAL_ISSUERS,
  candidateCacheRoots,
  fetchJson,
  findTokenInRoots,
  isTokenFresh,
  readToken,
  refreshToken,
  tokenExpiryEpoch,
  withTokenLock,
  writeToken,
} from './config.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSION = '1.0.0';

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:43123/callback';
const DEFAULT_CLIENT_NAME = 'DSH COROS MCP';
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;
const FALLBACK_EXPIRES_IN_SECONDS = 3600;
const EXIT = { OK: 0, USAGE: 2, AUTH: 3, PENDING: 4 };

const ISSUER_TO_REGION = {
  'https://mcpcn.coros.com': 'cn',
  'https://mcpeu.coros.com': 'eu',
  'https://mcpus.coros.com': 'us',
};

export class LoginError extends Error {
  constructor(message, exitCode = EXIT.AUTH) {
    super(message);
    this.name = 'LoginError';
    this.exitCode = exitCode;
  }
}

const nowEpoch = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function normalizeIssuer(issuer) {
  return String(issuer ?? '').replace(/\/+$/, '');
}

function isLoopbackIssuer(issuer) {
  try {
    const url = new URL(issuer);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertSafeIssuer(issuer) {
  let url;
  try {
    url = new URL(issuer);
  } catch {
    throw new LoginError(`invalid issuer: ${issuer}`, EXIT.USAGE);
  }
  if (url.protocol !== 'https:' && !isLoopbackIssuer(issuer)) {
    throw new LoginError(`refusing a non-https issuer (loopback mock excepted): ${issuer}`, EXIT.USAGE);
  }
  return normalizeIssuer(issuer);
}

function regionForIssuer(issuer) {
  const normalized = normalizeIssuer(issuer);
  if (ISSUER_TO_REGION[normalized]) return ISSUER_TO_REGION[normalized];
  try {
    const host = new URL(normalized).hostname;
    if (host) return host.replace(/\./g, '-').replace(/[^a-zA-Z0-9_-]/g, '_');
  } catch {
    /* fallthrough */
  }
  return 'default';
}

function issuerForRegion(region) {
  const key = String(region ?? '').toLowerCase();
  if (!(key in REGIONAL_ISSUERS)) {
    throw new LoginError(`unknown region "${region}"; expected ${Object.keys(REGIONAL_ISSUERS).join(' / ')}`, EXIT.USAGE);
  }
  return REGIONAL_ISSUERS[key];
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function removeFile(file) {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

function maskId(value) {
  const text = String(value ?? '');
  if (!text) return '<empty>';
  return text.length <= 10 ? `${text.slice(0, 2)}…<redacted>` : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function describeErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') return String(payload).slice(0, 200);
  const error = payload.error || payload.result || payload.message || payload._raw || '';
  const description = payload.error_description || payload.errorCode || '';
  return `${error}${description ? ` — ${description}` : ''}`.slice(0, 300) || JSON.stringify(payload).slice(0, 200);
}

async function discoverMetadata(issuer, options = {}) {
  const normalized = assertSafeIssuer(issuer);
  const candidates = [
    `${normalized}/.well-known/oauth-authorization-server`,
    `${normalized}/.well-known/openid-configuration`,
  ];
  let lastError;
  for (const url of candidates) {
    try {
      const response = await fetchJson(url, { headers: { Accept: 'application/json' } }, options.timeoutMs);
      if (response.status !== 200) {
        lastError = new Error(`${url} -> HTTP ${response.status}`);
        continue;
      }
      const metadata = response.body ?? {};
      const tokenEndpoint = metadata.token_endpoint;
      const authorizationEndpoint = metadata.authorization_endpoint;
      const metadataIssuer = normalizeIssuer(metadata.issuer || normalized);
      if (!tokenEndpoint || !authorizationEndpoint) {
        lastError = new Error(`${url} lacks authorization_endpoint / token_endpoint`);
        continue;
      }
      return {
        issuer: metadataIssuer,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: options.tokenEndpoint || tokenEndpoint,
        registration_endpoint: normalizeIssuer(
          metadata.registration_endpoint || `${metadataIssuer}/connect/register`,
        ),
        scopes_supported: metadata.scopes_supported || null,
        grant_types_supported: metadata.grant_types_supported || null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new LoginError(`cannot read OAuth metadata from ${normalized}: ${lastError?.message ?? 'unknown'}`, EXIT.AUTH);
}

/** RFC 7591 dynamic client registration; COROS issues a public client (no secret). */
async function registerClient(metadata, { clientName, redirectUri, scope, timeoutMs }) {
  const response = await fetchJson(
    metadata.registration_endpoint,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope,
        token_endpoint_auth_method: 'none',
      }),
    },
    timeoutMs,
  );
  const payload = response.body ?? {};
  if (response.status !== 200 && response.status !== 201) {
    throw new LoginError(`client registration failed (HTTP ${response.status}): ${describeErrorPayload(payload)}`);
  }
  if (typeof payload.client_id !== 'string' || !payload.client_id) {
    throw new LoginError('client registration response has no client_id');
  }
  return payload.client_id;
}

export function generatePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier, 'utf8').digest());
  return { verifier, challenge, method: 'S256' };
}

export function buildAuthorizeUrl(metadata, { clientId, redirectUri, scope, challenge, state, mcpUrl }) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: mcpUrl,
    state,
  });
  return `${metadata.authorization_endpoint}?${query.toString()}`;
}

/** COROS CLI login session: gives a browser loginUrl plus polling credentials. */
async function createCliLoginSession(issuer, clientId, timeoutMs) {
  const response = await fetchJson(
    `${normalizeIssuer(issuer)}/api/v1/cli/login-sessions`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    },
    timeoutMs,
  );
  const payload = response.body ?? {};
  if (response.status !== 200 && response.status !== 201) {
    throw new LoginError(`CLI login session failed (HTTP ${response.status}): ${describeErrorPayload(payload)}`);
  }
  for (const field of ['sessionId', 'pollToken', 'loginUrl']) {
    if (typeof payload[field] !== 'string' || !payload[field]) {
      throw new LoginError(`CLI login session response has no ${field}`);
    }
  }
  const expiresAtEpoch = Number.isFinite(Date.parse(payload.expiresAt))
    ? Math.floor(Date.parse(payload.expiresAt) / 1000)
    : nowEpoch() + 600;
  return {
    sessionId: payload.sessionId,
    pollToken: payload.pollToken,
    loginUrl: payload.loginUrl,
    expiresAtEpoch,
    pollInterval: Math.max(1, Number(payload.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) || DEFAULT_POLL_INTERVAL_SECONDS),
  };
}

async function pollLoginSession(issuer, pending, options = {}) {
  const timeoutSeconds = Number.isFinite(options.timeoutSeconds) ? options.timeoutSeconds : DEFAULT_LOGIN_TIMEOUT_SECONDS;
  const intervalSeconds =
    Number.isFinite(options.intervalSeconds) && options.intervalSeconds > 0
      ? options.intervalSeconds
      : Number(pending.poll_interval) > 0
        ? Number(pending.poll_interval)
        : DEFAULT_POLL_INTERVAL_SECONDS;
  if (Number(pending.expires_at_epoch) > 0 && nowEpoch() >= Number(pending.expires_at_epoch)) {
    throw new LoginError('the login session expired; run login-start again', EXIT.PENDING);
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  const claimUrl = `${normalizeIssuer(issuer)}/api/v1/cli/login-sessions/${encodeURIComponent(pending.session_id)}/claim`;
  for (;;) {
    const response = await fetchJson(
      claimUrl,
      { method: 'POST', headers: { 'X-Poll-Token': pending.poll_token, Accept: 'application/json' } },
      options.timeoutMs,
    );
    const payload = response.body ?? {};
    if (response.status !== 200) {
      throw new LoginError(`login session claim failed (HTTP ${response.status}): ${describeErrorPayload(payload)}`);
    }
    const status = String(payload.status ?? '').toLowerCase();
    if (status === 'authorized') {
      if (typeof payload.loginTicket !== 'string' || !payload.loginTicket) {
        throw new LoginError('login session is authorized but has no loginTicket');
      }
      return payload.loginTicket;
    }
    if (status === 'pending') {
      if (Date.now() >= deadline) {
        throw new LoginError(
          `timed out after ${timeoutSeconds}s waiting for the browser authorization; the pending session is kept, rerun login-finish to continue`,
          EXIT.PENDING,
        );
      }
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (status === 'failed') throw new LoginError(`login failed: ${payload.errorCode || 'unknown_error'}`);
    if (status === 'expired') throw new LoginError('the login session expired; run login-start again', EXIT.PENDING);
    if (status === 'claimed') {
      throw new LoginError(`the login session was already used (${payload.errorCode || 'already_claimed'}); run login-start again`, EXIT.PENDING);
    }
    throw new LoginError(`login session returned an unknown status: ${status || describeErrorPayload(payload)}`);
  }
}

/**
 * Server-side completion of the authorization request: replay the authorize URL
 * with the one-time login_ticket and read the authorization code from the 302
 * Location. No local HTTP listener is involved.
 */
async function exchangeLoginTicketForCode(authorizeUrl, loginTicket, expectedState, timeoutMs) {
  const url = new URL(authorizeUrl);
  url.searchParams.append('login_ticket', loginTicket);
  const response = await fetchJson(url.toString(), { method: 'GET', redirect: 'manual' }, timeoutMs);
  const location = response.headers.location;
  const isRedirect = [302, 303, 307].includes(response.status);
  if (!isRedirect || !location) {
    const preview = String(response.text ?? '').slice(0, 200);
    throw new LoginError(`authorization did not redirect to the client callback (HTTP ${response.status}${preview ? `: ${preview}` : ''})`);
  }
  let callback;
  try {
    callback = new URL(location, authorizeUrl);
  } catch {
    throw new LoginError('the callback Location is not a valid URL');
  }
  const code = callback.searchParams.get('code') || '';
  if (!code) throw new LoginError('the callback has no code parameter');
  if (callback.searchParams.get('state') !== expectedState) {
    throw new LoginError('state mismatch (session confusion or a tampered cache)');
  }
  return code;
}

async function exchangeCodeForToken(metadata, { clientId, code, codeVerifier, redirectUri, timeoutMs }) {
  const response = await fetchJson(
    metadata.token_endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    },
    timeoutMs,
  );
  const payload = response.body ?? {};
  if (response.status !== 200) {
    throw new LoginError(`authorization code exchange failed (HTTP ${response.status}): ${describeErrorPayload(payload)}`);
  }
  return tokenSetFromResponse(payload, { clientId });
}

/** token response -> the exact six-field cache shape the official CLI uses. */
export function tokenSetFromResponse(payload, { clientId, previous } = {}) {
  if (!payload || typeof payload !== 'object') throw new LoginError('token response is not a JSON object');
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new LoginError('token response has no access_token');
  }
  const refreshTokenValue =
    typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : previous?.refresh_token;
  if (!refreshTokenValue) throw new LoginError('token response has no refresh_token and there is no previous value');
  const expiresIn = Number(payload.expires_in);
  const tokenSet = {
    access_token: payload.access_token,
    refresh_token: refreshTokenValue,
    expires_at_epoch:
      nowEpoch() + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : FALLBACK_EXPIRES_IN_SECONDS),
    token_type: String(payload.token_type || previous?.token_type || 'Bearer'),
    scope: String(payload.scope || previous?.scope || DEFAULT_SCOPES),
    client_id: clientId || previous?.client_id,
  };
  if (!tokenSet.client_id) throw new LoginError('cannot determine client_id');
  return tokenSet;
}

/** Resolve where login state lives: always the plugin-owned cache root, legacy read-only fallback. */
export function resolveLoginPaths(args = {}) {
  const roots = candidateCacheRoots({ cacheRoot: args.cacheRoot }, process.env);
  const root = roots[0];
  const explicitRegion = args.region ? String(args.region).toLowerCase() : '';
  let issuer = args.issuer ? assertSafeIssuer(args.issuer) : '';
  if (!issuer && explicitRegion) issuer = issuerForRegion(explicitRegion);
  let region = explicitRegion;
  if (!issuer) {
    for (const candidateRoot of roots) {
      if (!existsSync(candidateRoot)) continue;
      for (const entry of readdirSync(candidateRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tokenFile = path.join(candidateRoot, entry.name, 'token.json');
        if (existsSync(tokenFile)) {
          region = entry.name;
          issuer = REGIONAL_ISSUERS[entry.name] || '';
          break;
        }
      }
      if (issuer) break;
    }
  }
  if (!issuer) {
    issuer = REGIONAL_ISSUERS[DEFAULT_REGION];
    region = DEFAULT_REGION;
  }
  region = region || regionForIssuer(issuer);
  return {
    root,
    roots,
    region,
    issuer: normalizeIssuer(issuer),
    tokenPath: path.join(root, region, 'token.json'),
    pendingPath: path.join(root, region, 'pending-login.json'),
    legacyTokenPath: path.join(LEGACY_CACHE_ROOT, region, 'token.json'),
  };
}

/** Find the newest pending-login.json across candidate roots, for login-finish. */
function findPendingLogin(paths) {
  const direct = readJsonFile(paths.pendingPath);
  if (direct) return { pending: direct, pendingPath: paths.pendingPath };
  for (const root of paths.roots) {
    if (!existsSync(root)) continue;
    const candidates = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'pending-login.json');
      if (existsSync(file)) candidates.push({ file, mtime: statSync(file).mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) {
      const pending = readJsonFile(candidates[0].file);
      if (pending) return { pending, pendingPath: candidates[0].file };
    }
  }
  return undefined;
}

function openInBrowser(url) {
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function printResult(payload, humanLines, json) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else for (const line of humanLines) process.stdout.write(`${line}\n`);
}

/**
 * Start a login: discover metadata, register the client, create the COROS CLI
 * login session, persist pending state and return the browser URL.
 */
export async function loginStart(args = {}) {
  const paths = resolveLoginPaths(args);
  const metadata = await discoverMetadata(paths.issuer, {
    tokenEndpoint: args.tokenEndpoint,
    timeoutMs: args.requestTimeoutMs,
  });
  const issuer = normalizeIssuer(metadata.issuer);
  const redirectUri = args.redirectUri || DEFAULT_REDIRECT_URI;
  const scope = args.scope || DEFAULT_SCOPES;
  const mcpUrl = args.mcpUrl || `${issuer}/mcp`;
  const clientId = await registerClient(metadata, {
    clientName: args.clientName || DEFAULT_CLIENT_NAME,
    redirectUri,
    scope,
    timeoutMs: args.requestTimeoutMs,
  });
  const pkce = generatePkce();
  const state = b64url(randomBytes(24));
  const authorizeUrl = buildAuthorizeUrl(metadata, {
    clientId,
    redirectUri,
    scope,
    challenge: pkce.challenge,
    state,
    mcpUrl,
  });
  const session = await createCliLoginSession(issuer, clientId, args.requestTimeoutMs);

  const pending = {
    // official CLI pending-login.json fields (kept interoperable)
    client_id: clientId,
    verifier: pkce.verifier,
    state,
    authorize_url: authorizeUrl,
    session_id: session.sessionId,
    poll_token: session.pollToken,
    login_url: session.loginUrl,
    poll_interval: session.pollInterval,
    // plugin additions
    issuer,
    mcp_url: mcpUrl,
    redirect_uri: redirectUri,
    scope,
    cache_root: paths.root,
    token_path: paths.tokenPath,
    created_at_epoch: nowEpoch(),
    expires_at_epoch: session.expiresAtEpoch,
  };
  await withTokenLock(paths.pendingPath, async () => writeJsonAtomic(paths.pendingPath, pending));

  const browserOpened = args.noBrowser ? false : openInBrowser(session.loginUrl);
  return {
    paths,
    issuer,
    pending,
    pendingPath: paths.pendingPath,
    browserOpened,
  };
}

/** Write a 0600 JSON file atomically (used for pending state). */
function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: best effort */
  }
  try {
    renameSync(tmp, file);
  } catch {
    removeFile(file);
    renameSync(tmp, file);
  }
}

/** Finish a login started by loginStart (separate process, shared pending file). */
export async function loginFinish(args = {}) {
  const paths = resolveLoginPaths(args);
  const found = findPendingLogin(paths);
  if (!found) {
    throw new LoginError(`no pending login session (${paths.pendingPath}); run login-start first`, EXIT.PENDING);
  }
  const { pending } = found;
  if (!pending.session_id || !pending.poll_token) {
    throw new LoginError('the pending login session lacks session_id/poll_token; run login-start again', EXIT.PENDING);
  }
  const issuer = normalizeIssuer(pending.issuer || paths.issuer);
  const metadata = await discoverMetadata(issuer, {
    tokenEndpoint: args.tokenEndpoint,
    timeoutMs: args.requestTimeoutMs,
  });
  const loginTicket = await pollLoginSession(issuer, pending, {
    timeoutSeconds: args.timeoutSeconds,
    intervalSeconds: args.intervalSeconds,
    timeoutMs: args.requestTimeoutMs,
  });
  const code = await exchangeLoginTicketForCode(
    pending.authorize_url,
    loginTicket,
    pending.state,
    args.requestTimeoutMs,
  );
  const tokenSet = await exchangeCodeForToken(metadata, {
    clientId: pending.client_id,
    code,
    codeVerifier: pending.verifier,
    redirectUri: pending.redirect_uri || DEFAULT_REDIRECT_URI,
    timeoutMs: args.requestTimeoutMs,
  });
  const tokenPath = pending.token_path || paths.tokenPath;
  await withTokenLock(tokenPath, async () => writeToken(tokenPath, tokenSet));
  removeFile(found.pendingPath);
  return { tokenSet, tokenPath, pendingPath: found.pendingPath, issuer };
}

/** Offline status of token + pending state. */
export function loginStatus(args = {}) {
  const paths = resolveLoginPaths(args);
  const pending = findPendingLogin(paths)?.pending;
  const found = findTokenInRoots(paths.roots, paths.region);
  const tokenPath = found?.file ?? paths.tokenPath;
  let token;
  try {
    token = readToken(tokenPath);
  } catch {
    token = undefined;
  }
  const legacyTokenFile = path.join(LEGACY_CACHE_ROOT, paths.region, 'token.json');
  return {
    paths,
    pending,
    token,
    tokenPath,
    legacyTokenFile,
    expiresInSeconds: token ? tokenExpiryEpoch(token) - nowEpoch() : null,
    fresh: token ? isTokenFresh(token) : false,
  };
}

/** Force a refresh now (shares the lock/policy with the bridge). */
export async function refreshLogin(args = {}) {
  const paths = resolveLoginPaths(args);
  const found = findTokenInRoots(paths.roots, paths.region);
  const tokenPath = found?.file ?? paths.tokenPath;
  const token = readToken(tokenPath);
  const metadata = args.tokenEndpoint
    ? { token_endpoint: args.tokenEndpoint }
    : await discoverMetadata(paths.issuer, { tokenEndpoint: args.tokenEndpoint, timeoutMs: args.requestTimeoutMs });
  const before = token.refresh_token;
  const next = await refreshToken(paths.issuer, tokenPath, token, {
    force: args.force === true || !isTokenFresh(token),
    tokenEndpoint: metadata.token_endpoint,
    timeoutMs: args.requestTimeoutMs,
  });
  return { token: next, rotated: next.refresh_token !== before, tokenPath };
}

export function loginOut(args = {}) {
  const paths = resolveLoginPaths(args);
  removeFile(paths.tokenPath);
  removeFile(paths.pendingPath);
  return paths;
}

function helpText() {
  return [
    `dsh-coros-mcp login ${VERSION}`,
    '',
    'usage: node lib/login.mjs <command> [options]',
    '',
    'commands:',
    '  login-start     create a browser authorization session and pending state',
    '  login-finish    complete the session and cache the token',
    '  login-status    show token / pending status (offline)',
    '  refresh         refresh the access token now',
    '  logout          delete local token and pending files',
    '',
    'options:',
    '  --cache-root <dir>   token cache root (default ' + DEFAULT_CACHE_ROOT + ')',
    '  --region <cn|eu|us>  region (inferred from the cache otherwise)',
    '  --issuer <url>       override the OAuth issuer',
    '  --no-browser         do not open the browser automatically',
    '  --timeout <seconds>  login-finish wait timeout (default 300)',
    '  --interval <seconds> login-finish poll interval (default 3)',
    '  --force              refresh even if the token still looks valid',
    '  --json               machine-readable output',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  const value = (flag, index) => {
    if (index + 1 >= argv.length) throw new LoginError(`${flag} requires a value`, EXIT.USAGE);
    return argv[index + 1];
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--cache-root') args.cacheRoot = value(flag, i++);
    else if (flag === '--region') args.region = value(flag, i++);
    else if (flag === '--issuer') args.issuer = value(flag, i++);
    else if (flag === '--mcp-url') args.mcpUrl = value(flag, i++);
    else if (flag === '--redirect-uri') args.redirectUri = value(flag, i++);
    else if (flag === '--scope') args.scope = value(flag, i++);
    else if (flag === '--client-name') args.clientName = value(flag, i++);
    else if (flag === '--timeout') args.timeoutSeconds = Number(value(flag, i++));
    else if (flag === '--interval') args.intervalSeconds = Number(value(flag, i++));
    else if (flag === '--token-endpoint') args.tokenEndpoint = value(flag, i++);
    else if (flag === '--request-timeout-ms') args.requestTimeoutMs = Number(value(flag, i++));
    else if (flag === '--no-browser') args.noBrowser = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new LoginError(`unknown option: ${flag}`, EXIT.USAGE);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.OK;
  }
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${helpText()}\n`);
    return EXIT.OK;
  }
  switch (args.command) {
    case 'login-start': {
      const result = await loginStart(args);
      const expiresAt = new Date(result.pending.expires_at_epoch * 1000).toISOString();
      printResult(
        {
          command: 'login-start',
          ok: true,
          issuer: result.issuer,
          region: result.paths.region,
          login_url: result.pending.login_url,
          pending_path: result.pendingPath,
          token_path: result.paths.tokenPath,
          expires_at: expiresAt,
          browser_opened: result.browserOpened,
        },
        [
          'COROS login session created.',
          `  region / issuer : ${result.paths.region} / ${result.issuer}`,
          `  pending file    : ${result.pendingPath}`,
          '',
          'Open this URL in a browser, sign in with your COROS account and authorize:',
          result.pending.login_url,
          '',
          result.browserOpened ? '(browser launch requested; copy the URL manually if nothing opened)' : '(no browser opened: --no-browser)',
          `Session valid until: ${expiresAt}`,
          '',
          'When authorization is done, run:',
          `  node "${SCRIPT_PATH}" login-finish`,
        ],
        args.json,
      );
      return EXIT.OK;
    }
    case 'login-finish': {
      if (!args.json) process.stdout.write('waiting for browser authorization…\n');
      const result = await loginFinish(args);
      const expiresAt = new Date(tokenExpiryEpoch(result.tokenSet) * 1000).toISOString();
      printResult(
        {
          command: 'login-finish',
          ok: true,
          token_path: result.tokenPath,
          issuer: result.issuer,
          expires_at: expiresAt,
          access_token_length: result.tokenSet.access_token.length,
          refresh_token_received: Boolean(result.tokenSet.refresh_token),
          client_id: maskId(result.tokenSet.client_id),
        },
        [
          'login ok',
          `  token written : ${result.tokenPath}`,
          `  access token expires: ${expiresAt}`,
          `  client_id     : ${maskId(result.tokenSet.client_id)}`,
        ],
        args.json,
      );
      return EXIT.OK;
    }
    case 'login-status': {
      const result = loginStatus(args);
      const token = result.token;
      const expiresAt = token ? new Date(tokenExpiryEpoch(token) * 1000).toISOString() : null;
      printResult(
        {
          command: 'login-status',
          issuer: result.paths.issuer,
          region: result.paths.region,
          cache_root: result.paths.root,
          token_path: result.tokenPath,
          has_token: Boolean(token),
          token_expires_at: expiresAt,
          token_expires_in_seconds: result.expiresInSeconds,
          has_refresh_token: Boolean(token?.refresh_token),
          pending: Boolean(result.pending),
          login_url: result.pending?.login_url ?? null,
          legacy_token_path: existsSync(result.legacyTokenFile) ? result.legacyTokenFile : null,
        },
        [
          `region / issuer : ${result.paths.region} / ${result.paths.issuer}`,
          `cache root      : ${result.paths.root}`,
          `token file      : ${result.tokenPath}${token ? '' : ' (missing)'}`,
          token ? `access token    : expires ${expiresAt} (${Math.max(0, Math.round(result.expiresInSeconds / 3600))}h left)` : '',
          token ? `refresh token   : ${token.refresh_token ? 'present' : 'missing'}` : '',
          result.pending ? `pending login   : ${result.pending.login_url}` : 'pending login   : none',
          existsSync(result.legacyTokenFile) && !token ? `legacy cache    : ${result.legacyTokenFile} (read fallback)` : '',
        ].filter(Boolean),
        args.json,
      );
      return EXIT.OK;
    }
    case 'refresh': {
      const result = await refreshLogin(args);
      const expiresAt = new Date(tokenExpiryEpoch(result.token) * 1000).toISOString();
      printResult(
        {
          command: 'refresh',
          ok: true,
          token_path: result.tokenPath,
          expires_at: expiresAt,
          refresh_token_rotated: result.rotated,
          access_token_length: result.token.access_token.length,
        },
        [
          'refresh ok',
          `  token written : ${result.tokenPath}`,
          `  expires at    : ${expiresAt}`,
          `  refresh_token : ${result.rotated ? 'rotated (new value persisted)' : 'unchanged'}`,
        ],
        args.json,
      );
      return EXIT.OK;
    }
    case 'logout': {
      const paths = loginOut(args);
      printResult(
        { command: 'logout', ok: true, token_path: paths.tokenPath, pending_path: paths.pendingPath },
        [`removed ${paths.tokenPath}`, `removed ${paths.pendingPath}`],
        args.json,
      );
      return EXIT.OK;
    }
    default:
      throw new LoginError(`unknown command: ${args.command}\n\n${helpText()}`, EXIT.USAGE);
  }
}

const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const exitCode = error instanceof LoginError ? error.exitCode : EXIT.AUTH;
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCode;
  }
}
