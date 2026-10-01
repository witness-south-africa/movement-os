import { readFileSync } from 'node:fs';

const { packageManager } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const actual = process.env.npm_config_user_agent?.split(' ')[0];
if (actual !== packageManager.replace('@', '/')) {
  console.error(
    `Use Corepack with ${packageManager} to install this workspace.`,
  );
  process.exit(1);
}
