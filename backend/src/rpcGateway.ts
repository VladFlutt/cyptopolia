import type { FastifyInstance } from 'fastify';

/**
 * Public JSON-RPC endpoint for players' wallets.
 * - Only the methods a wallet needs are allowed. Node admin methods (anvil_*, debug_*, admin_*, personal_*)
 *   never reach the node, so nobody can mint gas or impersonate accounts.
 * - Hot read-only calls that every open wallet polls are cached for a short time and coalesced,
 *   so thousands of wallets cost the node a few requests per second.
 * - A simple per-IP token bucket stops floods (a classroom shares one IP, so the limit is generous).
 */

const ALLOWED = new Set([
  'web3_clientVersion',
  'net_version',
  'net_listening',
  'eth_chainId',
  'eth_syncing',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_call',
  'eth_estimateGas',
  'eth_sendRawTransaction',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
]);

/** TTL in ms per method; Infinity = never changes. */
const CACHE_TTL: Record<string, number> = {
  eth_chainId: Infinity,
  net_version: Infinity,
  web3_clientVersion: Infinity,
  eth_blockNumber: 1000,
  eth_gasPrice: 2000,
  eth_maxPriorityFeePerGas: 2000,
  eth_feeHistory: 2000,
};

const MAX_LOG_RANGE = 5000;

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown[];
}

export interface GatewayOptions {
  upstream: string;
  ratePerSecond?: number;
  burst?: number;
  maxBatch?: number;
}

export function registerRpcGateway(app: FastifyInstance, opts: GatewayOptions) {
  const rate = opts.ratePerSecond ?? 60;
  const burst = opts.burst ?? 300;
  const maxBatch = opts.maxBatch ?? 20;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const cache = new Map<string, { value: unknown; until: number }>();
  const inflight = new Map<string, Promise<unknown>>();
  let upstreamCalls = 0;

  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now - b.at > 60_000) buckets.delete(ip);
    for (const [k, c] of cache) if (c.until < now) cache.delete(k);
  }, 30_000).unref();

  function allow(ip: string, cost: number): boolean {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    buckets.set(ip, b);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  async function upstream(method: string, params: unknown[]): Promise<{ result?: unknown; error?: unknown }> {
    upstreamCalls++;
    const res = await fetch(opts.upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    return json;
  }

  function cacheKey(method: string, params: unknown[]) {
    if (method in CACHE_TTL) return `${method}:${JSON.stringify(params)}`;
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') return `${method}:${JSON.stringify(params)}`;
    return null;
  }

  function ttl(method: string) {
    return CACHE_TTL[method] ?? 1000;
  }

  function checkLogRange(params: unknown[]): string | null {
    const f = (params[0] ?? {}) as { fromBlock?: string; toBlock?: string; blockHash?: string };
    if (f.blockHash) return null;
    const from = f.fromBlock?.startsWith('0x') ? parseInt(f.fromBlock, 16) : NaN;
    const to = f.toBlock?.startsWith('0x') ? parseInt(f.toBlock, 16) : NaN;
    if (Number.isNaN(from) || Number.isNaN(to) || to - from > MAX_LOG_RANGE)
      return `eth_getLogs: укажите числовой диапазон не больше ${MAX_LOG_RANGE} блоков`;
    return null;
  }

  async function handleOne(req: RpcRequest) {
    const id = req.id ?? null;
    const method = req.method ?? '';
    const params = Array.isArray(req.params) ? req.params : [];
    if (!ALLOWED.has(method)) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Метод ${method} недоступен в игровой сети` } };
    }
    if (method === 'eth_getLogs') {
      const err = checkLogRange(params);
      if (err) return { jsonrpc: '2.0', id, error: { code: -32602, message: err } };
    }
    const key = cacheKey(method, params);
    if (key) {
      const hit = cache.get(key);
      if (hit && hit.until > Date.now()) return { jsonrpc: '2.0', id, result: hit.value };
      let p = inflight.get(key);
      if (!p) {
        p = upstream(method, params)
          .then((r) => {
            if (r.error) throw r.error;
            cache.set(key, { value: r.result, until: Date.now() + ttl(method) });
            return r.result;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      try {
        return { jsonrpc: '2.0', id, result: await p };
      } catch (error) {
        return { jsonrpc: '2.0', id, error };
      }
    }
    const r = await upstream(method, params);
    return r.error ? { jsonrpc: '2.0', id, error: r.error } : { jsonrpc: '2.0', id, result: r.result };
  }

  app.post('/rpc', async (request, reply) => {
    const body = request.body as RpcRequest | RpcRequest[];
    const batch = Array.isArray(body) ? body : [body];
    if (batch.length === 0 || batch.length > maxBatch)
      return reply.status(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Слишком большой пакет запросов' } });
    if (!allow(request.ip, batch.length))
      return reply.status(429).send({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'Слишком много запросов' } });
    const out = await Promise.all(batch.map(handleOne));
    return Array.isArray(body) ? out : out[0];
  });

  return { stats: () => ({ upstreamCalls }) };
}
