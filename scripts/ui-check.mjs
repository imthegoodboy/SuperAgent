// UI smoke test + screenshots. Runs a real daemon with the mock agent, seeds a conversation and
// parallel workers, opens every view in headless Chromium, and fails on any page or console error.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/ui-check.mjs [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'ui-shots');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-ui-'));
const port = 18900;
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    port,
    router: { agent: 'mock', model: '' },
    workers: { defaultAgent: 'mock', maxConcurrent: 3 },
    github: { enabled: false },
    watchdog: { enabled: false },
    repos: [{ name: 'web', slug: 'acme/web', mode: 'mentions', allowUsers: ['you'] }],
  }),
);

const daemon = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), '__daemon'], {
  // Slow workers (so they are visibly running in the screenshots), fast router.
  env: { ...process.env, SUPERAGENT_HOME: home, SUPERAGENT_MOCK: '1', MOCK_DELAY_MS: '20000', MOCK_ROUTER_DELAY_MS: '50' },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (i > 100) throw new Error('daemon did not start');
    await sleep(100);
  }
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  const call = (method, p, body) =>
    fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());

  // A short conversation that starts parallel work.
  await call('POST', '/api/messages', { text: 'hi! what can you do?' });
  await sleep(1500);
  await call('POST', '/api/messages', { text: 'task: Fix the blank screen when switching sessions' });
  await call('POST', '/api/workers', { task: 'Add CSV export to the reports page', title: 'Add CSV export to reports' });
  await call('POST', '/api/workers', { task: 'Upgrade the test runner and fix deprecations', title: 'Upgrade test runner' });
  await sleep(3000);

  const browser = await chromium.launch();
  const shoot = async (name, url, opts = {}) => {
    const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1360, height: 860 }, colorScheme: opts.dark ? 'dark' : 'light' });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: console: ${m.text()}`));
    await page.goto(base + url);
    if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 10_000 });
    if (opts.act) await opts.act(page);
    await sleep(600);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    await page.close();
  };

  const workers = await call('GET', '/api/workers');
  const running = workers.find((w) => w.status === 'running') ?? workers[0];
  await shoot('chat', '/#/chat', { wait: '.msg-agent' });
  await shoot('chat-dark', '/#/chat', { wait: '.msg-agent', dark: true });
  await shoot('tasks', `/#/tasks/${running.id}`, { wait: '.detail-head' });
  await shoot('activity', '/#/activity', { wait: '.ev-row' });
  await shoot('activity-router', '/#/activity', { wait: '.ev-row', act: (p) => p.getByRole('tab', { name: 'Router' }).click().then(() => p.waitForSelector('.turn')) });
  await shoot('settings', '/#/settings', { wait: '.set-section' });
  await shoot('new-task', '/#/tasks', { wait: '.pane-head', act: (p) => p.getByRole('button', { name: 'New task' }).click() });
  await shoot('phone', '/#/chat', { wait: '.msg-agent', viewport: { width: 390, height: 780 } });

  // Interaction: sending a message from the UI reaches the router and comes back.
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`interaction: ${e.message}`));
  await page.goto(base + '/#/chat');
  await page.waitForSelector('.composer textarea');
  await page.fill('.composer textarea', 'ping from the UI test');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Echo: ping from the UI test', { timeout: 10_000 });
  await browser.close();
} catch (e) {
  errors.push(String(e?.stack ?? e));
} finally {
  daemon.kill();
  await sleep(300);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}

if (errors.length) {
  console.error('UI check failed:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`UI check passed. Screenshots in ${out}`);
