import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { liveSignals, livePositions, liveTrades, liveSnapshots, liveConfig } from "@shared/schema";
import path from "path";
import fs from "fs";

// Use Railway volume if available, otherwise write to current directory
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbDir = volumePath || ".";
if (volumePath && !fs.existsSync(volumePath)) {
  fs.mkdirSync(volumePath, { recursive: true });
}
export const DB_PATH = path.join(dbDir, "data.db");
console.log(`[DB] Using database at: ${DB_PATH} (volume: ${volumePath ? 'yes' : 'no'})`);

const sqlite = new Database(DB_PATH);
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

// ─── Changelog ───

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    date TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'system',
    title TEXT NOT NULL,
    changes TEXT NOT NULL
  );
`);

export function addChangelogEntry(version: string, date: string, scope: string, title: string, changes: string[]) {
  const existing = sqlite.prepare("SELECT id FROM changelog WHERE version = ? AND scope = ?").get(version, scope);
  if (existing) return; // don't duplicate
  sqlite.prepare("INSERT INTO changelog (version, date, scope, title, changes) VALUES (?, ?, ?, ?, ?)")
    .run(version, date, scope, title, JSON.stringify(changes));
}

export function getChangelog(scope?: string, limit = 50): any[] {
  if (scope) {
    return sqlite.prepare("SELECT * FROM changelog WHERE scope = ? OR scope = 'system' ORDER BY id DESC LIMIT ?")
      .all(scope, limit)
      .map((r: any) => ({ ...r, changes: JSON.parse(r.changes) }));
  }
  return sqlite.prepare("SELECT * FROM changelog ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r: any) => ({ ...r, changes: JSON.parse(r.changes) }));
}

// ─── Seed changelog with historical releases ───

function seedChangelog() {
  addChangelogEntry("1.0.0", "2026-03-15", "system", "Initial Release", [
    "NSE Dip Screener with Yahoo Finance data",
    "ATR Dip Buyer strategy — 200 DMA + 3% dip + ATR volatility filter",
    "Universe: Nifty 500 (497 stocks)",
    "Signals table with setup scores and limit prices",
  ]);
  addChangelogEntry("1.1.0", "2026-03-16", "system", "Kite Connect Integration", [
    "Live NSE data via Kite Connect API (Zerodha)",
    "Yahoo Finance as automatic fallback when Kite offline",
    "Kite auth flow with redirect-based token exchange",
  ]);
  addChangelogEntry("1.2.0", "2026-03-17", "system", "Backtest Engine", [
    "Full backtest engine for ATR Dip Buyer (1-5 year lookback)",
    "Equity curve vs Nifty 50 benchmark chart",
    "Detailed trade log with entry/exit reasons",
    "Sharpe ratio, max drawdown, win rate, profit factor metrics",
  ]);
  addChangelogEntry("1.3.0", "2026-03-18", "system", "Filter Breakdown + Live Portfolio", [
    "Filter breakdown tab showing daily pass/fail per stock",
    "Expandable workings per stock for each filter step",
    "Live portfolio tracker with SQLite persistence",
    "Paper trading lifecycle engine (signals → positions → trades)",
  ]);
  addChangelogEntry("2.0.0", "2026-03-20", "system", "Multi-Strategy Platform", [
    "Strategy selector: switch between strategies across all tabs",
    "Strategy registry with configurable parameters",
    "Rebranded to Flameback-Perplexity with custom flameback bird logo",
  ]);
  addChangelogEntry("2.0.0", "2026-03-20", "bollinger_bounce", "Bollinger Bounce Strategy Added", [
    "20-DMA ± σ Bollinger Bands signal generation",
    "Watchlist when price below −2σ, buy on cross above",
    "Exit at mean (20-DMA) target or −3σ stop loss",
    "Dedicated screener for Bollinger signals",
    "Full backtest engine with configurable MA period, σ bands",
  ]);
  addChangelogEntry("2.1.0", "2026-03-21", "system", "Strategy-Aware KPIs + System Log", [
    "KPI cards show strategy-specific metrics (Bollinger: below −2σ count, watchlist, crossed above)",
    "System Log tab with audit trail for all actions",
    "Entry/exit rules summary shown on each backtest result and live portfolio",
    "No-duplicate positions: same ticker can't have more than 1 open position",
  ]);
  addChangelogEntry("2.1.0", "2026-03-21", "atr_dip_buyer", "ATR Exit Labels Fix", [
    "Fixed Bollinger exit reason labels showing on ATR trades",
    "Correct labels: Profit Target, Price Action, Time Exit",
  ]);
  addChangelogEntry("2.2.0", "2026-03-22", "system", "Backtest Enhancements", [
    "From/To date pickers replace period dropdown in backtest form",
    "IST timestamp saved on each backtest run",
    "Absolute stop loss % and trailing stop loss % parameters added",
    "Backtest runs persist across deploys (SQLite)",
  ]);
  addChangelogEntry("2.2.0", "2026-03-22", "bollinger_bounce", "Bollinger Backtest Stops", [
    "Absolute stop loss (e.g. −5% from entry) — configurable",
    "Trailing stop loss (e.g. −3% from peak price) — configurable",
    "Both stops work alongside σ-band stop",
  ]);
  addChangelogEntry("2.3.0", "2026-03-23", "system", "Zerodha Self-Service + Kite Recovery", [
    "Zerodha tab with self-service access token paste flow",
    "Kite token expiry detection via markKiteFailed flag",
    "Auto-refresh scheduler at 3:15 PM and 9:15 AM IST",
  ]);
  addChangelogEntry("2.4.0", "2026-03-24", "system", "ATR Stop Losses + Changelog", [
    "ATR Dip Buyer engine now supports absolute + trailing stop losses",
    "Configurable max hold days for ATR strategy (was hardcoded 10)",
    "From/To date pickers now work for both ATR and Bollinger backtests",
    "Changelog system: track all software changes (system-wide + per-strategy)",
    "Per-trade Bollinger Band charts on backtest trades",
  ]);
  addChangelogEntry("2.4.0", "2026-03-24", "atr_dip_buyer", "ATR Stop Loss Support", [
    "Absolute stop loss: e.g. −20% from entry price — exits if low hits stop",
    "Trailing stop loss: e.g. −3% from highest price since entry",
    "Configurable max hold days (was hardcoded to 10)",
    "Both stops integrate with existing profit target + price action exits",
  ]);
  addChangelogEntry("2.5.0", "2026-03-24", "system", "Bollinger Mean Reversion Strategy", [
    "New strategy: Bollinger Mean Reversion (matches original Python backtest)",
    "3 strategies now available: ATR Dip Buyer, Bollinger Bounce, Bollinger MR",
    "Configurable parallel positions (same stock can have multiple open trades)",
  ]);
  addChangelogEntry("2.5.0", "2026-03-24", "bollinger_mr", "Bollinger Mean Reversion Added", [
    "Watchlist: close drops below −2σ band",
    "Entry: close crosses back above the 20-DMA (mean) — confirmed recovery",
    "Entry price: the 20-DMA value (not close price)",
    "Exit target: close > +2σ upper band (full reversion)",
    "Exit stop: close < −2σ lower band (cut loss)",
    "No time exit by default (configurable)",
    "Fixed position sizing: Capital / Max Positions (no compounding)",
    "Allow parallel positions toggle (same ticker multiple open trades)",
    "Per-trade Bollinger Band charts shared with Bollinger Bounce",
  ]);
}
seedChangelog();

// ─── Deployment System Tables ───

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'paper',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    initial_capital REAL NOT NULL,
    current_capital REAL NOT NULL,
    max_positions INTEGER NOT NULL DEFAULT 10,
    max_hold_days INTEGER NOT NULL DEFAULT 0,
    absolute_stop_pct REAL,
    trailing_stop_pct REAL,
    ma_period INTEGER DEFAULT 20,
    entry_band_sigma REAL DEFAULT 2,
    target_band_sigma REAL DEFAULT 2,
    stop_loss_sigma REAL DEFAULT 2,
    allow_parallel INTEGER DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    realized_pnl REAL DEFAULT 0,
    unrealized_pnl REAL DEFAULT 0,
    max_drawdown_pct REAL DEFAULT 0,
    last_run_date TEXT
  );

  CREATE TABLE IF NOT EXISTS deployment_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'LONG',
    signal_date TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time TEXT NOT NULL,
    entry_price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    entry_value REAL NOT NULL,
    current_price REAL,
    current_value REAL,
    pnl REAL,
    pnl_pct REAL,
    trading_days_held INTEGER DEFAULT 0,
    peak_price REAL,
    setup_score REAL,
    last_updated TEXT,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );

  CREATE TABLE IF NOT EXISTS deployment_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'LONG',
    signal_date TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time TEXT NOT NULL,
    entry_price REAL NOT NULL,
    quantity INTEGER NOT NULL,
    entry_value REAL NOT NULL,
    exit_date TEXT NOT NULL,
    exit_time TEXT NOT NULL,
    exit_price REAL NOT NULL,
    exit_value REAL NOT NULL,
    pnl REAL NOT NULL,
    pnl_pct REAL NOT NULL,
    days_held INTEGER NOT NULL,
    exit_reason TEXT NOT NULL,
    exit_reason_detail TEXT,
    setup_score REAL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );

  CREATE TABLE IF NOT EXISTS deployment_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    portfolio_value REAL NOT NULL,
    cash REAL NOT NULL,
    invested_value REAL NOT NULL,
    unrealized_pnl REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    return_pct REAL NOT NULL,
    drawdown_pct REAL NOT NULL,
    nifty_close REAL,
    nifty_return_pct REAL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );

  CREATE TABLE IF NOT EXISTS fund_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    note TEXT,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );

  CREATE TABLE IF NOT EXISTS deployment_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    note TEXT,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );
`);

// ─── Orders Log Table ───

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS orders_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    exchange TEXT DEFAULT 'NSE',
    order_type TEXT NOT NULL,
    transaction_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL,
    status TEXT NOT NULL,
    kite_order_id TEXT,
    fill_price REAL,
    fill_quantity INTEGER,
    strategy TEXT NOT NULL,
    signal_data TEXT,
    error_message TEXT,
    placed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );
`);

// ─── IST Helper ───

export function istNow(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().replace("T", " ").split(".")[0] + " IST";
}

// ─── Deployment Helpers ───

export function getDeployments(): any[] {
  return sqlite.prepare("SELECT * FROM deployments ORDER BY id DESC").all();
}

export function getDeployment(id: number): any {
  return sqlite.prepare("SELECT * FROM deployments WHERE id = ?").get(id);
}

export function getActiveDeployments(): any[] {
  return sqlite.prepare("SELECT * FROM deployments WHERE status = 'active' ORDER BY id DESC").all();
}

export function getDeploymentPositions(deploymentId: number): any[] {
  return sqlite.prepare("SELECT * FROM deployment_positions WHERE deployment_id = ? ORDER BY entry_date DESC").all(deploymentId);
}

export function getDeploymentTrades(deploymentId: number): any[] {
  return sqlite.prepare("SELECT * FROM deployment_trades WHERE deployment_id = ? ORDER BY exit_date DESC").all(deploymentId);
}

export function getDeploymentSnapshots(deploymentId: number): any[] {
  return sqlite.prepare("SELECT * FROM deployment_snapshots WHERE deployment_id = ? ORDER BY date ASC").all(deploymentId);
}

export function getFundTransactions(deploymentId: number): any[] {
  return sqlite.prepare("SELECT * FROM fund_transactions WHERE deployment_id = ? ORDER BY id DESC").all(deploymentId);
}

export function getDeploymentChangelog(deploymentId: number): any[] {
  return sqlite.prepare("SELECT * FROM deployment_changelog WHERE deployment_id = ? ORDER BY id DESC").all(deploymentId);
}

// ─── Orders Log Helpers ───

export function getOrdersLog(deploymentId: number, filters?: { status?: string; symbol?: string; limit?: number; offset?: number }): any[] {
  let query = "SELECT * FROM orders_log WHERE deployment_id = ?";
  const params: any[] = [deploymentId];

  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.symbol) {
    query += " AND symbol = ?";
    params.push(filters.symbol);
  }
  query += " ORDER BY id DESC";
  if (filters?.limit) {
    query += " LIMIT ?";
    params.push(filters.limit);
    if (filters?.offset) {
      query += " OFFSET ?";
      params.push(filters.offset);
    }
  }
  return sqlite.prepare(query).all(...params);
}

export function insertOrder(order: {
  deployment_id: number;
  symbol: string;
  exchange?: string;
  order_type: string;
  transaction_type: string;
  quantity: number;
  price?: number;
  status: string;
  kite_order_id?: string;
  fill_price?: number;
  fill_quantity?: number;
  strategy: string;
  signal_data?: string;
  error_message?: string;
}): number {
  const now = istNow();
  const result = sqlite.prepare(`
    INSERT INTO orders_log (deployment_id, symbol, exchange, order_type, transaction_type, quantity, price, status, kite_order_id, fill_price, fill_quantity, strategy, signal_data, error_message, placed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.deployment_id, order.symbol, order.exchange || "NSE",
    order.order_type, order.transaction_type, order.quantity,
    order.price ?? null, order.status,
    order.kite_order_id ?? null, order.fill_price ?? null,
    order.fill_quantity ?? null, order.strategy,
    order.signal_data ?? null, order.error_message ?? null,
    now, now
  );
  return Number(result.lastInsertRowid);
}

export function updateOrderStatus(orderId: number, updates: {
  status: string;
  fill_price?: number;
  fill_quantity?: number;
  kite_order_id?: string;
  error_message?: string;
}): void {
  const now = istNow();
  const setClauses = ["status = ?", "updated_at = ?"];
  const params: any[] = [updates.status, now];

  if (updates.fill_price !== undefined) {
    setClauses.push("fill_price = ?");
    params.push(updates.fill_price);
  }
  if (updates.fill_quantity !== undefined) {
    setClauses.push("fill_quantity = ?");
    params.push(updates.fill_quantity);
  }
  if (updates.kite_order_id !== undefined) {
    setClauses.push("kite_order_id = ?");
    params.push(updates.kite_order_id);
  }
  if (updates.error_message !== undefined) {
    setClauses.push("error_message = ?");
    params.push(updates.error_message);
  }

  params.push(orderId);
  sqlite.prepare(`UPDATE orders_log SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
}

export function getOrder(orderId: number): any {
  return sqlite.prepare("SELECT * FROM orders_log WHERE id = ?").get(orderId);
}

export function getOrderByKiteId(kiteOrderId: string): any {
  return sqlite.prepare("SELECT * FROM orders_log WHERE kite_order_id = ? ORDER BY id DESC LIMIT 1").get(kiteOrderId);
}

// Log app startup
logSystem("system", "server_started", `App started at ${new Date().toISOString()}`);
