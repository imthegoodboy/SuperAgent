// `superagent preview` and `serve`: finding the page, serving it safely, and a real screenshot when a
// Chrome, Edge or Chromium is installed (skipped otherwise).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const { findBrowser, pageIn, serve } = await import('../dist/cli/preview.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-preview-test-'));
const site = path.join(home, 'site');
fs.mkdirSync(path.join(site, 'nested'), { recursive: true });
fs.writeFileSync(
  path.join(site, 'index.html'),
  `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0">
<div id="w"></div><script type="module">document.getElementById('w').textContent = innerWidth; notDefinedAnywhere();</script>`,
);
fs.writeFileSync(path.join(site, 'nested', 'other.html'), '<p>other</p>');
fs.writeFileSync(path.join(home, 'secret.txt'), 'outside the served folder');
const env = { ...process.env, SUPERAGENT_HOME: path.join(home, 'data'), SUPERAGENT_SKIP_INTEGRATIONS: '1', SUPERAGENT_SKIP_AUTOSTART: '1', NO_COLOR: '1' };

after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

test('preview finds the page in a folder: index.html first, else the shallowest .html', () => {
  assert.equal(pageIn(site), path.join(site, 'index.html'));
  assert.equal(pageIn(site, 'nested/other.html'), path.join(site, 'nested', 'other.html'));
  fs.renameSync(path.join(site, 'index.html'), path.join(site, 'index.bak'));
  try {
    assert.equal(pageIn(site), path.join(site, 'nested', 'other.html'));
  } finally {
    fs.renameSync(path.join(site, 'index.bak'), path.join(site, 'index.html'));
  }
  assert.throws(() => pageIn(path.join(home, 'nope')), /does not exist/);
});

test('serve shows the folder and nothing outside it', async () => {
  const server = await serve(site, 0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/nested/other.html`)).status, 200);
    assert.equal((await fetch(`${base}/missing.html`)).status, 404);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/nested/..%2f..%2fsecret.txt']) {
      const r = await fetch(`${base}${p}`);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(await r.text(), /outside the served folder/, p);
    }
  } finally {
    server.close();
  }
});

test('preview screenshots at a real phone width and reports the page errors', { skip: !findBrowser() && 'no Chrome, Edge or Chromium here' }, () => {
  const extra = process.platform === 'linux' ? { SUPERAGENT_BROWSER_NO_SANDBOX: '1' } : {};
  const r = spawnSync(process.execPath, [cli, 'preview', site, '--width', '375', '--json'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  const shot = out.screenshots[0];
  assert.equal(shot.width, 375);
  const png = fs.readFileSync(shot.file);
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 375, 'the image is really 375 px wide (no desktop minimum width)');
  assert.ok(shot.file.startsWith(path.join(home, 'data', 'previews')), 'saved in the data folder');
  assert.ok(out.errors.some((e) => /notDefinedAnywhere/.test(e)), JSON.stringify(out.errors));
});

test('preview checks its options before starting a browser', () => {
  const bad = spawnSync(process.execPath, [cli, 'preview', site, '--width', '50'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--width is in pixels/);
  const two = spawnSync(process.execPath, [cli, 'preview', site, '--width', '375,1280', '--out', 'x.png'], { env, encoding: 'utf8' });
  assert.equal(two.status, 1);
  assert.match(two.stderr, /--out names one file/);
});
