import { randomBytes } from 'node:crypto';
import type { Address, PublicClient } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import type { FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import type { Config } from './config.js';

const NONCE_TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 12 * 60 * 60_000;

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Sign-In with Ethereum (EIP-4361): the wallet signs a text message instead of a password.
 * The same login is used by hosts and players.
 */
export function createAuth(db: DB, cfg: Config, publicClient: PublicClient) {
  const host = new URL(cfg.publicUrl).host;

  function issueNonce(): string {
    const nonce = generateSiweNonce();
    db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, Date.now() + NONCE_TTL_MS);
    return nonce;
  }

  async function verify(message: string, signature: `0x${string}`): Promise<{ token: string; address: Address }> {
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce) throw new HttpError(400, 'Некорректное сообщение для входа');
    if (parsed.domain !== host) throw new HttpError(400, 'Сообщение подписано для другого сайта');
    if (parsed.chainId !== cfg.chainId) throw new HttpError(400, 'Неверная сеть в сообщении');

    const row = db.prepare('DELETE FROM auth_nonces WHERE nonce = ? AND expires_at >= ? RETURNING nonce').get(
      parsed.nonce,
      Date.now(),
    );
    if (!row) throw new HttpError(401, 'Код входа устарел, попробуйте ещё раз');

    const ok = await publicClient.verifySiweMessage({ message, signature, domain: host, nonce: parsed.nonce });
    if (!ok) throw new HttpError(401, 'Подпись не подходит');

    const token = randomBytes(32).toString('base64url');
    const address = parsed.address.toLowerCase() as Address;
    db.prepare('INSERT INTO auth_tokens (token, address, expires_at) VALUES (?, ?, ?)').run(
      token,
      address,
      Date.now() + TOKEN_TTL_MS,
    );
    return { token, address };
  }

  function requireUser(req: FastifyRequest): Address {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new HttpError(401, 'Нужно войти через кошелёк');
    const row = db.prepare('SELECT address FROM auth_tokens WHERE token = ? AND expires_at >= ?').get(token, Date.now()) as
      | { address: Address }
      | undefined;
    if (!row) throw new HttpError(401, 'Сессия входа истекла');
    return row.address;
  }

  const isSuperadmin = (a: Address) => cfg.superadmins.includes(a.toLowerCase() as Address);

  return { issueNonce, verify, requireUser, isSuperadmin, siweDomain: host };
}

export type Auth = ReturnType<typeof createAuth>;
