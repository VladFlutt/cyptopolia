import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type Address,
  type Hex,
} from 'viem';
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createChainClients, makeChain, tokenAbi } from '../src/chain.js';
import { createIndexer, type Indexer } from '../src/indexer.js';
import { buildApp } from '../src/app.js';
import { ensureManager } from '../src/bootstrap.js';

const ANVIL = process.env.ANVIL_BIN ?? 'anvil';
const OPERATOR_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

let anvil: ChildProcess;
let app: FastifyInstance;
let cfg: Config;
let indexer: Indexer;
let chain: ReturnType<typeof createChainClients>;

const host = privateKeyToAccount(generatePrivateKey());
const otherHost = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());

async function login(acc: PrivateKeyAccount): Promise<string> {
  const { nonce } = (await app.inject({ method: 'POST', url: '/api/auth/nonce' })).json();
  const message = createSiweMessage({
    domain: new URL(cfg.publicUrl).host,
    address: acc.address,
    chainId: cfg.chainId,
    nonce,
    uri: cfg.publicUrl,
    version: '1',
    statement: 'Вход в Криптополию',
  });
  const signature = await acc.signMessage({ message });
  const res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } });
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

function playerWallet(acc: PrivateKeyAccount) {
  return createWalletClient({ chain: makeChain(cfg), transport: http(cfg.rpcUrl), account: acc });
}

beforeAll(async () => {
  const port = await freePort();
  anvil = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  for (let i = 0; ; i++) {
    try {
      await probe.getBlockNumber();
      break;
    } catch {
      if (i > 50) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  cfg = loadConfig({
    RPC_URL: rpcUrl,
    CHAIN_ID: '31337',
    PUBLIC_URL: 'https://play.cryptopolia.test',
    OPERATOR_KEY,
    BANK_MNEMONIC: generateMnemonic(english),
    SUPERADMINS: admin.address,
    MAX_ACTIVE_SESSIONS_PER_HOST: '3',
  });
  const db = openDb(':memory:');
  chain = createChainClients(cfg);
  await ensureManager(db, cfg, chain);
  indexer = createIndexer(db, chain, 1000);
  app = await buildApp({ cfg, db, chain, indexer });
}, 30_000);

afterAll(async () => {
  await app?.close();
  anvil?.kill();
});

describe('a full game', () => {
  let hostToken: string;
  let aliceToken: string;
  let bobToken: string;
  let session: {
    id: number;
    code: string;
    bank: Address;
    tokens: { symbol: string; address: Address }[];
  };
  const tokenAddr = (sym: string) => session.tokens.find((t) => t.symbol === sym)!.address;
  const balance = (sym: string, who: Address) =>
    chain.publicClient.readContract({ address: tokenAddr(sym), abi: tokenAbi, functionName: 'balanceOf', args: [who] });

  it('rejects a reused sign-in nonce', async () => {
    const { nonce } = (await app.inject({ method: 'POST', url: '/api/auth/nonce' })).json();
    const message = createSiweMessage({
      domain: new URL(cfg.publicUrl).host,
      address: alice.address,
      chainId: cfg.chainId,
      nonce,
      uri: cfg.publicUrl,
      version: '1',
    });
    const signature = await alice.signMessage({ message });
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { message, signature } })).statusCode).toBe(401);
  });

  it('host signs in with a wallet and creates a session', async () => {
    hostToken = await login(host);
    const res = await call(hostToken, 'POST', '/api/sessions', { title: 'Группа ЭК-21', maxPlayers: 2, startBalance: 1500 });
    expect(res.statusCode).toBe(201);
    session = res.json();
    expect(session.tokens).toHaveLength(8);
    expect(session.tokens.every((t) => /^0x[0-9a-f]{40}$/.test(t.address))).toBe(true);
    expect(await balance('USDG', session.bank)).toBe(parseEther('1000000'));
    expect(await chain.publicClient.getBalance({ address: session.bank })).toBe(parseEther(cfg.bankGasDrip));
  });

  it('players join by code and get the start balance and gas', async () => {
    aliceToken = await login(alice);
    bobToken = await login(bob);
    const pub = await app.inject({ method: 'GET', url: `/api/join/${session.code.toLowerCase()}` });
    expect(pub.json().status).toBe('active');

    expect((await call(aliceToken, 'POST', `/api/join/${session.code}`, { name: 'Алиса' })).statusCode).toBe(200);
    expect((await call(bobToken, 'POST', `/api/join/${session.code}`, { name: 'Боб' })).statusCode).toBe(200);
    const again = await call(aliceToken, 'POST', `/api/join/${session.code}`, { name: 'Алиса' });
    expect(again.json().alreadyJoined).toBe(true);

    expect(await balance('USDG', alice.address)).toBe(parseEther('1500'));
    expect(formatEther(await chain.publicClient.getBalance({ address: alice.address }))).toBe(cfg.playerGasDrip);

    const carolToken = await login(carol);
    const full = await call(carolToken, 'POST', `/api/join/${session.code}`, { name: 'Кэрол' });
    expect(full.statusCode).toBe(409);
  });

  it('players pay each other from their own wallets, outsiders cannot receive', async () => {
    const w = playerWallet(alice);
    await chain.wait(
      await w.writeContract({ address: tokenAddr('USDG'), abi: tokenAbi, functionName: 'transfer', args: [bob.address, parseEther('200')] }),
    );
    expect(await balance('USDG', bob.address)).toBe(parseEther('1700'));

    await expect(
      chain.publicClient.simulateContract({
        account: alice,
        address: tokenAddr('USDG'),
        abi: tokenAbi,
        functionName: 'transfer',
        args: [outsider.address, 1n],
      }),
    ).rejects.toThrow();
  });

  it('host pays from the bank, tops up gas and changes prices', async () => {
    const salary = await call(hostToken, 'POST', `/api/sessions/${session.id}/pay`, { to: 'all', token: 'USDG', amount: '200' });
    expect(salary.statusCode).toBe(200);
    const btk = await call(hostToken, 'POST', `/api/sessions/${session.id}/pay`, { to: alice.address, token: 'btk', amount: '0,01' });
    expect(btk.statusCode).toBe(200);
    expect(await balance('BTK', alice.address)).toBe(parseEther('0.01'));

    const bad = await call(hostToken, 'POST', `/api/sessions/${session.id}/pay`, { to: outsider.address, token: 'USDG', amount: '1' });
    expect(bad.statusCode).toBe(400);

    expect((await call(hostToken, 'POST', `/api/sessions/${session.id}/gas`, { to: bob.address })).statusCode).toBe(200);

    const prices = await call(hostToken, 'PUT', `/api/sessions/${session.id}/prices`, { BTK: 120000 });
    expect(prices.json().prices.BTK).toBe(120000);
  });

  it('indexer records the session transfers and the host sees them', async () => {
    await indexer.tick();
    const res = await call(hostToken, 'GET', `/api/sessions/${session.id}`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    // 2 start mints + 1 player transfer + 2 salaries + 1 BTK payout (bank reserves are mints too: 8)
    const nonMint = d.transfers.filter((t: { from: string }) => t.from !== '0x0000000000000000000000000000000000000000');
    expect(nonMint).toHaveLength(4);
    expect(d.standings[0].name).toBe('Алиса');

    const me = await call(aliceToken, 'GET', `/api/join/${session.code}/me`);
    expect(me.json().balances.find((b: { symbol: string }) => b.symbol === 'USDG').amount).toBe('1500');
  });

  it('other hosts cannot touch the session; the superadmin can see it', async () => {
    const otherToken = await login(otherHost);
    expect((await call(otherToken, 'GET', `/api/sessions/${session.id}`)).statusCode).toBe(403);
    expect((await call(otherToken, 'POST', `/api/sessions/${session.id}/stop`)).statusCode).toBe(403);
    expect((await call(otherToken, 'GET', '/api/sessions')).json().sessions).toHaveLength(0);

    const adminToken = await login(admin);
    expect((await call(adminToken, 'GET', '/api/sessions')).json().sessions.length).toBeGreaterThan(0);
    expect((await call(adminToken, 'GET', `/api/sessions/${session.id}`)).statusCode).toBe(200);
  });

  it('limits active sessions per host', async () => {
    expect((await call(hostToken, 'POST', '/api/sessions', {})).statusCode).toBe(201);
    expect((await call(hostToken, 'POST', '/api/sessions', {})).statusCode).toBe(201);
    const fourth = await call(hostToken, 'POST', '/api/sessions', {});
    expect(fourth.statusCode).toBe(429);
  });

  it('stop freezes tokens and ranks portfolios at the host prices', async () => {
    const res = await call(hostToken, 'POST', `/api/sessions/${session.id}/stop`);
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    // Alice: 1500 - 200 + 200 = 1500 USDG + 0.01 BTK * 120000 = 2700; Bob: 1500 + 200 + 200 = 1900
    expect(results.map((r: { name: string; totalUsdg: number }) => [r.name, Math.round(r.totalUsdg)])).toEqual([
      ['Алиса', 2700],
      ['Боб', 1900],
    ]);

    await expect(
      chain.publicClient.simulateContract({
        account: bob,
        address: tokenAddr('USDG'),
        abi: tokenAbi,
        functionName: 'transfer',
        args: [alice.address, 1n],
      }),
    ).rejects.toThrow();
    expect((await call(hostToken, 'POST', `/api/sessions/${session.id}/pay`, { to: 'all', token: 'USDG', amount: '1' })).statusCode).toBe(409);
  });
});

describe('public RPC gateway', () => {
  const rpc = (payload: object | object[]) => app.inject({ method: 'POST', url: '/rpc', payload });

  it('blocks node admin methods', async () => {
    const r = (await rpc({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [outsider.address, '0x1'] })).json();
    expect(r.error.code).toBe(-32601);
    const p = (await rpc({ jsonrpc: '2.0', id: 2, method: 'eth_accounts', params: [] })).json();
    expect(p.error.code).toBe(-32601);
  });

  it('serves a wallet: chain id, balances and a raw transaction', async () => {
    const [chainId, block] = (
      await rpc([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      ])
    ).json();
    expect(parseInt(chainId.result, 16)).toBe(cfg.chainId);
    expect(parseInt(block.result, 16)).toBeGreaterThan(0);

    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const viaGateway = createPublicClient({ transport: http(`${base}/rpc`) });
    const wallet = createWalletClient({ chain: makeChain(cfg), transport: http(`${base}/rpc`), account: outsider });
    // outsider has no gas: the node rejects it, and the error comes back through the gateway
    await expect(wallet.sendTransaction({ to: alice.address, value: 1n })).rejects.toThrow();
    expect(await viaGateway.getBalance({ address: outsider.address })).toBe(0n);
  });

  it('caches hot calls: 50 wallets polling the block number cost one upstream call', async () => {
    const before = (app as unknown as { rpcStats: () => { upstreamCalls: number } }).rpcStats().upstreamCalls;
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => rpc({ jsonrpc: '2.0', id: i, method: 'eth_gasPrice', params: [] })),
    );
    const after = (app as unknown as { rpcStats: () => { upstreamCalls: number } }).rpcStats().upstreamCalls;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('rejects unbounded log queries', async () => {
    const r = (await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: 'earliest' }] })).json();
    expect(r.error.code).toBe(-32602);
  });
});
