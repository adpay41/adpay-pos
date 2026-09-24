/**
 * API configuration from the environment. Loads the repo-root .env when present (created by
 * `pnpm dev` on first run). FINIX_* variables are deliberately absent: only the Finix adapter reads
 * them (ADR 0003).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');

const envFile = resolve(REPO_ROOT, '.env');
if (existsSync(envFile) && process.env.ADPAY_SKIP_DOTENV !== '1') process.loadEnvFile(envFile);

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}. Run \`pnpm dev\` once to create .env.`);
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

/** For scripts (migrate, seed) that need only the database. */
export function loadDatabaseUrl(): string {
  return str('DATABASE_URL', 'postgres://adpay@127.0.0.1:5433/adpay');
}

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string | null;
  jwtSecret: string;
  jwtIssuer: string;
  deviceTokenTtlDays: number;
  otpDelivery: 'log' | 'twilio';
  corsOrigins: string[];
  paymentProvider: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV ?? 'development') as Config['env'];
  const config: Config = {
    env,
    port: int('API_PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),
    databaseUrl: overrides.databaseUrl ?? str('DATABASE_URL', 'postgres://adpay@127.0.0.1:5433/adpay'),
    redisUrl: process.env.REDIS_URL || null,
    jwtSecret: overrides.jwtSecret ?? str('JWT_SECRET'),
    jwtIssuer: str('JWT_ISSUER', 'adpay'),
    deviceTokenTtlDays: int('DEVICE_TOKEN_TTL_DAYS', 365),
    otpDelivery: (process.env.OTP_DELIVERY as Config['otpDelivery']) || 'log',
    corsOrigins: str('CORS_ORIGINS', 'http://localhost:3001,http://localhost:8081,http://localhost:8082')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    paymentProvider: str('PAYMENT_PROVIDER', 'stub'),
    ...overrides,
  };
  if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  if (config.env === 'production' && config.otpDelivery === 'log') {
    throw new Error('OTP_DELIVERY=log is development-only; it would expose login codes in production');
  }
  return config;
}
