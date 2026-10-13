import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSiteIdentity, loadSiteLeaseConfig, SiteLeadershipError } from '../src/infrastructure/postgres/site-leadership.js';
import { createWebApp, type WebConfig } from '../src/web/main.js';

test('failover identity is optional but never half configured', () => {
  assert.equal(loadSiteIdentity({}), null);
  assert.deepEqual(loadSiteIdentity({ FAILOVER_SITE_ID: 'hkumyseat', FAILOVER_ORIGIN_ID: 'aws' }), {
    siteId: 'hkumyseat', originId: 'aws',
  });
  assert.throws(() => loadSiteIdentity({ FAILOVER_SITE_ID: 'hkumyseat' }), SiteLeadershipError);
  assert.throws(() => loadSiteIdentity({ FAILOVER_SITE_ID: 'HKU', FAILOVER_ORIGIN_ID: 'aws' }), SiteLeadershipError);
});

test('lease timing keeps at least two renewal opportunities', () => {
  assert.deepEqual(loadSiteLeaseConfig({ FAILOVER_SITE_ID: 'hkumyseat', FAILOVER_ORIGIN_ID: 'backup' }), {
    siteId: 'hkumyseat', originId: 'backup', ttlMs: 15_000, renewMs: 5_000,
  });
  assert.throws(() => loadSiteLeaseConfig({
    FAILOVER_SITE_ID: 'hkumyseat', FAILOVER_ORIGIN_ID: 'backup',
    FAILOVER_LEASE_TTL_MS: '5000', FAILOVER_LEASE_RENEW_MS: '2500',
  }), SiteLeadershipError);
});

test('student traffic and readiness are fenced when this origin is not active', async () => {
  let active = false;
  const directory = mkdtempSync(join(tmpdir(), 'tmedge-site-guard-'));
  const cfg: WebConfig = {
    port: 0, host: '127.0.0.1', pushToken: 'p'.repeat(32), sessionSecret: Buffer.from('s'.repeat(40)),
    usersPath: join(directory, 'users.json'), allowedDomains: ['example.test'], signupOpen: false,
    cookieSecure: false, trustProxy: false, staleMs: 30_000, studentPersistenceMode: 'file',
  };
  const web = createWebApp(cfg, { siteTraffic: { active: async () => active } });
  await new Promise<void>((resolve, reject) => {
    web.server.once('error', reject);
    web.server.listen(0, '127.0.0.1', resolve);
  });
  const port = (web.server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })).status, 503);
    active = true;
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })).status, 302);
  } finally {
    await new Promise<void>((resolve) => web.server.close(() => resolve()));
    await web.dispose();
  }
});
