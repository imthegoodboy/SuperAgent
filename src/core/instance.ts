import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { HOME_ID, paths } from './paths.js';

/**
 * The running service of this data folder: its pid and the port it actually listens on. The CLI and the
 * watchdog talk to that port even after `port` was changed in the config (it applies on restart), and a
 * second service for the same data folder refuses to start.
 */
interface Instance {
  pid: number;
  port: number;
}

const FILE = () => path.join(paths.run, 'daemon.json');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readInstance(): Instance | null {
  try {
    const i = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Instance;
    return i?.pid && i?.port && alive(i.pid) ? i : null;
  } catch {
    return null;
  }
}

export function writeInstance(i: Instance): void {
  fs.mkdirSync(paths.run, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(i));
}

export function clearInstance(pid: number): void {
  try {
    if ((JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Instance).pid === pid) fs.rmSync(FILE(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** The port to reach this data folder's service on. */
export function servicePort(): number {
  return readInstance()?.port ?? loadConfig().port;
}

/** Does a service for this data folder answer on that port? (A recycled pid alone proves nothing.) */
export async function answers(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = (await res.json()) as { name?: string; home?: string };
    return res.ok && j?.name === 'superagent' && j.home === HOME_ID;
  } catch {
    return false;
  }
}
