import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount, nonceManager, privateKeyToAccount } from 'viem/accounts';
import type { Config } from './config.js';

export const managerAbi = [
  {
    type: 'function',
    name: 'createSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'bank', type: 'address' },
      { name: 'names', type: 'string[]' },
      { name: 'symbols', type: 'string[]' },
      { name: 'bankReserves', type: 'uint256[]' },
    ],
    outputs: [{ name: 'tokens', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'addPlayers',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'players', type: 'address[]' },
      { name: 'tokenIndex', type: 'uint256' },
      { name: 'startAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'tokenIndex', type: 'uint256' },
      { name: 'to', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'stopSession',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'predictToken',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'isMember',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export const tokenAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export function makeChain(cfg: Config): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.chainName,
    nativeCurrency: { name: cfg.nativeSymbol, symbol: cfg.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
}

export function createChainClients(cfg: Config) {
  const chain = makeChain(cfg);
  const transport = http(cfg.rpcUrl, { batch: { wait: 5 } });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const operator = privateKeyToAccount(cfg.operatorKey, { nonceManager });
  const operatorWallet = createWalletClient({ chain, transport, account: operator });

  const bankAccount = (sessionId: number) =>
    mnemonicToAccount(cfg.bankMnemonic, { addressIndex: sessionId, nonceManager });
  const bankWallet = (sessionId: number) =>
    createWalletClient({ chain, transport, account: bankAccount(sessionId) });

  async function wait(hash: Hex) {
    const r = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    if (r.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    return r;
  }

  async function sendNative(to: Address, amount: string) {
    return wait(await operatorWallet.sendTransaction({ to, value: parseEther(amount) }));
  }

  return { chain, publicClient, operator, operatorWallet, bankAccount, bankWallet, wait, sendNative };
}

export type ChainClients = ReturnType<typeof createChainClients>;
