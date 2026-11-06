/**
 * Protocol-faithful mock of the COROS MCP gateway OAuth surface (tests only).
 *
 * Implements just enough of the real gateway to exercise lib/login.mjs end to
 * end without a browser and without touching real COROS tokens:
 *   GET  /.well-known/oauth-authorization-server   AS metadata
 *   POST /connect/register                         RFC 7591 DCR (public client)
 *   POST /api/v1/cli/login-sessions                COROS CLI login session
 *   POST /api/v1/cli/login-sessions/:id/claim      X-Poll-Token; after N polls -> authorized + loginTicket
 *   GET  /oauth2/authorize                         with login_ticket -> 302 redirect_uri?code=&state=
 *   POST /oauth2/token                             authorization_code / refresh_token (rotating)
 *   POST /oauth2/device_authorization              not used (device flow is unavailable on COROS)
 *
 * The request/response shapes follow research/coros-auth-spec.md, which was
 * derived from the real endpoints; this file is a test double, not a client.
 */

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const b64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (bytes) => b64url(randomBytes(bytes));
const nowEpoch = () => Math.floor(Date.now() / 1000);

export function createMockIssuer(options = {}) {
  const pendingPolls = options.pendingPolls ?? 1;
  const accessTtlSeconds = options.accessTtlSeconds ?? 30 * 86400;
  const refreshTtlSeconds = options.refreshTtlSeconds ?? 180 * 86400;

  const clients = new Map();
  const sessions = new Map();
  const tickets = new Map();
  const codes = new Map();
  const refreshTokens = new Map();
  const stats = { registrations: 0, sessions: 0, claims: 0, authorizeWithTicket: 0, tokenExchanges: 0, refreshes: 0 };

  let origin = '';

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  function parseForm(text) {
    const form = {};
    for (const [key, value] of new URLSearchParams(text)) form[key] = value;
    return form;
  }

  function pkceMatches(verifier, challenge) {
    return b64url(createHash('sha256').update(String(verifier), 'utf8').digest()) === String(challenge ?? '');
  }

  function issueTokenPair(clientId) {
    const refreshToken = `mock-rt-${rand(36)}`;
    refreshTokens.set(refreshToken, {
      clientId,
      used: false,
      expiresAt: nowEpoch() + refreshTtlSeconds,
    });
    return {
      access_token: `mock-at-${rand(32)}`,
      refresh_token: refreshToken,
      expires_in: accessTtlSeconds,
      token_type: 'Bearer',
      scope: 'openid mcp.tools offline_access',
    };
  }

  function metadata() {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth2/authorize`,
      token_endpoint: `${origin}/oauth2/token`,
      registration_endpoint: `${origin}/connect/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'mcp.tools', 'offline_access'],
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', origin);
    const pathname = url.pathname;
    const method = req.method || 'GET';
    try {
      if (method === 'GET' && (pathname === '/.well-known/oauth-authorization-server' || pathname === '/.well-known/openid-configuration')) {
        return json(res, 200, metadata());
      }

      if (method === 'POST' && pathname === '/connect/register') {
        const payload = JSON.parse(await readBody(req));
        if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.length === 0) {
          return json(res, 400, { error: 'invalid_redirect_uri' });
        }
        const clientId = `mock-client-${rand(8)}`;
        clients.set(clientId, { ...payload, client_id: clientId });
        stats.registrations += 1;
        return json(res, 201, {
          client_id: clientId,
          redirect_uris: payload.redirect_uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
      }

      if (method === 'POST' && pathname === '/api/v1/cli/login-sessions') {
        const payload = JSON.parse(await readBody(req));
        if (!clients.has(payload.clientId)) return json(res, 400, { result: 'HTTP_400', message: 'unknown clientId' });
        const sessionId = rand(20);
        const pollToken = rand(20);
        sessions.set(sessionId, { sessionId, pollToken, clientId: payload.clientId, status: 'pending', polls: 0, loginTicket: null });
        stats.sessions += 1;
        return json(res, 200, {
          sessionId,
          pollToken,
          loginUrl: `${origin}/cli/login/${sessionId}`,
          expiresAt: new Date((nowEpoch() + 600) * 1000).toISOString(),
          intervalSeconds: 1,
        });
      }

      const claimMatch = /^\/api\/v1\/cli\/login-sessions\/([^/]+)\/claim$/.exec(pathname);
      if (method === 'POST' && claimMatch) {
        const session = sessions.get(decodeURIComponent(claimMatch[1]));
        if (!session) return json(res, 400, { result: 'HTTP_400', message: 'CLI login session not found' });
        if (req.headers['x-poll-token'] !== session.pollToken) {
          return json(res, 400, { result: 'HTTP_400', message: 'CLI login poll token is invalid' });
        }
        session.polls += 1;
        stats.claims += 1;
        if (session.status === 'pending' && session.polls > pendingPolls) {
          session.status = 'authorized';
          session.loginTicket = `mock-ticket-${rand(16)}`;
          tickets.set(session.loginTicket, { sessionId: session.sessionId, clientId: session.clientId, used: false });
        }
        if (session.status === 'authorized') return json(res, 200, { status: 'authorized', loginTicket: session.loginTicket });
        return json(res, 200, { status: 'pending' });
      }

      if (method === 'GET' && pathname === '/oauth2/authorize') {
        const params = url.searchParams;
        const clientId = params.get('client_id');
        const redirectUri = params.get('redirect_uri');
        const state = params.get('state');
        const challenge = params.get('code_challenge');
        const client = clients.get(clientId || '');
        if (!client) return json(res, 400, { error: 'invalid_client' });
        if (!client.redirect_uris.includes(redirectUri)) return json(res, 400, { error: 'invalid_request' });
        if (params.get('code_challenge_method') !== 'S256' || !challenge) return json(res, 400, { error: 'invalid_request' });
        const ticket = tickets.get(params.get('login_ticket') || '');
        if (!ticket || ticket.used || ticket.clientId !== clientId) {
          res.writeHead(302, { Location: `${origin}/cli/login/none` });
          return res.end();
        }
        ticket.used = true;
        stats.authorizeWithTicket += 1;
        const code = `mock-code-${rand(16)}`;
        codes.set(code, { clientId, redirectUri, state, challenge, used: false });
        res.writeHead(302, {
          Location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`,
        });
        return res.end();
      }

      if (method === 'POST' && pathname === '/oauth2/token') {
        const form = parseForm(await readBody(req));
        if (form.grant_type === 'authorization_code') {
          const code = codes.get(form.code);
          if (!code || code.used) return json(res, 400, { error: 'invalid_grant', error_description: 'code invalid or used' });
          if (code.clientId !== form.client_id) return json(res, 400, { error: 'invalid_grant' });
          if (code.redirectUri !== form.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
          if (!pkceMatches(form.code_verifier, code.challenge)) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
          code.used = true;
          stats.tokenExchanges += 1;
          return json(res, 200, issueTokenPair(form.client_id));
        }
        if (form.grant_type === 'refresh_token') {
          const record = refreshTokens.get(form.refresh_token);
          if (!record || record.clientId !== form.client_id || record.used || nowEpoch() > record.expiresAt) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid, expired or already rotated' });
          }
          record.used = true; // rotation: the old refresh token is dead immediately
          stats.refreshes += 1;
          return json(res, 200, issueTokenPair(form.client_id));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }

      json(res, 404, { error: 'not_found', path: pathname });
    } catch (error) {
      json(res, 500, { error: 'mock_server_error', message: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        stats,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
