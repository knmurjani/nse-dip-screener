import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Live Portfolio: Pending Signals (limit orders for tomorrow) ───
export const liveSignals = sqliteTable("live_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // signal date
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  signalClose: real("signal_close").notNull(),
  prevClose: real("prev_close").notNull(),
  dropPct: real("drop_pct").notNull(),
  dma200: real("dma_200").notNull(),
  atr5: real("atr_5").notNull(),
  atrPctClose: real("atr_pct_close").notNull(),
  limitPrice: real("limit_price").notNull(),
  profitTarget: real("profit_target").notNull(),
  setupScore: real("setup_score").notNull(),
  status: text("status").notNull().default("pending"), // pending, filled, expired, skipped
  fillDate: text("fill_date"),
  fillPrice: real("fill_price"),
});

// ─── Live Portfolio: Open Positions ───
export const livePositions = sqliteTable("live_positions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  signalDate: text("signal_date").notNull(),
  entryDate: text("entry_date").notNull(),
  entryPrice: real("entry_price").notNull(),
  shares: integer("shares").notNull(),
  capitalAllocated: real("capital_allocated").notNull(),
  atr5AtEntry: real("atr5_at_entry").notNull(),
  profitTarget: real("profit_target").notNull(),
  setupScore: real("setup_score").notNull(),
  tradingDaysHeld: integer("trading_days_held").notNull().default(0),
  currentPrice: real("current_price"),
  currentValue: real("current_value"),
  unrealizedPnl: real("unrealized_pnl"),
  unrealizedPnlPct: real("unrealized_pnl_pct"),
  lastUpdated: text("last_updated"),
});

// ─── Live Portfolio: Closed Trades ───
export const liveTrades = sqliteTable("live_trades", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  signalDate: text("signal_date").notNull(),
  entryDate: text("entry_date").notNull(),
  entryPrice: real("entry_price").notNull(),
  shares: integer("shares").notNull(),
  capitalAllocated: real("capital_allocated").notNull(),
  exitDate: text("exit_date").notNull(),
  exitPrice: real("exit_price").notNull(),
  exitReason: text("exit_reason").notNull(), // profit_target, price_action_close_above_prev_high, time_exit_10_days
  exitReasonDetail: text("exit_reason_detail").notNull(),
  pnl: real("pnl").notNull(),
  pnlPct: real("pnl_pct").notNull(),
  daysHeld: integer("days_held").notNull(),
  setupScore: real("setup_score").notNull(),
});

// ─── Live Portfolio: Daily Snapshots ───
export const liveSnapshots = sqliteTable("live_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(),
  cash: real("cash").notNull(),
  investedValue: real("invested_value").notNull(),
  unrealizedPnl: real("unrealized_pnl").notNull(),
  realizedPnl: real("realized_pnl").notNull(),
  totalPortfolioValue: real("total_portfolio_value").notNull(),
  portfolioReturnPct: real("portfolio_return_pct").notNull(),
  drawdownPct: real("drawdown_pct").notNull(),
  openPositionCount: integer("open_position_count").notNull(),
  closedTradeCount: integer("closed_trade_count").notNull(),
  signalsGenerated: integer("signals_generated").notNull().default(0),
  niftyClose: real("nifty_close"),
  niftyReturnPct: real("nifty_return_pct"),
});

// ─── Live Portfolio: Config ───
export const liveConfig = sqliteTable("live_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Insert schemas
export const insertLiveSignalSchema = createInsertSchema(liveSignals).omit({ id: true });
export const insertLivePositionSchema = createInsertSchema(livePositions).omit({ id: true });
export const insertLiveTradeSchema = createInsertSchema(liveTrades).omit({ id: true });
export const insertLiveSnapshotSchema = createInsertSchema(liveSnapshots).omit({ id: true });

// Types
export type LiveSignal = typeof liveSignals.$inferSelect;
export type LivePosition = typeof livePositions.$inferSelect;
export type LiveTrade = typeof liveTrades.$inferSelect;
export type LiveSnapshot = typeof liveSnapshots.$inferSelect;

// ─── Screener types (unchanged) ───

export interface ScreenerStock {
  symbol: string; name: string; close: number; prevClose: number; dropPct: number;
  dma200: number; aboveDma200: boolean; atr5: number; atrPctClose: number;
  limitPrice: number; setupScore: number; marketCap: number; profitTarget: number;
  timeExit: string;
}

export interface ScreenerResponse {
  lastUpdated: string; signals: ScreenerStock[];
  universe: UniverseStock[];
  stats: { totalScanned: number; above200dma: number; dippedOver3pct: number; passedVolFilter: number; signalsGenerated: number; };
}

export interface UniverseStock {
  symbol: string; name: string; close: number; dma200: number; aboveDma200: boolean;
  atr5: number; atrPctClose: number; marketCap: number; changePct: number;
}
