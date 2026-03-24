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

// Backtest runs table — persistent storage for all backtest versions
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    strategy_id TEXT NOT NULL DEFAULT 'atr_dip_buyer',
    created_at TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    capital REAL NOT NULL,
    max_positions INTEGER NOT NULL,
    universe_size INTEGER NOT NULL,
    universe_label TEXT NOT NULL,
    total_trades INTEGER NOT NULL,
    annualized_return_pct REAL NOT NULL,
    total_return_pct REAL NOT NULL,
    win_rate REAL NOT NULL,
    sharpe_ratio REAL NOT NULL,
    max_drawdown_pct REAL NOT NULL,
    data_source TEXT NOT NULL,
    params_json TEXT DEFAULT '{}',
    summary_json TEXT NOT NULL,
    trades_json TEXT NOT NULL,
    snapshots_json TEXT NOT NULL
  );
`);

// Add strategy_id column if missing (migration for existing DBs)
try { sqlite.exec(`ALTER TABLE backtest_runs ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'atr_dip_buyer'`); } catch {}
try { sqlite.exec(`ALTER TABLE backtest_runs ADD COLUMN params_json TEXT DEFAULT '{}'`); } catch {}

// System changelog — audit trail for all actions
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    user_info TEXT
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

// ─── System Log ───

export function logSystem(category: string, action: string, details?: string) {
  const timestamp = new Date().toISOString();
  sqlite.prepare("INSERT INTO system_log (timestamp, category, action, details) VALUES (?, ?, ?, ?)")
    .run(timestamp, category, action, details || null);
}

export function getSystemLogs(limit = 100): any[] {
  return sqlite.prepare("SELECT * FROM system_log ORDER BY id DESC LIMIT ?").all(limit);
}

// Log app startup
logSystem("system", "server_started", `App started at ${new Date().toISOString()}`);
