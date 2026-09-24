import { loadConfig } from './config';
import { createPgDb } from './db/db';
import { migrate } from './db/migrate';
import { createBaseLogger, systemLogger } from './http/context';
import { startJobs, type Jobs } from './jobs/maintenance';
import { createPaymentProvider } from './payments';
import { buildApp } from './server';

const config = loadConfig();
const logger = createBaseLogger(config.logLevel);
const log = systemLogger(logger);
const db = createPgDb(config.databaseUrl);

await migrate(db, (m) => log.info(m));

let jobs: Jobs | null = null;
if (config.redisUrl) {
  try {
    jobs = await startJobs(db, config.redisUrl, log);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'jobs not started — Redis unavailable; the API still serves');
  }
}

const payments = createPaymentProvider(config.paymentProvider);
const app = await buildApp({ db, config, payments, logger, jobsHealthy: jobs ? () => jobs.healthy() : undefined });

await app.listen({ port: config.port, host: '0.0.0.0' });
log.info({ port: config.port, payment_provider: payments.name }, 'AD Pay API listening');

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  await app.close();
  await jobs?.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
