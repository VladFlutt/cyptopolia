import type { Address, Hex } from 'viem';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { ChainClients } from './chain.js';
import artifact from './artifacts/SessionManager.json' with { type: 'json' };

/**
 * Makes sure SessionManager exists on the chain.
 * First start: deploys it and remembers the address in the database.
 * If the chain was reset but the database was not, refuses to start: the two must be reset together.
 */
export async function ensureManager(db: DB, cfg: Config, chain: ChainClients): Promise<Address> {
  const saved = db.prepare("SELECT value FROM kv WHERE key = 'manager_address'").get() as { value: string } | undefined;
  const address = (cfg.managerAddress ?? saved?.value) as Address | undefined;

  if (address) {
    const code = await chain.publicClient.getCode({ address });
    if (!code || code === '0x') {
      throw new Error(
        `SessionManager ${address} не найден в сети. Сеть сбросили без базы: удалите файл базы или задайте MANAGER_ADDRESS.`,
      );
    }
    cfg.managerAddress = address;
    return address;
  }

  const hash = await chain.operatorWallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [chain.operator.address],
  });
  const receipt = await chain.wait(hash);
  const deployed = receipt.contractAddress!;
  db.prepare("INSERT INTO kv (key, value) VALUES ('manager_address', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    deployed,
  );
  db.prepare("INSERT INTO kv (key, value) VALUES ('indexer_block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    receipt.blockNumber.toString(),
  );
  cfg.managerAddress = deployed;
  return deployed;
}
