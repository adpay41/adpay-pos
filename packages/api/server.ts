import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type pino from 'pino';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { Db } from './db/db';
import { makeAuthenticate } from './http/auth-hooks';
import { bindRequestLogger, systemLogger } from './http/context';
import { HttpError } from './http/errors';
import type { PaymentProvider } from './payments';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { deviceRoutes } from './routes/device';
import { merchantRoutes } from './routes/merchant';

export interface AppDeps {
  db: Db;
  config: Config;
  payments: PaymentProvider;
  logger: pino.Logger;
  /** Reports Redis/job health; absent when running without Redis (tests). */
  jobsHealthy?: (() => Promise<boolean>) | undefined;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, config, logger } = deps;
  const app = Fastify({
    loggerInstance: systemLogger(logger) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('logContext', null as never);

  // Bind trace_id (and null tenancy) to the request logger before anything else runs.
  app.addHook('onRequest', async (request, reply) => {
    bindRequestLogger(logger, request);
    reply.header('x-trace-id', request.logContext.trace_id);
  });
  app.addHook('onRequest', makeAuthenticate(db, config, logger));
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, url: request.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    // @fastify/cors defaults to GET/HEAD/POST only; the catalog editor PATCHes from the browser.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
    credentials: false,
    exposedHeaders: ['x-trace-id'],
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        trace_id: request.logContext.trace_id,
      });
    }
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details, trace_id: request.logContext.trace_id });
    }
    // Unique-constraint violations are user errors ("that UPC is already on another item"), not 500s.
    const pgCode = (err as { code?: unknown }).code;
    if (pgCode === '23505') {
      const constraint = String((err as { constraint?: unknown }).constraint ?? '');
      const what = /upc|barcode/.test(constraint) ? 'barcode' : /plu/.test(constraint) ? 'PLU' : /name/.test(constraint) ? 'name' : 'value';
      return reply.status(409).send({
        error: 'conflict',
        message: `That ${what} is already in use in this catalog`,
        trace_id: request.logContext.trace_id,
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: (err as Error).message, trace_id: request.logContext.trace_id });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong', trace_id: request.logContext.trace_id });
  });

  app.get('/health', async () => {
    const dbOk = await db.query('SELECT 1').then(
      () => true,
      () => false,
    );
    const jobs = deps.jobsHealthy ? await deps.jobsHealthy().catch(() => false) : null;
    return { ok: dbOk, db: dbOk, jobs, payment_provider: deps.payments.name, env: config.env };
  });

  await app.register(async (scope) => authRoutes(scope, deps));
  await app.register(async (scope) => adminRoutes(scope, deps));
  await app.register(async (scope) => merchantRoutes(scope, deps));
  await app.register(async (scope) => deviceRoutes(scope, deps));
  await app.register(async (scope) => catalogRoutes(scope, deps));

  return app;
}
