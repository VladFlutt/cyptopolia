import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite is enough here: one server, ~100 writes/s at peak, WAL mode.
 * It saves the memory and admin work of a separate PostgreSQL.
 */
export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT NOT NULL UNIQUE,
      host          TEXT NOT NULL,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('creating','active','stopped','failed')),
      max_players   INTEGER NOT NULL,
      start_balance INTEGER NOT NULL,
      bank          TEXT,
      tokens        TEXT,          -- JSON array of token addresses, same order as TOKENS
      prices        TEXT NOT NULL, -- JSON {symbol: price in USDG}
      results       TEXT,          -- JSON ranking after stop
      created_at    INTEGER NOT NULL,
      stopped_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_host ON sessions(host, status);

    CREATE TABLE IF NOT EXISTS players (
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      address    TEXT NOT NULL,
      name       TEXT NOT NULL,
      joined_at  INTEGER NOT NULL,
      PRIMARY KEY (session_id, address)
    );

    CREATE TABLE IF NOT EXISTS token_index (
      token      TEXT PRIMARY KEY,   -- lowercase token address
      session_id INTEGER NOT NULL,
      symbol     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      session_id INTEGER NOT NULL,
      symbol     TEXT NOT NULL,
      sender     TEXT NOT NULL,
      recipient  TEXT NOT NULL,
      value      TEXT NOT NULL,     -- wei, decimal string
      tx_hash    TEXT NOT NULL,
      block      INTEGER NOT NULL,
      log_index  INTEGER NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS transfers_session ON transfers(session_id, block);

    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce      TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token      TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export interface SessionRow {
  id: number;
  code: string;
  host: string;
  title: string;
  status: 'creating' | 'active' | 'stopped' | 'failed';
  max_players: number;
  start_balance: number;
  bank: string | null;
  tokens: string | null;
  prices: string;
  results: string | null;
  created_at: number;
  stopped_at: number | null;
}

export interface PlayerRow {
  session_id: number;
  address: string;
  name: string;
  joined_at: number;
}
