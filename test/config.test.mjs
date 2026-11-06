import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CorosConfigError,
  LEGACY_CACHE_ROOT,
  REGIONAL_ISSUERS,
  candidateCacheRoots,
  createTokenProvider,
  describeAuth,
  expandHome,
  findTokenFile,
  isTokenFresh,
  readToken,
  resolveCacheRoot,
  resolveTarget,
  tokenExpiryEpoch,
  writeToken,
} from '../lib/config.mjs';

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'coros-mcp-test-'));
}

function writeCache(cacheRoot, region, token, mtime) {
  const dir = path.join(cacheRoot, region);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'token.json');
  writeFileSync(file, JSON.stringify(token, null, 2), 'utf8');
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

const farFuture = () => Math.floor(Date.now() / 1000) + 3600;

test('expandHome expands only a leading tilde', () => {
  assert.equal(expandHome('~/coros'), path.join(os.homedir(), 'coros'));
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('C:/coros'), 'C:/coros');
  assert.equal(expandHome(undefined), undefined);
});

test('resolveCacheRoot: option wins over env, env wins over DSH home default', () => {
  assert.equal(resolveCacheRoot({ cacheRoot: '~/a' }, {}), path.join(os.homedir(), 'a'));
  assert.equal(resolveCacheRoot({}, { COROS_MCP_CACHE_ROOT: 'D:/cache' }), 'D:/cache');
  assert.equal(resolveCacheRoot({}, { DSH_HOME: 'D:/dsh' }), path.join('D:/dsh', 'coros-mcp'));
});

test('candidateCacheRoots falls back to the official COROS CLI cache', () => {
  const roots = candidateCacheRoots({}, { DSH_HOME: 'D:/dsh' });
  assert.deepEqual(roots, [path.join('D:/dsh', 'coros-mcp'), LEGACY_CACHE_ROOT]);
  assert.deepEqual(candidateCacheRoots({ cacheRoot: '~/x' }, {}), [path.join(os.homedir(), 'x')]);
});

test('findTokenFile picks the newest region unless a region is forced', () => {
  const root = tempDir();
  try {
    const oldTime = new Date('2020-01-01T00:00:00Z');
    const newTime = new Date('2021-01-01T00:00:00Z');
    writeCache(root, 'eu', { access_token: 'a' }, oldTime);
    writeCache(root, 'cn', { access_token: 'b' }, newTime);

    assert.equal(findTokenFile(root).region, 'cn');
    assert.equal(findTokenFile(root, 'eu').region, 'eu');
    assert.equal(findTokenFile(root, 'us'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveTarget infers region/issuer and endpoint from the cache', () => {
  const root = tempDir();
  try {
    writeCache(root, 'cn', { access_token: 'a', expires_at_epoch: farFuture() });
    const target = resolveTarget({ cacheRoot: root });
    assert.equal(target.region, 'cn');
    assert.equal(target.issuer, REGIONAL_ISSUERS.cn);
    assert.equal(target.mcpUrl, `${REGIONAL_ISSUERS.cn}/mcp`);
    assert.equal(target.loggedIn, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveTarget honours explicit region/issuer/endpoint overrides', () => {
  const root = tempDir();
  try {
    const target = resolveTarget({
      cacheRoot: root,
      region: 'eu',
      issuer: 'https://issuer.example/',
      mcpUrl: 'https://issuer.example/mcp/',
    });
    assert.equal(target.region, 'eu');
    assert.equal(target.issuer, 'https://issuer.example');
    assert.equal(target.mcpUrl, 'https://issuer.example/mcp');
    assert.equal(target.loggedIn, false);
    assert.equal(target.tokenFile, path.join(root, 'eu', 'token.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readToken rejects caches without an access token', () => {
  const root = tempDir();
  try {
    const file = writeCache(root, 'cn', { refresh_token: 'r' });
    assert.throws(() => readToken(file), CorosConfigError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeToken writes the documented cache shape atomically', () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'cn', 'token.json');
    const token = { access_token: 'a', refresh_token: 'r', expires_at_epoch: farFuture(), client_id: 'c' };
    writeToken(file, token);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), token);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isTokenFresh applies the 120s expiry skew', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isTokenFresh({ expires_at_epoch: now + 3600 }), true);
  assert.equal(isTokenFresh({ expires_at_epoch: now + 30 }), false);
  assert.equal(isTokenFresh({ expires_at_epoch: now - 10 }), false);
  assert.equal(isTokenFresh({}), false);
  assert.equal(tokenExpiryEpoch({ expires_at_epoch: 42 }), 42);
});

test('describeAuth reports expiry without exposing token values', () => {
  const root = tempDir();
  try {
    const file = writeCache(root, 'cn', { access_token: 'secret-value', expires_at_epoch: farFuture() });
    const target = resolveTarget({ cacheRoot: root });
    const status = describeAuth(target, readToken(file));
    assert.equal(status.loggedIn, true);
    assert.equal(status.region, 'cn');
    assert.equal(status.expired, false);
    assert.equal(status.hasRefreshToken, false);
    assert.ok(status.expiresInSeconds > 0);
    assert.equal(JSON.stringify(status).includes('secret-value'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createTokenProvider reuses a fresh token without network access', async () => {
  const root = tempDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network must not be used for a fresh token');
  };
  try {
    const file = writeCache(root, 'cn', {
      access_token: 'fresh',
      refresh_token: 'r1',
      client_id: 'client-1',
      token_type: 'Bearer',
      scope: 'mcp.tools',
      expires_at_epoch: farFuture(),
    });
    const provider = createTokenProvider(resolveTarget({ cacheRoot: root }));
    const token = await provider.get();
    assert.equal(token.access_token, 'fresh');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).access_token, 'fresh');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('createTokenProvider refreshes an expired token and persists it', async () => {
  const root = tempDir();
  const originalFetch = globalThis.fetch;
  let refreshCalls = 0;
  let lastBody;
  globalThis.fetch = async (url, init) => {
    refreshCalls += 1;
    lastBody = String(init?.body ?? '');
    assert.equal(String(url), `${REGIONAL_ISSUERS.cn}/oauth2/token`);
    return new Response(
      JSON.stringify({
        access_token: 'refreshed',
        refresh_token: 'r2',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'mcp.tools openid offline_access',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const file = writeCache(root, 'cn', {
      access_token: 'stale',
      refresh_token: 'r1',
      client_id: 'client-1',
      token_type: 'Bearer',
      scope: 'mcp.tools',
      expires_at_epoch: 0,
    });
    const provider = createTokenProvider(resolveTarget({ cacheRoot: root }));
    const token = await provider.get();
    assert.equal(refreshCalls, 1);
    assert.equal(token.access_token, 'refreshed');
    assert.equal(token.refresh_token, 'r2');
    assert.ok(lastBody.includes('grant_type=refresh_token'));
    assert.ok(lastBody.includes('refresh_token=r1'));
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.access_token, 'refreshed');
    assert.equal(persisted.client_id, 'client-1');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('createTokenProvider surfaces refresh failures with a readable error', async () => {
  const root = tempDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"invalid_grant"}', { status: 400 });
  try {
    writeCache(root, 'cn', {
      access_token: 'stale',
      refresh_token: 'revoked',
      client_id: 'client-1',
      expires_at_epoch: 0,
    });
    const provider = createTokenProvider(resolveTarget({ cacheRoot: root }));
    await assert.rejects(() => provider.get(), /token refresh failed \(HTTP 400\)/);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
