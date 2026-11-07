#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on some Node versions; keep the CLI output clean.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String((warning as Error)?.message ?? warning).includes('SQLite')) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./cli/commands.js');
await main(process.argv.slice(2));
