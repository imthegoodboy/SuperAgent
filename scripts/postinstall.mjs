// After `npm install -g`, give every coding agent on this computer the superagent skill, so the
// install is the only step a person takes. An upgrade refreshes the skill where it is installed and
// leaves alone a skill someone removed on purpose. Local installs (development, CI) skip this, and it
// never fails an install: if it can't run here, the next `superagent` command does the same thing.
if (process.env.npm_config_global === 'true' && process.env.SUPERAGENT_SKIP_INTEGRATIONS !== '1') {
  try {
    const { postinstallIntegrations } = await import('../dist/daemon/system.js');
    const done = postinstallIntegrations().filter((i) => i.path);
    if (done.length) console.log(`superagent: skill installed for ${done.map((i) => i.label).join(', ')}. Open one and say "use superagent".`);
  } catch {
    /* best effort */
  }
}
