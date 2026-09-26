/**
 * Public, unauthenticated pages. Only the digital receipt (P18, ADR 0027): reached by the QR on the
 * receipt or the customer screen, keyed by a random token, not by the sale id.
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server';
import { receiptByToken, receiptHtml } from '../services/i18n';

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function publicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/r/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const page = TOKEN.test(token) ? await receiptByToken(deps.db, token.toLowerCase()) : null;
    return reply
      .status(page ? 200 : 404)
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-robots-tag', 'noindex')
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      .send(receiptHtml(page));
  });
}
