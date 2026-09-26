#!/usr/bin/env node
/**
 * Share the local stack with someone outside this machine:
 *
 *   npm run share
 *
 *  1. opens four Cloudflare quick tunnels (free, no account): API, admin, merchant app, register;
 *  2. starts the whole stack (`scripts/dev.mjs`) pointed at the **tunnelled API URL**, with CORS
 *     allowing the tunnelled app origins, and Expo's cache cleared so the new URL is baked in;
 *  3. waits until each public URL answers, then prints them with the demo logins.
 *
 * Quick-tunnel URLs are random and change every run. Ctrl+C stops the tunnels and the apps
 * (Postgres/Redis keep running). Output of the apps goes to .share.log.
 *
 * Needs cloudflared (winget install Cloudflare.cloudflared). Stop `npm run dev` first: the same
 * ports are used.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const LOG = join(ROOT, '.share.log');
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const PORTS = { api: 3000, admin: 3001, merchant: 8081, register: 8082 };

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync(isWin ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (probe.status === 0) return probe.stdout.split(/\r?\n/)[0].trim();
  fail('cloudflared not found. Install it: winget install Cloudflare.cloudflared (Windows) / brew install cloudflared (macOS).');
}

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => srv.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });

const children = [];
function stopAll(code = 0) {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

/** Start a quick tunnel to a local port; resolves with its public https URL. */
function tunnel(bin, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error(`no tunnel URL for port ${port} after 60s`)), 60_000);
    const scan = (chunk) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', (c) => reject(new Error(`cloudflared exited (${c}) for port ${port}`)));
  });
}

/** Poll a public URL until it answers 2xx (tunnel DNS + first compile can take a while). */
async function waitFor(url, label, ms = 300_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.error(`  ${label} did not answer at ${url} within ${ms / 1000}s — see .share.log`);
  return false;
}

async function main() {
  const bin = findCloudflared();
  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) fail(`Port ${port} (${name}) is in use. Stop \`npm run dev\` (Ctrl+C) first, then run \`npm run share\` again.`);
  }

  console.log('▸ Opening Cloudflare quick tunnels…');
  const [api, admin, merchant, register] = await Promise.all([PORTS.api, PORTS.admin, PORTS.merchant, PORTS.register].map((p) => tunnel(bin, p)));

  console.log('▸ Starting the stack against the tunnelled API (logs: .share.log) — first start takes a minute or two…');
  const log = createWriteStream(LOG);
  const dev = spawn(process.execPath, [join(ROOT, 'scripts', 'dev.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      ADPAY_EXPO_CLEAR: '1',
      // The apps call the API through its tunnel, so they work from any browser, not just this machine.
      EXPO_PUBLIC_API_URL: api,
      NEXT_PUBLIC_API_URL: api,
      API_BASE_URL: api,
      // The API accepts the tunnelled app origins (and still localhost).
      CORS_ORIGINS: ['http://localhost:3001', 'http://localhost:8081', 'http://localhost:8082', admin, merchant, register].join(','),
    },
  });
  children.push(dev);
  let logins = [];
  let inLogins = false;
  const scan = (chunk) => {
    log.write(chunk);
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.includes('AD Pay demo logins')) inLogins = true;
      else if (inLogins && /^─{20,}/.test(line.trim())) inLogins = false;
      else if (inLogins) logins.push(line);
    }
  };
  dev.stdout.on('data', scan);
  dev.stderr.on('data', scan);
  dev.on('exit', (c) => {
    console.error(`dev stack exited (${c}) — see .share.log`);
    stopAll(1);
  });

  const ok = await Promise.all([
    waitFor(`${api}/health`, 'API'),
    waitFor(`${admin}/login`, 'Admin'),
    waitFor(merchant, 'Merchant app'),
    waitFor(register, 'Register'),
  ]);

  console.log(
    [
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━ AD Pay POS — shared publicly ━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `  Admin back-office   ${bold(admin)}`,
      `  Merchant app        ${bold(merchant)}`,
      `  Register            ${bold(register)}`,
      `  API                 ${api}/health`,
      ok.every(Boolean) ? '  All four answered through their tunnels.' : '  Not everything answered yet — see above and .share.log.',
      '',
      '  Demo logins (demo data only):',
      // The seed prints localhost URLs; show the public ones in their place.
      ...logins
        .filter((l) => l.trim())
        .map((l) =>
          l
            .replace('http://localhost:3001', admin)
            .replace('http://localhost:8081', merchant)
            .replace('http://localhost:8082', register)
            .replace(/^\s{0,2}/, '  '),
        ),
      '',
      '  These URLs are public: anyone who has them can use the demo logins. They change on every run.',
      '  Ctrl+C stops the tunnels and the apps.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n'),
  );
}

main().catch((e) => {
  console.error(e.message);
  stopAll(1);
});
