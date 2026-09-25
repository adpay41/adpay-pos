#!/usr/bin/env node
/**
 * One command from a clean clone to the whole stack running locally:
 *
 *   pnpm dev          (or, before pnpm is set up:  npm run dev  /  node scripts/dev.mjs)
 *
 *  1. creates .env from .env.example with local values (random JWT secret — never committed)
 *  2. installs dependencies (pnpm via corepack; nothing global needed)
 *  3. starts Postgres 16 + Redis in Docker and waits until healthy
 *  4. migrates and seeds the demo store (seed is skipped if already present)
 *  5. runs API :3000, admin :3001, merchant app :8081, register :8082 — Ctrl+C stops all
 *
 * Flags:  --reset       wipe the local database and reseed
 *         --no-docker   use an already-running Postgres/Redis from .env instead of Docker
 *
 * Zero dependencies on purpose: it must run before `pnpm install` has.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c('31');
const green = c('32');
const dim = c('2');
const bold = c('1');

function step(msg) {
  console.log(`\n${bold('▸')} ${msg}`);
}
function fail(msg) {
  console.error(`\n${red('✖')} ${msg}\n`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status ?? r.signal})`);
}

// ── 0. Node ──────────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 20 || minor < 19) fail(`Node 20.19+ (20 LTS) is required; this is ${process.version}. See .nvmrc.`);

// ── 1. .env ──────────────────────────────────────────────────────────────────
const LOCAL_DEFAULTS = {
  NODE_ENV: 'development',
  API_PORT: '3000',
  API_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://adpay@127.0.0.1:5433/adpay',
  REDIS_URL: 'redis://127.0.0.1:6380',
  JWT_SECRET: () => randomBytes(48).toString('base64url'),
  ADMIN_SESSION_SECRET: () => randomBytes(48).toString('base64url'),
  DEVICE_TOKEN_TTL_DAYS: '365',
  PAYMENT_PROVIDER: 'stub',
  OTP_DELIVERY: 'log',
  CORS_ORIGINS: 'http://localhost:3001,http://localhost:8081,http://localhost:8082',
};

function ensureEnv() {
  const envPath = join(ROOT, '.env');
  const created = !existsSync(envPath);
  const text = created ? readFileSync(join(ROOT, '.env.example'), 'utf8') : readFileSync(envPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) return line;
    const [, key, value] = m;
    seen.add(key);
    const def = LOCAL_DEFAULTS[key];
    if (value.trim() === '' && def !== undefined) return `${key}=${typeof def === 'function' ? def() : def}`;
    return line;
  });
  for (const [key, def] of Object.entries(LOCAL_DEFAULTS)) {
    if (!seen.has(key)) out.push(`${key}=${typeof def === 'function' ? def() : def}`);
  }
  writeFileSync(envPath, out.join('\n'));
  console.log(dim(created ? '  created .env with local defaults (gitignored)' : '  .env present; filled any empty local values'));
}

step('Environment');
ensureEnv();

// ── 2. dependencies ──────────────────────────────────────────────────────────
step('Dependencies (pnpm via corepack)');
run('corepack', ['pnpm', 'install']);

// ── 3. datastores ────────────────────────────────────────────────────────────
if (!args.has('--no-docker')) {
  step('Postgres 16 + Redis (Docker)');
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { shell: isWin, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    fail(
      'Docker is not running. Install Docker Desktop (with WSL 2 on Windows), start it, then re-run `pnpm dev`.\n' +
        '  Or run your own Postgres 16 + Redis, point DATABASE_URL / REDIS_URL at them in .env, and use `pnpm dev --no-docker`.',
    );
  }
  run('docker', ['compose', 'up', '-d', '--wait']);
}

// ── 4. migrate + seed ────────────────────────────────────────────────────────
step(args.has('--reset') ? 'Reset, migrate and seed' : 'Migrate and seed');
run('corepack', ['pnpm', '--filter', '@adpay/api', 'db:seed', ...(args.has('--reset') ? ['--', '--reset'] : [])]);

// ── 5. run everything ────────────────────────────────────────────────────────
step('Starting API, admin, merchant app and register');

const SERVICES = [
  { name: 'api', color: '36', filter: '@adpay/api', script: 'dev' },
  { name: 'admin', color: '35', filter: '@adpay/admin', script: 'dev' },
  { name: 'merchant', color: '33', filter: '@adpay/merchant', script: 'web' },
  { name: 'register', color: '32', filter: '@adpay/register', script: 'web' },
];
const width = Math.max(...SERVICES.map((s) => s.name.length));
const children = [];

for (const svc of SERVICES) {
  // `npm run share` sets ADPAY_EXPO_CLEAR: Expo inlines EXPO_PUBLIC_API_URL into the bundle and Metro
  // caches it, so a new tunnel URL needs a cleared cache or the apps keep calling the old API.
  const extra = process.env.ADPAY_EXPO_CLEAR === '1' && svc.script === 'web' ? ['--', '--clear'] : [];
  const child = spawn('corepack', ['pnpm', '--filter', svc.filter, svc.script, ...extra], {
    cwd: ROOT,
    shell: isWin,
    env: {
      ...process.env,
      ...(process.env.NO_COLOR ? {} : { FORCE_COLOR: '1' }),
      BROWSER: 'none',
      EXPO_NO_TELEMETRY: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  const tag = c(svc.color)(svc.name.padEnd(width));
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(`${tag} │ ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${tag} │ ${dim(`exited (${code})`)}`));
  children.push(child);
}

setTimeout(() => {
  console.log(
    [
      '',
      green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ AD Pay POS is starting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
      `  Admin back-office   ${bold('http://localhost:3001')}`,
      `  Merchant app        ${bold('http://localhost:8081')}`,
      `  Register            ${bold('http://localhost:8082')}`,
      `  API                 ${bold('http://localhost:3000/health')}`,
      '  Logins and register setup codes are printed above by the seed step.',
      '  The web apps take ~30s to compile on first load. Ctrl+C stops everything.',
      green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
      '',
    ].join('\n'),
  );
}, 4000);

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log(dim('\nstopping…  (Postgres/Redis keep running; `pnpm db:down` stops them)'));
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
