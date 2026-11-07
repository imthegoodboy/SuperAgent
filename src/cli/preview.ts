import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { killTree, which } from '../agents/process.js';
import { sleep } from '../core/util.js';

// Look at a web result the way a person would: render it in the Edge or Chrome already installed, at a
// real device width (headless windows can't go below ~500 px on Windows, so the page is emulated
// through the browser's DevTools protocol), and report the page's own errors. No dependencies: Node's
// built-in WebSocket speaks the protocol.

const CANDIDATES: Record<string, string[]> = {
  win32: [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
};

export function findBrowser(): string | null {
  if (process.env.SUPERAGENT_BROWSER) return process.env.SUPERAGENT_BROWSER;
  for (const p of CANDIDATES[process.platform] ?? []) if (p && fs.existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const p = which(name);
    if (p) return p;
  }
  return null;
}

/** The page to show: a file, or the main HTML file of a folder (index.html, else the first .html). */
export function pageIn(target: string, file?: string): string {
  const p = file ? path.resolve(target, file) : path.resolve(target);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (!fs.existsSync(p)) throw new Error(`${p} does not exist`);
  const index = path.join(p, 'index.html');
  if (fs.existsSync(index)) return index;
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (e.isFile() && /\.html?$/i.test(e.name)) found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < 2) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(p, 0);
  if (!found.length) throw new Error(`no .html file in ${p}; name the file to show`);
  return found.sort((a, b) => a.length - b.length)[0];
}

export interface PreviewResult {
  file: string;
  screenshot: string;
  width: number;
  height: number;
  dark: boolean;
  errors: string[];
}

/** Render `url` at `width` (and `height`, or the full page) and save a PNG to `out`. */
export async function preview(opts: { url: string; file: string; out: string; width: number; height: number; full: boolean; dark: boolean }): Promise<PreviewResult> {
  const browser = findBrowser();
  if (!browser) throw new Error('No Chrome, Edge or Chromium found. Install one, or set SUPERAGENT_BROWSER to its path.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-preview-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
  // Some Linux machines (containers, CI) have no user namespaces for Chrome's sandbox; opt in to run without it.
  if (process.env.SUPERAGENT_BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox');
  const proc = spawn(browser, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let exited: number | null | undefined;
  proc.on('exit', (code) => (exited = code));
  proc.on('error', () => (exited = -1));
  try {
    // The browser writes the port it picked into the profile folder.
    let port = 0;
    for (let i = 0; i < 100 && !port && !exited; i++) {
      await sleep(100);
      try {
        port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      } catch {
        /* not yet */
      }
    }
    if (!port) {
      const hint = process.platform === 'linux' ? ' On Linux without sandbox support, set SUPERAGENT_BROWSER_NO_SANDBOX=1.' : '';
      throw new Error(`${path.basename(browser)} did not start${exited !== undefined ? ` (it exited with code ${exited})` : ''}.${hint}`);
    }
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('the browser opened no page');
    const cdp = await connect(page.webSocketDebuggerUrl);
    try {
      const errors: string[] = [];
      cdp.on('Runtime.exceptionThrown', (p) => errors.push(String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception').split('\n')[0]));
      cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'error') errors.push(`console.error: ${(p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
      });
      cdp.on('Log.entryAdded', (p) => {
        if (p.entry?.level === 'error') errors.push(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`.slice(0, 300));
      });
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: opts.width < 600 });
      if (opts.width < 600) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.dark ? 'dark' : 'light' }] });
      const loaded = cdp.once('Page.loadEventFired', 15_000);
      await cdp.send('Page.navigate', { url: opts.url });
      await loaded;
      await sleep(800); // fonts, first animation frames
      let height = opts.height;
      if (opts.full) {
        const m = await cdp.send('Page.getLayoutMetrics');
        height = Math.min(8000, Math.max(opts.height, Math.ceil(m.cssContentSize?.height ?? m.contentSize?.height ?? opts.height)));
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height, deviceScaleFactor: 1, mobile: opts.width < 600 });
        await sleep(300);
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, Buffer.from(shot.data, 'base64'));
      return { file: opts.file, screenshot: opts.out, width: opts.width, height, dark: opts.dark, errors: [...new Set(errors)] };
    } finally {
      cdp.close();
    }
  } finally {
    // The browser's helper processes hold the profile folder until they are gone (Windows locks it).
    if (exited === undefined) {
      const gone = new Promise((r) => proc.once('exit', r));
      if (proc.pid) killTree(proc.pid);
      await Promise.race([gone, sleep(5000)]);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* a temp folder left behind is harmless */
    }
  }
}

/** A minimal DevTools protocol client over Node's built-in WebSocket. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('could not talk to the browser')), { once: true });
  });
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
  });
  const on = (method: string, fn: (p: any) => void) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return {
    on,
    send(method: string, params: Record<string, unknown> = {}): Promise<any> {
      const id = ++next;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    once(method: string, timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs); // a page that never finishes loading is still shown
        on(method, () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
    close: () => ws.close(),
  };
}

/** Serve a folder over http on 127.0.0.1 until the process ends (for pages that need http, not file://). */
export function serve(root: string, port: number): Promise<http.Server> {
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
  };
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return void res.writeHead(400).end('bad path');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, '.' + rel);
    if (file !== base && !file.startsWith(base + path.sep)) return void res.writeHead(403).end('forbidden');
    fs.readFile(file, (err, data) => {
      // Browsers ask for /favicon.ico by themselves; a page without one has no error.
      if (err && rel === '/favicon.ico') return void res.writeHead(204).end();
      if (err) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export const fileUrl = (file: string) => pathToFileURL(file).href;
