import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  loginFinish,
  loginStart,
  loginStatus,
  refreshLogin,
  tokenSetFromResponse,
  resolveLoginPaths,
} from '../lib/login.mjs';
import { createMockIssuer } from './fixtures/mock-issuer.mjs';

function tempCacheRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'coros-login-test-'));
}

function regionForMock(issuer) {
  return new URL(issuer).hostname.replace(/\./g, '-');
}

async function withMock(fn, options = {}) {
  const mock = await createMockIssuer(options);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

test('login flow: DCR + PKCE + CLI session -> token cache with the official six fields', async () => {
  const cacheRoot = tempCacheRoot();
  try {
    await withMock(async (mock) => {
      const start = await loginStart({ issuer: mock.origin, cacheRoot, noBrowser: true });
      assert.equal(start.issuer, mock.origin);
      assert.ok(start.pending.login_url.startsWith(mock.origin));
      assert.ok(start.pending.authorize_url.includes('code_challenge_method=S256'));
      assert.equal(start.pending.client_id.length > 0, true);
      assert.equal(start.pending.verifier.length >= 43, true);
      assert.equal(existsSync(start.pendingPath), true);

      const finish = await loginFinish({ cacheRoot, intervalSeconds: 0.01 });
      assert.equal(finish.tokenSet.token_type, 'Bearer');
      assert.equal(finish.tokenSet.scope.includes('mcp.tools'), true);
      assert.ok(finish.tokenSet.access_token.startsWith('mock-at-'));
      assert.ok(finish.tokenSet.refresh_token.startsWith('mock-rt-'));
      assert.ok(finish.tokenSet.expires_at_epoch > Math.floor(Date.now() / 1000));

      const cache = JSON.parse(readFileSync(finish.tokenPath, 'utf8'));
      assert.deepEqual(Object.keys(cache).sort(), [
        'access_token',
        'client_id',
        'expires_at_epoch',
        'refresh_token',
        'scope',
        'token_type',
      ]);
      assert.equal(existsSync(start.pendingPath), false, 'pending file is consumed');
      assert.equal(mock.stats.registrations, 1);
      assert.equal(mock.stats.tokenExchanges, 1);
    });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('login-status reports the cached token and expiry', async () => {
  const cacheRoot = tempCacheRoot();
  try {
    await withMock(async (mock) => {
      await loginStart({ issuer: mock.origin, cacheRoot, noBrowser: true });
      await loginFinish({ cacheRoot, intervalSeconds: 0.01 });
      const status = loginStatus({ cacheRoot, issuer: mock.origin });
      assert.equal(Boolean(status.token), true);
      assert.equal(status.fresh, true);
      assert.ok(status.expiresInSeconds > 29 * 86400);
    });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('refresh rotates the refresh token and persists the new pair', async () => {
  const cacheRoot = tempCacheRoot();
  try {
    await withMock(async (mock) => {
      await loginStart({ issuer: mock.origin, cacheRoot, noBrowser: true });
      const first = await loginFinish({ cacheRoot, intervalSeconds: 0.01 });
      const before = JSON.parse(readFileSync(first.tokenPath, 'utf8'));

      const refreshed = await refreshLogin({ cacheRoot, issuer: mock.origin, force: true });
      assert.equal(refreshed.rotated, true);
      assert.notEqual(refreshed.token.access_token, before.access_token);
      assert.notEqual(refreshed.token.refresh_token, before.refresh_token);

      const persisted = JSON.parse(readFileSync(first.tokenPath, 'utf8'));
      assert.equal(persisted.access_token, refreshed.token.access_token);
      assert.equal(persisted.refresh_token, refreshed.token.refresh_token);
      assert.equal(mock.stats.refreshes, 1);
    });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('concurrent refreshes do not consume the same rotating refresh token twice', async () => {
  const cacheRoot = tempCacheRoot();
  try {
    await withMock(async (mock) => {
      await loginStart({ issuer: mock.origin, cacheRoot, noBrowser: true });
      const first = await loginFinish({ cacheRoot, intervalSeconds: 0.01 });

      const [a, b] = await Promise.all([
        refreshLogin({ cacheRoot, issuer: mock.origin, force: true }),
        refreshLogin({ cacheRoot, issuer: mock.origin, force: true }),
      ]);
      assert.equal(mock.stats.refreshes, 1, 'only one real rotation may happen');
      assert.equal(a.token.access_token, b.token.access_token);
      const persisted = JSON.parse(readFileSync(first.tokenPath, 'utf8'));
      assert.equal(persisted.access_token, a.token.access_token);
    });
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('tokenSetFromResponse enforces the six-field cache contract', () => {
  const token = tokenSetFromResponse(
    { access_token: 'at', refresh_token: 'rt', expires_in: 60, token_type: 'Bearer', scope: 's' },
    { clientId: 'client-1' },
  );
  assert.equal(token.client_id, 'client-1');
  assert.ok(token.expires_at_epoch > Math.floor(Date.now() / 1000));
  assert.throws(() => tokenSetFromResponse({ refresh_token: 'rt' }, { clientId: 'c' }), /no access_token/);
  assert.throws(() => tokenSetFromResponse({ access_token: 'at' }, { clientId: 'c' }), /no refresh_token/);
  assert.throws(() => tokenSetFromResponse({ access_token: 'at', refresh_token: 'rt' }, {}), /client_id/);
});

test('resolveLoginPaths writes to the plugin-owned cache root and keeps the legacy root for reads', () => {
  const cacheRoot = tempCacheRoot();
  try {
    const paths = resolveLoginPaths({ cacheRoot, issuer: 'https://mcpcn.coros.com' });
    assert.equal(paths.region, 'cn');
    assert.equal(paths.tokenPath, path.join(cacheRoot, 'cn', 'token.json'));
    assert.deepEqual(paths.roots, [cacheRoot], 'an explicit cache root disables the legacy fallback');
    const mismatch = resolveLoginPaths({ cacheRoot, region: 'cn' });
    assert.equal(mismatch.issuer, 'https://mcpcn.coros.com');
    assert.throws(() => resolveLoginPaths({ cacheRoot, region: 'mars' }), /unknown region/);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
