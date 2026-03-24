import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { liveSignals, livePositions, liveTrades, liveSnapshots, liveConfig } from "@shared/schema";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Create tables if they don't exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS live_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    signal_close REAL NOT NULL,
    prev_close REAL NOT NULL,
    drop_pct REAL NOT NULL,
    dma_200 REAL NOT NULL,
    atr_5 REAL NOT NULL,
    atr_pct_close REAL NOT NULL,
    limit_price REAL NOT NULL,
    profit_target REAL NOT NULL,
    setup_score REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    fill_date TEXT,
    fill_price REAL
  );

  CREATE TABLE IF NOT EXISTS live_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    shares INTEGER NOT NULL,
    capital_allocated REAL NOT NULL,
    atr5_at_entry REAL NOT NULL,
    profit_target REAL NOT NULL,
    setup_score REAL NOT NULL,
    trading_days_held INTEGER NOT NULL DEFAULT 0,
    current_price REAL,
    current_value REAL,
    unrealized_pnl REAL,
    unrealized_pnl_pct REAL,
    last_updated TEXT
  );

  CREATE TABLE IF NOT EXISTS live_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_price REAL NOT NULL,
    shares INTEGER NOT NULL,
    capital_allocated REAL NOT NULL,
    exit_date TEXT NOT NULL,
    exit_price REAL NOT NULL,
    exit_reason TEXT NOT NULL,
    exit_reason_detail TEXT NOT NULL,
    pnl REAL NOT NULL,
    pnl_pct REAL NOT NULL,
    days_held INTEGER NOT NULL,
    setup_score REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS live_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    cash REAL NOT NULL,
    invested_value REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    total_portfolio_value REAL NOT NULL,
    portfolio_return_pct REAL NOT NULL,
    drawdown_pct REAL NOT NULL,
    open_position_count INTEGER NOT NULL,
    closed_trade_count INTEGER NOT NULL,
    signals_generated INTEGER NOT NULL DEFAULT 0,
    nifty_close REAL,
    nifty_return_pct REAL
  );

  CREATE TABLE IF NOT EXISTS live_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Initialize config with defaults if not set
const existing = sqlite.prepare("SELECT key FROM live_config WHERE key = 'initial_capital'").get();
if (!existing) {
  sqlite.prepare("INSERT INTO live_config (key, value) VALUES (?, ?)").run("initial_capital", "1000000");
  sqlite.prepare("INSERT INTO live_config (key, value) VALUES (?, ?)").run("max_positions", "10");
  sqlite.prepare("INSERT INTO live_config (key, value) VALUES (?, ?)").run("started_date", new Date().toISOString().split("T")[0]);
  console.log("[DB] Initialized live portfolio: ₹10L capital, 10 max positions");
}

export function getConfig(key: string): string | null {
  const row = sqlite.prepare("SELECT value FROM live_config WHERE key = ?").get(key) as any;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string) {
  sqlite.prepare("INSERT OR REPLACE INTO live_config (key, value) VALUES (?, ?)").run(key, value);
}
