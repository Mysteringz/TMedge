// Local Playwright / installed Chrome fallback; no browser MCP is available.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AlgoUsers, loadAlgoAuthConfig } from '../dist/src/algo/auth.js';
import { startAlgo } from '../dist/src/algo/server.js';
import { createEdgeRuntime } from '../dist/src/edge/composition-root.js';
import { DEFAULT_NODE_LIMITS } from '../dist/src/edge/config.js';
import { buildRegistry } from '../dist/src/edge/registry.js';
import { KEY, nodesJson, siteJson } from '../dist/test/fixtures.js';

const artifacts = resolve('../.codex/docs/admin-operator-role-and-account-deletion/task-2/artifacts');
mkdirSync(artifacts, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'tm-account-browser-')), usersPath = join(dataDir, 'users.json'), password = randomBytes(18).toString('hex');
process.env.DATA_DIR = dataDir;
const users = new AlgoUsers(usersPath);
for (const [name, role] of [['admin', 'admin'], ['backup', 'admin'], ['viewer', 'viewer'], ['engineer', 'engineer'], ['operator', 'operator']]) await users.add(name, password, role);
const cfg = { edgeId: 'accounts-test', keys: [KEY], allowUnsigned: false, udpPort: 0, udpHost: '127.0.0.1', sitePath: '', nodesPath: '', dataDir, recordRaw: false, consolePort: 0, algoPort: 0, consoleHost: '127.0.0.1', adminPassword: 'test-only', flashToken: null, pushUrls: [], pushToken: '', publishMs: 60000, gatewayPort: 0, gatewayToken: null, nodeHost: '127.0.0.1', nodePort: 0, nodeLimits: DEFAULT_NODE_LIMITS, nodeTls: null };
const runtime = createEdgeRuntime(cfg, buildRegistry(siteJson(), nodesJson()));
const handle = startAlgo(runtime, 0, '127.0.0.1', loadAlgoAuthConfig({ SESSION_SECRET: randomBytes(32).toString('hex'), ALGO_USERS_FILE: usersPath }, cfg.adminPassword));
await new Promise((done) => handle.server.once('listening', done));
const base = `http://127.0.0.1:${handle.server.address().port}`, browser = await chromium.launch({ headless: true, channel: 'chrome' });
const evidence = [], errors = [];
const login = async (context, username) => { assert.equal((await context.request.post(`${base}/auth/login`, { data: { username, password } })).status(), 200); };
try {
  for (const name of ['viewer','operator','engineer']) {
    const context = await browser.newContext(); await login(context,name); const page = await context.newPage(); await page.goto(`${base}/accounts`); await page.getByText('Admin access required.',{exact:true}).waitFor(); assert.equal((await context.request.get(`${base}/api/admin/accounts`)).status(),403); await context.close();
  }
  const context = await browser.newContext({ viewport:{width:360,height:800} }); await login(context,'admin'); const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/accounts`); await page.getByRole('button',{name:'Create account',exact:true}).click(); assert.equal(await page.getByLabel('Role',{exact:true}).inputValue(),'operator'); await page.getByLabel('Role',{exact:true}).selectOption('engineer'); await page.getByText('Use all operational controls, including firmware and provisioning, and your own training jobs. Cannot manage accounts.',{exact:true}).waitFor(); await page.getByRole('button',{name:'Cancel editor'}).click();
  let deletes=0; page.on('request',request=>{if(request.method()==='DELETE')deletes++;});
  const openDelete=async name=>{await page.getByRole('button',{name:`Manage ${name}`,exact:true}).click(); await page.getByRole('button',{name:'Delete account',exact:true}).click(); await page.getByLabel(`Type ${name} to confirm`,{exact:true}).waitFor();};
  await openDelete('viewer'); const input=page.getByLabel('Type viewer to confirm',{exact:true}), final=page.getByRole('button',{name:'Delete account',exact:true}); assert.equal(await input.evaluate(el=>el===document.activeElement),true); await input.fill('viewer '); assert.equal(await final.isDisabled(),true); await page.keyboard.press('Enter'); assert.equal(deletes,0); await page.keyboard.press('Escape'); assert.equal(deletes,0); assert.equal(await page.getByRole('button',{name:'Delete account',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByRole('button',{name:'Delete account',exact:true}).click(); await input.fill('viewer'); assert.equal(await final.isDisabled(),false); await page.getByRole('button',{name:'Cancel deletion'}).click(); assert.equal(deletes,0); await page.getByRole('button',{name:'Delete account',exact:true}).click(); assert.equal(await input.inputValue(),'');
  users.update('viewer',{revoke:true}); await input.fill('viewer'); await final.click(); await page.getByText('This account changed. Refresh accounts before deleting it.',{exact:true}).waitFor(); assert.equal(await input.inputValue(),''); assert.equal(await final.isDisabled(),true); assert.ok(users.has('viewer'));
  await page.getByRole('button',{name:'Refresh accounts'}).click(); await openDelete('viewer'); await input.fill('viewer'); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await page.screenshot({path:join(artifacts,'delete-confirmation-mobile.png'),fullPage:true}); await final.click(); await page.getByText('Account viewer deleted.',{exact:true}).waitFor(); assert.equal(await page.getByRole('button',{name:'Manage viewer',exact:true}).count(),0); assert.equal(await page.getByRole('button',{name:'Create account',exact:true}).evaluate(el=>el===document.activeElement),true);
  await openDelete('admin'); await page.getByText(/You will be signed out/).waitFor(); await page.getByLabel('Type admin to confirm',{exact:true}).fill('admin'); await page.getByRole('button',{name:'Delete account',exact:true}).click(); await page.waitForURL('**/login**'); assert.equal(users.has('admin'),false);
  await login(context,'backup'); await page.goto(`${base}/accounts`); await openDelete('backup'); await page.getByLabel('Type backup to confirm',{exact:true}).fill('backup'); await page.getByRole('button',{name:'Delete account',exact:true}).click(); await page.getByText('Keep at least one enabled admin. This account cannot be deleted.',{exact:true}).waitFor(); assert.ok(users.has('backup')); await page.setViewportSize({width:1280,height:900}); await page.evaluate(()=>document.body.style.zoom='2'); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); await page.screenshot({path:join(artifacts,'last-admin-zoom.png'),fullPage:true});
  assert.deepEqual(errors,[]); evidence.push({checks:['nonadmins denied','Operator create default','Engineer helper','exact-name focus/Enter/Escape/cancel','stale revision requires refresh','delete refresh/focus','selfdelete login','last admin','360px/200%'],deleteRequests:deletes,pageErrors:errors}); await context.close(); writeFileSync(join(artifacts,'deletion-browser-results.json'),JSON.stringify({runner:'local Playwright / installed Chrome',evidence},null,2)); process.stdout.write('Deletion browser acceptance passed.\n');
} finally {await browser.close();await handle.dispose();await new Promise(done=>handle.server.close(done));await runtime.stop();}
