import { randomInt } from 'node:crypto';
import { formatEther, getAddress, isAddress, parseEther, type Address } from 'viem';
import type { Config } from './config.js';
import type { DB, PlayerRow, SessionRow } from './db.js';
import type { ChainClients } from './chain.js';
import { managerAbi, tokenAbi } from './chain.js';
import { HttpError } from './auth.js';
import { STABLE_INDEX, TOKENS, defaultPrices, tokenIndex } from './tokens.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export interface Holding {
  symbol: string;
  amount: string;
  valueUsdg: number;
}

export interface Standing {
  place: number;
  address: string;
  name: string;
  totalUsdg: number;
  holdings: Holding[];
}

export function createSessions(db: DB, cfg: Config, chain: ChainClients) {
  const manager = (): Address => {
    if (!cfg.managerAddress) throw new Error('SessionManager is not deployed yet');
    return cfg.managerAddress;
  };
  const getRow = (id: number) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  const getByCode = (code: string) =>
    db.prepare('SELECT * FROM sessions WHERE code = ?').get(code.toUpperCase()) as SessionRow | undefined;
  const players = (id: number) =>
    db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY joined_at').all(id) as unknown as PlayerRow[];

  function mustGet(id: number): SessionRow {
    const s = getRow(id);
    if (!s) throw new HttpError(404, 'Партия не найдена');
    return s;
  }

  function assertHost(s: SessionRow, user: Address, superadmin: boolean) {
    if (!superadmin && s.host !== user.toLowerCase()) throw new HttpError(403, 'Это не ваша партия');
  }

  function assertActive(s: SessionRow) {
    if (s.status !== 'active') throw new HttpError(409, 'Партия не активна');
  }

  const tokensOf = (s: SessionRow) => JSON.parse(s.tokens ?? '[]') as Address[];
  const pricesOf = (s: SessionRow) => JSON.parse(s.prices) as Record<string, number>;

  async function create(host: Address, opts: { title?: string; maxPlayers?: number; startBalance?: number }) {
    const maxPlayers = Math.trunc(opts.maxPlayers ?? cfg.maxPlayersLimit);
    const startBalance = Math.trunc(opts.startBalance ?? cfg.defaultStartBalance);
    if (maxPlayers < 2 || maxPlayers > cfg.maxPlayersLimit)
      throw new HttpError(400, `Игроков должно быть от 2 до ${cfg.maxPlayersLimit}`);
    if (startBalance < 1 || startBalance > 1_000_000) throw new HttpError(400, 'Недопустимый стартовый баланс');

    const hostLc = host.toLowerCase();
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE host = ? AND status IN ('creating','active')")
      .get(hostLc) as { n: number };
    if (n >= cfg.maxActiveSessionsPerHost)
      throw new HttpError(429, `Можно вести не больше ${cfg.maxActiveSessionsPerHost} партий одновременно`);

    let code = newCode();
    while (getByCode(code)) code = newCode();
    const title = (opts.title ?? '').trim().slice(0, 60) || `Партия ${code}`;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO sessions (code, host, title, status, max_players, start_balance, prices, created_at)
         VALUES (?, ?, ?, 'creating', ?, ?, ?, ?)`,
      )
      .run(code, hostLc, title, maxPlayers, startBalance, JSON.stringify(defaultPrices()), Date.now());
    const id = Number(lastInsertRowid);
    const bank = chain.bankAccount(id).address;

    try {
      const hash = await chain.operatorWallet.writeContract({
        address: manager(),
        abi: managerAbi,
        functionName: 'createSession',
        args: [
          BigInt(id),
          bank,
          TOKENS.map((t) => t.name),
          TOKENS.map((t) => t.symbol),
          TOKENS.map((t) => parseEther(String(t.bankReserve))),
        ],
      });
      // Gas for the bank goes out in parallel with session creation.
      const [, , tokens] = await Promise.all([
        chain.wait(hash),
        chain.sendNative(bank, cfg.bankGasDrip),
        Promise.all(
          TOKENS.map((_, i) =>
            chain.publicClient.readContract({
              address: manager(),
              abi: managerAbi,
              functionName: 'predictToken',
              args: [BigInt(id), BigInt(i)],
            }),
          ),
        ),
      ]);
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE sessions SET status = 'active', bank = ?, tokens = ? WHERE id = ?").run(
          bank.toLowerCase(),
          JSON.stringify(tokens.map((t) => t.toLowerCase())),
          id,
        );
        const ins = db.prepare('INSERT INTO token_index (token, session_id, symbol) VALUES (?, ?, ?)');
        tokens.forEach((t, i) => ins.run(t.toLowerCase(), id, TOKENS[i]!.symbol));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      db.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").run(id);
      throw e;
    }
    return view(mustGet(id));
  }

  async function join(code: string, player: Address, name: string) {
    const s = getByCode(code);
    if (!s) throw new HttpError(404, 'Партия с таким кодом не найдена');
    assertActive(s);
    const addr = player.toLowerCase();
    const cleanName = name.trim().slice(0, 24);
    if (!cleanName) throw new HttpError(400, 'Укажите имя');
    if (addr === s.host) throw new HttpError(400, 'Ведущий не может быть игроком своей партии');

    const existing = db.prepare('SELECT * FROM players WHERE session_id = ? AND address = ?').get(s.id, addr);
    if (existing) return { session: publicView(s), alreadyJoined: true };

    // Reserve the seat first so parallel joins cannot exceed max_players.
    db.exec('BEGIN IMMEDIATE');
    try {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM players WHERE session_id = ?').get(s.id) as { n: number };
      if (n >= s.max_players) throw new HttpError(409, 'Все места в партии заняты');
      db.prepare('INSERT INTO players (session_id, address, name, joined_at) VALUES (?, ?, ?, ?)').run(
        s.id,
        addr,
        cleanName,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    try {
      const hash = await chain.operatorWallet.writeContract({
        address: manager(),
        abi: managerAbi,
        functionName: 'addPlayers',
        args: [BigInt(s.id), [getAddress(addr)], BigInt(STABLE_INDEX), parseEther(String(s.start_balance))],
      });
      await Promise.all([chain.wait(hash), chain.sendNative(getAddress(addr), cfg.playerGasDrip)]);
    } catch (e) {
      db.prepare('DELETE FROM players WHERE session_id = ? AND address = ?').run(s.id, addr);
      throw e;
    }
    return { session: publicView(s), alreadyJoined: false };
  }

  function parseAmount(amount: unknown): bigint {
    const str = String(amount ?? '').replace(',', '.').trim();
    if (!/^\d+(\.\d{1,18})?$/.test(str)) throw new HttpError(400, 'Некорректная сумма');
    const v = parseEther(str);
    if (v <= 0n) throw new HttpError(400, 'Сумма должна быть больше нуля');
    return v;
  }

  /** Payment from the session bank: salary, card payouts, selling tokens. `to` = address or "all". */
  async function pay(id: number, user: Address, superadmin: boolean, body: { to: string; token: string; amount: unknown }) {
    const s = mustGet(id);
    assertHost(s, user, superadmin);
    assertActive(s);
    const idx = tokenIndex(body.token);
    const value = parseAmount(body.amount);
    const members = players(id).map((p) => p.address);
    const targets =
      body.to === 'all'
        ? members
        : [
            (() => {
              if (!isAddress(body.to)) throw new HttpError(400, 'Некорректный адрес');
              const a = body.to.toLowerCase();
              if (!members.includes(a)) throw new HttpError(400, 'Адрес не участвует в партии');
              return a;
            })(),
          ];
    if (targets.length === 0) throw new HttpError(400, 'В партии пока нет игроков');

    const wallet = chain.bankWallet(id);
    const token = tokensOf(s)[idx]! as Address;
    const hashes: `0x${string}`[] = [];
    for (const to of targets) {
      hashes.push(
        await wallet.writeContract({ address: token, abi: tokenAbi, functionName: 'transfer', args: [getAddress(to), value] }),
      );
    }
    await Promise.all(hashes.map((h) => chain.wait(h)));
    return { txs: hashes };
  }

  async function topUpGas(id: number, user: Address, superadmin: boolean, to: string) {
    const s = mustGet(id);
    assertHost(s, user, superadmin);
    assertActive(s);
    if (!isAddress(to) || !players(id).some((p) => p.address === to.toLowerCase()))
      throw new HttpError(400, 'Адрес не участвует в партии');
    const r = await chain.sendNative(getAddress(to), cfg.playerGasDrip);
    return { tx: r.transactionHash };
  }

  function setPrices(id: number, user: Address, superadmin: boolean, update: Record<string, unknown>) {
    const s = mustGet(id);
    assertHost(s, user, superadmin);
    assertActive(s);
    const prices = pricesOf(s);
    for (const [sym, raw] of Object.entries(update)) {
      tokenIndex(sym);
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Некорректная цена ${sym}`);
      prices[sym.toUpperCase()] = v;
    }
    db.prepare('UPDATE sessions SET prices = ? WHERE id = ?').run(JSON.stringify(prices), id);
    return prices;
  }

  async function balancesOf(s: SessionRow, addresses: string[]) {
    const tokens = tokensOf(s);
    const calls = addresses.flatMap((a) =>
      tokens.map((t) =>
        chain.publicClient.readContract({ address: t, abi: tokenAbi, functionName: 'balanceOf', args: [getAddress(a)] }),
      ),
    );
    const flat = await Promise.all(calls);
    const out: Record<string, Record<string, bigint>> = {};
    addresses.forEach((a, i) => {
      out[a] = Object.fromEntries(TOKENS.map((t, j) => [t.symbol, flat[i * tokens.length + j]!]));
    });
    return out;
  }

  async function standings(s: SessionRow): Promise<Standing[]> {
    const ps = players(s.id);
    const prices = pricesOf(s);
    const bal = await balancesOf(
      s,
      ps.map((p) => p.address),
    );
    const rows = ps.map((p) => {
      const holdings: Holding[] = TOKENS.map((t) => {
        const amount = formatEther(bal[p.address]![t.symbol]!);
        return { symbol: t.symbol, amount, valueUsdg: Number(amount) * (prices[t.symbol] ?? 0) };
      });
      const totalUsdg = holdings.reduce((sum, h) => sum + h.valueUsdg, 0);
      return { address: p.address, name: p.name, totalUsdg, holdings };
    });
    rows.sort((a, b) => b.totalUsdg - a.totalUsdg);
    return rows.map((r, i) => ({ place: i + 1, ...r }));
  }

  async function stop(id: number, user: Address, superadmin: boolean) {
    const s = mustGet(id);
    assertHost(s, user, superadmin);
    assertActive(s);
    await chain.wait(
      await chain.operatorWallet.writeContract({
        address: manager(),
        abi: managerAbi,
        functionName: 'stopSession',
        args: [BigInt(id)],
      }),
    );
    const results = await standings(s);
    db.prepare("UPDATE sessions SET status = 'stopped', results = ?, stopped_at = ? WHERE id = ?").run(
      JSON.stringify(results),
      Date.now(),
      id,
    );
    return { results };
  }

  function transfers(id: number, limit = 100) {
    return db
      .prepare(
        `SELECT symbol, sender AS "from", recipient AS "to", value, tx_hash AS tx, block
         FROM transfers WHERE session_id = ? ORDER BY block DESC, log_index DESC LIMIT ?`,
      )
      .all(id, limit)
      .map((r) => {
        const row = r as { symbol: string; from: string; to: string; value: string; tx: string; block: number };
        return { ...row, amount: formatEther(BigInt(row.value)) };
      });
  }

  function tokenList(s: SessionRow) {
    const addrs = tokensOf(s);
    const prices = pricesOf(s);
    return TOKENS.map((t, i) => ({
      symbol: t.symbol,
      name: t.name,
      realWorld: t.realWorld,
      address: addrs[i] ?? null,
      decimals: 18,
      price: prices[t.symbol] ?? t.price,
    }));
  }

  /** What the host sees. */
  function view(s: SessionRow) {
    return {
      id: s.id,
      code: s.code,
      title: s.title,
      status: s.status,
      maxPlayers: s.max_players,
      startBalance: s.start_balance,
      bank: s.bank,
      joinUrl: `${cfg.publicUrl.replace(/\/$/, '')}/j/${s.code}`,
      tokens: tokenList(s),
      players: players(s.id).map((p) => ({ address: p.address, name: p.name, joinedAt: p.joined_at })),
      results: s.results ? (JSON.parse(s.results) as Standing[]) : null,
      createdAt: s.created_at,
      stoppedAt: s.stopped_at,
    };
  }

  /** What players see. The view has no host address and no results until the stop. */
  const publicView = view;

  async function details(id: number, user: Address, superadmin: boolean) {
    const s = mustGet(id);
    assertHost(s, user, superadmin);
    const live = s.status === 'active' ? await standings(s) : null;
    return { ...view(s), standings: live, transfers: transfers(id) };
  }

  function listFor(user: Address, superadmin: boolean) {
    const rows = (
      superadmin
        ? db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 200').all()
        : db.prepare('SELECT * FROM sessions WHERE host = ? ORDER BY id DESC LIMIT 200').all(user.toLowerCase())
    ) as unknown as SessionRow[];
    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      title: s.title,
      status: s.status,
      players: (db.prepare('SELECT COUNT(*) AS n FROM players WHERE session_id = ?').get(s.id) as { n: number }).n,
      maxPlayers: s.max_players,
      createdAt: s.created_at,
    }));
  }

  function publicByCode(code: string) {
    const s = getByCode(code);
    if (!s) throw new HttpError(404, 'Партия с таким кодом не найдена');
    return publicView(s);
  }

  async function playerState(code: string, player: Address) {
    const s = getByCode(code);
    if (!s) throw new HttpError(404, 'Партия с таким кодом не найдена');
    const addr = player.toLowerCase();
    const me = players(s.id).find((p) => p.address === addr);
    if (!me) throw new HttpError(403, 'Вы не участвуете в этой партии');
    const bal = await balancesOf(s, [addr]);
    const prices = pricesOf(s);
    return {
      session: publicView(s),
      me: { address: addr, name: me.name },
      balances: TOKENS.map((t) => {
        const amount = formatEther(bal[addr]![t.symbol]!);
        return { symbol: t.symbol, amount, valueUsdg: Number(amount) * (prices[t.symbol] ?? 0) };
      }),
      transfers: transfers(s.id, 50).filter((t) => t.from === addr || t.to === addr),
    };
  }

  return { create, join, pay, topUpGas, setPrices, stop, details, listFor, publicByCode, playerState };
}

export type Sessions = ReturnType<typeof createSessions>;
