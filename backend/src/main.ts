import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createChainClients } from './chain.js';
import { createIndexer } from './indexer.js';
import { buildApp } from './app.js';
import { ensureManager } from './bootstrap.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const chain = createChainClients(cfg);
const manager = await ensureManager(db, cfg, chain);
console.log(`SessionManager: ${manager}`);
const indexer = createIndexer(db, chain, cfg.indexerPollMs);
const app = await buildApp({ cfg, db, chain, indexer });

indexer.start();
await app.listen({ host: '0.0.0.0', port: cfg.port });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    indexer.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
