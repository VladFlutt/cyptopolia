export interface ChainConfig {
  chainId: number;
  chainIdHex: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  siweDomain: string;
  publicUrl: string;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  realWorld: string;
  address: `0x${string}` | null;
  decimals: number;
  price: number;
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

export interface SessionView {
  id: number;
  code: string;
  title: string;
  status: 'creating' | 'active' | 'stopped' | 'failed';
  maxPlayers: number;
  startBalance: number;
  bank: string | null;
  joinUrl: string;
  tokens: TokenInfo[];
  players: { address: string; name: string; joinedAt: number }[];
  results: Standing[] | null;
  createdAt: number;
  stoppedAt: number | null;
}

export interface TransferRow {
  symbol: string;
  from: string;
  to: string;
  value: string;
  amount: string;
  tx: string;
  block: number;
}

export interface SessionDetails extends SessionView {
  standings: Standing[] | null;
  transfers: TransferRow[];
}

export interface SessionListItem {
  id: number;
  code: string;
  title: string;
  status: SessionView['status'];
  players: number;
  maxPlayers: number;
  createdAt: number;
}

export interface PlayerState {
  session: SessionView;
  me: { address: string; name: string };
  balances: Holding[];
  transfers: TransferRow[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data as T;
}

let configPromise: Promise<ChainConfig> | null = null;
export function getConfig(): Promise<ChainConfig> {
  configPromise ??= api<ChainConfig>('/api/config');
  return configPromise;
}

export const ZERO = '0x0000000000000000000000000000000000000000';

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmt(n: number | string, digits = 2): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  const d = Math.abs(v) > 0 && Math.abs(v) < 1 ? 6 : digits;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: d });
}
