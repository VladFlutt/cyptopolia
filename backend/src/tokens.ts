/**
 * Game tokens. Order matters: the index is the token's index inside SessionManager.
 * Prices are in USDG and roughly follow real market proportions (approximate, set by hand).
 * The host can change prices during a game; these are only the starting values.
 */
export interface TokenDef {
  symbol: string;
  name: string;
  realWorld: string;
  price: number;
  /** Amount minted to the session bank at creation, in whole tokens. */
  bankReserve: number;
}

export const TOKENS: readonly TokenDef[] = [
  { symbol: 'BTK', name: 'Bitkoin', realWorld: 'BTC', price: 100_000, bankReserve: 10 },
  { symbol: 'ETR', name: 'Etherion', realWorld: 'ETH', price: 3_500, bankReserve: 300 },
  { symbol: 'BNC', name: 'BinaCoin', realWorld: 'BNB', price: 900, bankReserve: 1_000 },
  { symbol: 'SLN', name: 'Solanix', realWorld: 'SOL', price: 180, bankReserve: 5_000 },
  { symbol: 'XRL', name: 'Ripplex', realWorld: 'XRP', price: 2.5, bankReserve: 400_000 },
  { symbol: 'MNR', name: 'Monera', realWorld: 'XMR', price: 300, bankReserve: 3_000 },
  { symbol: 'DAX', name: 'Daix', realWorld: 'DAI', price: 1, bankReserve: 1_000_000 },
  { symbol: 'USDG', name: 'Game Dollar', realWorld: 'USDT', price: 1, bankReserve: 1_000_000 },
] as const;

export const STABLE_INDEX = TOKENS.findIndex((t) => t.symbol === 'USDG');

export function tokenIndex(symbol: string): number {
  const i = TOKENS.findIndex((t) => t.symbol === symbol.toUpperCase());
  if (i < 0) throw new Error(`Unknown token ${symbol}`);
  return i;
}

export function defaultPrices(): Record<string, number> {
  return Object.fromEntries(TOKENS.map((t) => [t.symbol, t.price]));
}
