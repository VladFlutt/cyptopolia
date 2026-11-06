import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import type { Address } from 'viem';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { ChainClients } from './chain.js';
import { HttpError, createAuth } from './auth.js';
import { createSessions } from './sessions.js';
import type { Indexer, IndexedTransfer } from './indexer.js';
import { registerRpcGateway } from './rpcGateway.js';

export interface AppDeps {
  cfg: Config;
  db: DB;
  chain: ChainClients;
  indexer: Indexer;
}

export async function buildApp({ cfg, db, chain, indexer }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true });
  await app.register(cors, { origin: true });

  const gateway = registerRpcGateway(app, {
    upstream: cfg.rpcUrl,
    ratePerSecond: Number(process.env.RPC_RATE_PER_IP ?? 60),
    burst: Number(process.env.RPC_BURST_PER_IP ?? 300),
  });
  app.decorate('rpcStats', gateway.stats);

  const auth = createAuth(db, cfg, chain.publicClient);
  const sessions = createSessions(db, cfg, chain);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Внутренняя ошибка сервера' });
  });

  const who = (req: FastifyRequest) => {
    const user = auth.requireUser(req);
    return { user, superadmin: auth.isSuperadmin(user) };
  };
  const idParam = (req: FastifyRequest) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный номер партии');
    return id;
  };
  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as T;

  // ---------- public ----------

  app.get('/api/health', async () => ({ ok: true, block: Number(await chain.publicClient.getBlockNumber()) }));

  /** Everything a wallet needs for wallet_addEthereumChain, plus the SIWE domain. */
  app.get('/api/config', async () => ({
    chainId: cfg.chainId,
    chainIdHex: `0x${cfg.chainId.toString(16)}`,
    chainName: cfg.chainName,
    nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
    rpcUrls: [cfg.publicRpcUrl],
    siweDomain: auth.siweDomain,
    publicUrl: cfg.publicUrl,
  }));

  app.post('/api/auth/nonce', async () => ({ nonce: auth.issueNonce() }));

  app.post('/api/auth/verify', async (req) => {
    const { message, signature } = body<{ message?: string; signature?: `0x${string}` }>(req);
    if (!message || !signature) throw new HttpError(400, 'Нужны сообщение и подпись');
    const { token, address } = await auth.verify(message, signature);
    return { token, address, superadmin: auth.isSuperadmin(address) };
  });

  // ---------- host ----------

  app.get('/api/sessions', async (req) => {
    const { user, superadmin } = who(req);
    return { sessions: sessions.listFor(user, superadmin) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const { user } = who(req);
    const b = body<{ title?: string; maxPlayers?: number; startBalance?: number }>(req);
    const s = await sessions.create(user, b);
    return reply.status(201).send(s);
  });

  app.get('/api/sessions/:id', async (req) => {
    const { user, superadmin } = who(req);
    return sessions.details(idParam(req), user, superadmin);
  });

  app.post('/api/sessions/:id/pay', async (req) => {
    const { user, superadmin } = who(req);
    return sessions.pay(idParam(req), user, superadmin, body(req));
  });

  app.post('/api/sessions/:id/gas', async (req) => {
    const { user, superadmin } = who(req);
    return sessions.topUpGas(idParam(req), user, superadmin, body<{ to: string }>(req).to);
  });

  app.put('/api/sessions/:id/prices', async (req) => {
    const { user, superadmin } = who(req);
    return { prices: sessions.setPrices(idParam(req), user, superadmin, body<Record<string, unknown>>(req)) };
  });

  app.post('/api/sessions/:id/stop', async (req) => {
    const { user, superadmin } = who(req);
    return sessions.stop(idParam(req), user, superadmin);
  });

  /** Live transfer feed for the host screen (Server-Sent Events; token in the query, EventSource has no headers). */
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const q = req.query as { token?: string };
    if (q.token) req.headers.authorization = `Bearer ${q.token}`;
    const { user, superadmin } = who(req);
    const id = idParam(req);
    await sessions.details(id, user, superadmin); // access check
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (t: IndexedTransfer) => reply.raw.write(`event: transfer\ndata: ${JSON.stringify(t)}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    indexer.events.on(`session:${id}`, send);
    req.raw.on('close', () => {
      clearInterval(ping);
      indexer.events.off(`session:${id}`, send);
    });
  });

  // ---------- player ----------

  app.get('/api/join/:code', async (req) => sessions.publicByCode((req.params as { code: string }).code));

  app.post('/api/join/:code', async (req) => {
    const user: Address = auth.requireUser(req);
    const { name } = body<{ name?: string }>(req);
    return sessions.join((req.params as { code: string }).code, user, name ?? '');
  });

  app.get('/api/join/:code/me', async (req) => {
    const user: Address = auth.requireUser(req);
    return sessions.playerState((req.params as { code: string }).code, user);
  });

  return app;
}
