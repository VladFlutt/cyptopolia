import type { Address, Hex } from 'viem';

export interface Config {
  port: number;
  /** Internal RPC used by the backend (straight to the node). */
  rpcUrl: string;
  /** Public HTTPS RPC that players' wallets use (goes through the caching proxy). */
  publicRpcUrl: string;
  /** Public URL of the web app, used in QR codes and SIWE domain. */
  publicUrl: string;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  /** Deployed automatically on first start when not set. */
  managerAddress?: Address;
  operatorKey: Hex;
  /** BIP-39 phrase; bank of session N is derived at address index N. */
  bankMnemonic: string;
  dbPath: string;
  superadmins: Address[];
  maxActiveSessionsPerHost: number;
  maxPlayersLimit: number;
  defaultStartBalance: number;
  /** Native coin sent to every player and bank for gas, in whole coins. */
  playerGasDrip: string;
  bankGasDrip: string;
  indexerPollMs: number;
}

function req(name: string, env = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function loadConfig(env = process.env): Config {
  const get = (n: string, d?: string) => env[n] ?? d;
  return {
    port: Number(get('PORT', '8080')),
    rpcUrl: get('RPC_URL', 'http://127.0.0.1:8545')!,
    publicUrl: get('PUBLIC_URL', 'http://localhost:8080')!,
    publicRpcUrl: get('PUBLIC_RPC_URL', `${get('PUBLIC_URL', 'http://localhost:8080')!.replace(/\/$/, '')}/rpc`)!,
    chainId: Number(get('CHAIN_ID', '31337')),
    chainName: get('CHAIN_NAME', 'Криптополия (игровая)')!,
    nativeSymbol: get('NATIVE_SYMBOL', 'CPL')!,
    managerAddress: env.MANAGER_ADDRESS ? (env.MANAGER_ADDRESS as Address) : undefined,
    operatorKey: req('OPERATOR_KEY', env) as Hex,
    bankMnemonic: req('BANK_MNEMONIC', env),
    dbPath: get('DB_PATH', './data/cryptopolia.db')!,
    superadmins: (get('SUPERADMINS', '') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean) as Address[],
    maxActiveSessionsPerHost: Number(get('MAX_ACTIVE_SESSIONS_PER_HOST', '3')),
    maxPlayersLimit: Number(get('MAX_PLAYERS', '6')),
    defaultStartBalance: Number(get('DEFAULT_START_BALANCE', '1500')),
    playerGasDrip: get('PLAYER_GAS_DRIP', '0.05')!,
    bankGasDrip: get('BANK_GAS_DRIP', '1')!,
    indexerPollMs: Number(get('INDEXER_POLL_MS', '1000')),
  };
}
