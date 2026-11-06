import { EventEmitter } from 'node:events';
import { parseAbiItem, type Address } from 'viem';
import type { DB } from './db.js';
import type { ChainClients } from './chain.js';

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MAX_RANGE = 1000n;

export interface IndexedTransfer {
  sessionId: number;
  symbol: string;
  from: string;
  to: string;
  value: string;
  tx: string;
  block: number;
}

/**
 * One indexer for the whole network. Only game tokens live on this chain, so a single
 * getLogs over all Transfer events replaces per-session polling.
 */
export function createIndexer(db: DB, chain: ChainClients, pollMs: number) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const getCursor = () => {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'indexer_block'").get() as { value: string } | undefined;
    return row ? BigInt(row.value) : undefined;
  };
  const setCursor = (b: bigint) =>
    db.prepare("INSERT INTO kv (key, value) VALUES ('indexer_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      b.toString(),
    );

  const lookup = db.prepare('SELECT session_id, symbol FROM token_index WHERE token = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transfers (session_id, symbol, sender, recipient, value, tx_hash, block, log_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /** Indexes everything up to the latest block. Returns the number of stored transfers. */
  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let stored = 0;
    try {
      const latest = await chain.publicClient.getBlockNumber();
      let from: bigint = getCursor() ?? 0n;
      while (from <= latest) {
        const to: bigint = from + MAX_RANGE - 1n < latest ? from + MAX_RANGE - 1n : latest;
        const logs = await chain.publicClient.getLogs({ event: transferEvent, fromBlock: from, toBlock: to });
        const fresh: IndexedTransfer[] = [];
        db.exec('BEGIN');
        try {
          for (const log of logs) {
            const meta = lookup.get((log.address as Address).toLowerCase()) as
              | { session_id: number; symbol: string }
              | undefined;
            if (!meta) continue;
            const t: IndexedTransfer = {
              sessionId: meta.session_id,
              symbol: meta.symbol,
              from: log.args.from!.toLowerCase(),
              to: log.args.to!.toLowerCase(),
              value: log.args.value!.toString(),
              tx: log.transactionHash!,
              block: Number(log.blockNumber),
            };
            const r = insert.run(t.sessionId, t.symbol, t.from, t.to, t.value, t.tx, t.block, log.logIndex!);
            if (r.changes) fresh.push(t);
          }
          setCursor(to + 1n);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        for (const t of fresh) events.emit(`session:${t.sessionId}`, t);
        stored += fresh.length;
        from = to + 1n;
      }
    } finally {
      running = false;
    }
    return stored;
  }

  function start() {
    const loop = async () => {
      try {
        await tick();
      } catch (e) {
        console.error('indexer:', (e as Error).message);
      }
      timer = setTimeout(loop, pollMs);
    };
    void loop();
  }

  function stop() {
    if (timer) clearTimeout(timer);
  }

  return { tick, start, stop, events };
}

export type Indexer = ReturnType<typeof createIndexer>;
