import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Store screened signals
export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  signalDate: text("signal_date").notNull(),
  close: real("close").notNull(),
  prevClose: real("prev_close").notNull(),
  dropPct: real("drop_pct").notNull(),
  dma200: real("dma_200").notNull(),
  atr5: real("atr_5").notNull(),
  atrPctClose: real("atr_pct_close").notNull(),
  limitPrice: real("limit_price").notNull(),
  setupScore: real("setup_score").notNull(),
  marketCap: real("market_cap"),
  profitTarget: real("profit_target"),
  status: text("status").notNull().default("signal"), // signal, active, exited
  entryDate: text("entry_date"),
  entryPrice: real("entry_price"),
  exitDate: text("exit_date"),
  exitPrice: real("exit_price"),
  exitReason: text("exit_reason"),
  daysHeld: integer("days_held"),
});

export const insertSignalSchema = createInsertSchema(signals).omit({ id: true });
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signals.$inferSelect;

// Types for the screener response
export interface ScreenerStock {
  symbol: string;
  name: string;
  close: number;
  prevClose: number;
  dropPct: number;
  dma200: number;
  aboveDma200: boolean;
  atr5: number;
  atrPctClose: number;
  limitPrice: number;
  setupScore: number;
  marketCap: number;
  profitTarget: number;
  timeExit: string; // date string
}

export interface ScreenerResponse {
  lastUpdated: string;
  signals: ScreenerStock[];
  universe: UniverseStock[];
  stats: {
    totalScanned: number;
    above200dma: number;
    dippedOver3pct: number;
    passedVolFilter: number;
    signalsGenerated: number;
  };
}

export interface UniverseStock {
  symbol: string;
  name: string;
  close: number;
  dma200: number;
  aboveDma200: boolean;
  atr5: number;
  atrPctClose: number;
  marketCap: number;
  changePct: number;
}
