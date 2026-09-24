#!/usr/bin/env node
/**
 * Run the whole test suite with database tests on the real Postgres from docker-compose.yml —
 * the same way CI runs it. Starts the containers if needed.
 *
 *   npm run test:pg      (or pnpm test:pg)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.platform === 'win32';
const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
run('corepack', ['pnpm', '-r', '--if-present', 'test'], {
  ...process.env,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://adpay@127.0.0.1:5433/postgres',
  REQUIRE_REAL_POSTGRES: '1',
});
