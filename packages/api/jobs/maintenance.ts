/**
 * Background jobs on Redis + BullMQ. Redis is a job queue only, never a source of truth.
 *  - keep `sale_events` monthly partitions created ahead of the month boundary (ADR 0001);
 *  - evaluate the alert rules every minute (P4);
 *  - prune heartbeat history older than 7 days (P4).
 */
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import type pino from 'pino';
import type { Db } from '../db/db';
import { evaluateAlerts, logNotifier } from '../services/alerts';
import { pruneHeartbeats } from '../services/ops';

const QUEUE = 'maintenance';

export async function ensureUpcomingPartitions(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ part: string }>(
    `SELECT ensure_sale_events_partition(now() + make_interval(months => m)) AS part FROM generate_series(0, 2) AS m`,
  );
  return rows.map((r) => r.part);
}

export interface Jobs {
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export async function startJobs(db: Db, redisUrl: string, log: pino.Logger): Promise<Jobs> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  // ioredis retries forever; report the first failure of each outage, not every retry.
  let failing = false;
  connection.on('error', (err) => {
    if (!failing) log.warn({ err: err.message }, 'redis connection error (retrying quietly)');
    failing = true;
  });
  connection.on('ready', () => {
    if (failing) log.info('redis connection restored');
    failing = false;
  });
  try {
    await Promise.race([
      connection.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer from ${redisUrl} in 3s`)), 3000)),
    ]);
  } catch (err) {
    connection.disconnect();
    throw err;
  }

  const queue = new Queue(QUEUE, { connection });
  await queue.upsertJobScheduler('ensure-partitions', { every: 6 * 60 * 60 * 1000 }, { name: 'ensure-partitions' });
  await queue.upsertJobScheduler('evaluate-alerts', { every: 60_000 }, { name: 'evaluate-alerts', opts: { removeOnComplete: 50, removeOnFail: 50 } });
  await queue.upsertJobScheduler('prune-heartbeats', { every: 24 * 60 * 60 * 1000 }, { name: 'prune-heartbeats' });
  const notifier = logNotifier((obj, msg) => log.info(obj, msg));

  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === 'ensure-partitions') {
        const parts = await ensureUpcomingPartitions(db);
        log.info({ job: job.name, partitions: parts }, 'sale_events partitions ensured');
      } else if (job.name === 'evaluate-alerts') {
        const r = await evaluateAlerts(db, notifier, new Date(), `job-${job.id}`);
        if (r.opened.length || r.resolved) log.info({ job: job.name, opened: r.opened.length, resolved: r.resolved }, 'alerts evaluated');
      } else if (job.name === 'prune-heartbeats') {
        log.info({ job: job.name, deleted: await pruneHeartbeats(db) }, 'heartbeat history pruned');
      }
    },
    { connection },
  );
  worker.on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'job failed'));

  // Run once at boot as well so a fresh database is never a month behind.
  await queue.add('ensure-partitions', {}, { removeOnComplete: 100, removeOnFail: 100 });

  return {
    async healthy() {
      return (await connection.ping()) === 'PONG';
    },
    async close() {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}
