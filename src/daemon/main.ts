import fs from 'node:fs';
import path from 'node:path';
import { answers, clearInstance, readInstance, writeInstance } from '../core/instance.js';
import { commandLine } from '../agents/process.js';
import { paths } from '../core/paths.js';
import { log } from '../core/util.js';
import { App } from './app.js';
import { createServer } from './server.js';

export const EXIT_PORT_IN_USE = 3;
/** Another service already runs for this data folder (two would share one database). */
export const EXIT_ALREADY_RUNNING = 4;

export async function runDaemon(): Promise<void> {
  const other = readInstance();
  // A daemon that is alive but not answering (busy, hung) still owns this data folder and database.
  if (other && other.pid !== process.pid && ((await answers(other.port)) || (await commandLine(other.pid)).includes('__daemon'))) {
    log(`SuperAgent already runs for this data folder (pid ${other.pid}, port ${other.port}); not starting a second one`);
    process.exit(EXIT_ALREADY_RUNNING);
  }
  const app = new App();
  const port = app.config.port;
  app.listenPort = port;
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      log(err.code === 'EADDRINUSE' ? `port ${port} is already in use (is SuperAgent already running?)` : `server error: ${err.message}`);
      process.exit(EXIT_PORT_IN_USE);
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const pidFile = path.join(paths.run, 'daemon.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  writeInstance({ pid: process.pid, port });
  log(`SuperAgent daemon ${process.pid} listening on http://127.0.0.1:${port}`);

  let closing = false;
  const shutdown = (code = 0) => {
    if (closing) return;
    closing = true;
    log('shutting down');
    app.shutdown();
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(pidFile, { force: true });
    clearInstance(process.pid);
    setTimeout(() => process.exit(code), 300);
  };
  app.onShutdown = () => shutdown(0);
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('unhandledRejection', (e) => log('unhandled rejection:', e));
  process.on('uncaughtException', (e) => {
    log('uncaught exception:', e);
    shutdown(1);
  });

  await app.init();
}
