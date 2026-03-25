/**
 * Bollinger Mean Reversion Backtest Engine
 * ─────────────────────────────────────────
 * Matches the original Python strategy exactly:
 *   Watchlist: close < −2σ
 *   Entry:    close crosses above 20-DMA (mean) → buy at the 20-DMA price
 *   Exit:     close > +2σ (target) OR close < −2σ (stop loss)
 *   Sizing:   fixed (capital / maxPositions), no compounding
 *   Parallel: configurable — same ticker CAN have multiple open positions
 */

import { getKite, isAuthenticated } from "./kite";
import { NSE_UNIVERSE } from "./nse-universe";
import type { BacktestResult, BacktestSummary, Trade, DailySnapshot } from "./backtest";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

export type { BacktestResult, Trade, DailySnapshot };

// ─── Data fetching ───
let instrumentMap: Map<string, number> = new Map();

async function loadKiteInstruments() {
  if (instrumentMap.size > 0) return;
  try {
    const kite = getKite();
    const instruments = await kite.getInstruments("NSE");
    for (const inst of instruments)
      if (inst.segment === "NSE" && inst.instrument_type === "EQ")
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
  } catch {}
}

async function fetchBars(symbol: string, from: string, to: string): Promise<Bar[] | null> {
  if (isAuthenticated()) {
    try {
      await loadKiteInstruments();
      const clean = symbol.replace(".NS", "");
      const token = instrumentMap.get(clean);
      if (token) {
        const data = await getKite().getHistoricalData(token, "day", from, to);
        if (data && data.length > 0)
          return data.filter((d: any) => d.close > 0).map((d: any) => ({
            date: new Date(d.date).toISOString().split("T")[0],
            open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
          }));
      }
    } catch {}
  }
  try {
    const result = await yahooFinance.chart(symbol, { period1: new Date(from), period2: new Date(to), interval: "1d" });
    if (!result?.quotes) return null;
    return result.quotes.filter((q: any) => q.close && q.close > 0)
      .map((q: any) => ({ date: new Date(q.date).toISOString().split("T")[0], open: q.open ?? q.close, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close, volume: q.volume ?? 0 }));
  } catch { return null; }
}

// ─── Indicators ───
function computeSMA(bars: Bar[], idx: number, period: number): number {
  if (idx < period - 1) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += bars[i].close;
  return sum / period;
}

function computeStdDev(bars: Bar[], idx: number, period: number): number {
  if (idx < period - 1) return 0;
  const mean = computeSMA(bars, idx, period);
  let sumSq = 0;
  for (let i = idx - period + 1; i <= idx; i++) sumSq += (bars[i].close - mean) ** 2;
  return Math.sqrt(sumSq / period);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  const xS = x.slice(0, n), yS = y.slice(0, n);
  const xM = xS.reduce((s, v) => s + v, 0) / n, yM = yS.reduce((s, v) => s + v, 0) / n;
  let num = 0, dX = 0, dY = 0;
  for (let i = 0; i < n; i++) { const dx = xS[i] - xM, dy = yS[i] - yM; num += dx * dy; dX += dx * dx; dY += dy * dy; }
  return dX > 0 && dY > 0 ? num / Math.sqrt(dX * dY) : 0;
}

// ─── Backtest Engine ───

export interface BollingerMRParams {
  capitalRs?: number;
  maxPositions?: number;
  lookbackYears?: number;
  fromDate?: string;
  toDate?: string;
  maPeriod?: number;           // default 20
  // Configurable conditions (dropdown-driven)
  watchlistCondition?: string; // "below_-2s" | "below_-1s" | "below_-3s" | "below_mean" (default: below_-2s)
  entryCondition?: string;     // "cross_above_mean" | "cross_above_-2s" | "cross_above_-1s" | "cross_above_+1s" (default: cross_above_mean)
  exitTarget?: string;         // "reach_+2s" | "reach_+1s" | "reach_+3s" | "reach_mean" (default: reach_+2s)
  exitStopBand?: string;       // "below_-2s" | "below_-3s" | "below_-4s" (default: below_-2s)
  // Legacy numeric params (used as fallback)
  entryBandSigma?: number;     // default 2 (watchlist below this)
  targetBandSigma?: number;    // default 2 (exit above +Nσ)
  stopLossSigma?: number;      // default 2 (exit below −Nσ)
  maxHoldDays?: number;        // default 0 = no time exit
  allowParallelPositions?: boolean;
  absoluteStopPct?: number;
  trailingStopPct?: number;
}

interface OpenPosition {
  id: number; symbol: string; name: string; signalDate: string; entryDate: string;
  entryPrice: number; shares: number; capitalAllocated: number;
  setupScore: number; ma20AtEntry: number; stdDevAtEntry: number;
  tradingDaysHeld: number; peakPrice: number;
  portfolioValueAtEntry: number;
}

// Parse condition strings to sigma multipliers
function parseWatchlistSigma(cond?: string, fallback?: number): { sigma: number; useMean: boolean } {
  if (!cond) return { sigma: fallback || 2, useMean: false };
  if (cond === "below_mean") return { sigma: 0, useMean: true };
  const m = cond.match(/below_(-?\d+)s/);
  return m ? { sigma: parseInt(m[1]), useMean: false } : { sigma: fallback || 2, useMean: false };
}

function parseEntrySigma(cond?: string): { sigma: number; useMean: boolean } {
  if (!cond) return { sigma: 0, useMean: true }; // default: cross above mean
  if (cond === "cross_above_mean") return { sigma: 0, useMean: true };
  const m = cond.match(/cross_above_([+-]?\d+)s/);
  return m ? { sigma: parseInt(m[1]), useMean: false } : { sigma: 0, useMean: true };
}

function parseExitTarget(cond?: string, fallback?: number): { sigma: number; useMean: boolean } {
  if (!cond) return { sigma: fallback || 2, useMean: false };
  if (cond === "reach_mean") return { sigma: 0, useMean: true };
  const m = cond.match(/reach_([+-]?\d+)s/);
  return m ? { sigma: parseInt(m[1]), useMean: false } : { sigma: fallback || 2, useMean: false };
}

function parseExitStop(cond?: string, fallback?: number): number {
  if (!cond) return fallback || 2;
  const m = cond.match(/below_(-?\d+)s/);
  return m ? Math.abs(parseInt(m[1])) : fallback || 2;
}

export async function runBollingerMRBacktest(params: BollingerMRParams): Promise<BacktestResult> {
  const CAPITAL = params.capitalRs || 1000000;
  const MAX_POS = params.maxPositions || 10;
  const MA_PERIOD = params.maPeriod || 20;

  // Parse configurable conditions
  const watchlistCfg = parseWatchlistSigma(params.watchlistCondition, params.entryBandSigma);
  const entryCfg = parseEntrySigma(params.entryCondition);
  const exitTargetCfg = parseExitTarget(params.exitTarget, params.targetBandSigma);
  const EXIT_STOP_SIGMA = parseExitStop(params.exitStopBand, params.stopLossSigma);

  // Legacy fallbacks
  const ENTRY_SIGMA = params.entryBandSigma || 2;
  const TARGET_SIGMA = params.targetBandSigma || 2;
  const STOP_SIGMA = params.stopLossSigma || 2;
  const MAX_HOLD = params.maxHoldDays || 0; // 0 = no time exit
  const ALLOW_PARALLEL = params.allowParallelPositions || false;
  const ABS_STOP = params.absoluteStopPct;
  const TRAIL_STOP = params.trailingStopPct;

  // Fixed position size (no compounding — matches Python)
  const POSITION_SIZE = Math.floor(CAPITAL / MAX_POS);

  // Determine backtest period
  let toDate: Date;
  let backtestStart: Date;
  if (params.fromDate && params.toDate) {
    backtestStart = new Date(params.fromDate);
    toDate = new Date(params.toDate);
  } else {
    const YEARS = params.lookbackYears || 5;
    toDate = new Date();
    backtestStart = new Date();
    backtestStart.setFullYear(backtestStart.getFullYear() - YEARS);
  }

  const fromDate = new Date(backtestStart);
  fromDate.setDate(fromDate.getDate() - 120);
  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];
  const startStr = backtestStart.toISOString().split("T")[0];

  const yearsLabel = ((toDate.getTime() - backtestStart.getTime()) / (365.25 * 86400000)).toFixed(1);
  const useKite = isAuthenticated();
  console.log(`[BollMR-BT] ${yearsLabel}yr (${startStr} → ${to}), ₹${(CAPITAL/1e5).toFixed(0)}L, ${MAX_POS} pos, ${MA_PERIOD}MA, entry/stop ±${ENTRY_SIGMA}σ, target +${TARGET_SIGMA}σ, parallel=${ALLOW_PARALLEL}`);

  // Fetch Nifty 50
  const niftyBars = await fetchBars("^NSEI", from, to) || [];
  const niftyByDate: Map<string, number> = new Map();
  for (const b of niftyBars) niftyByDate.set(b.date, b.close);

  // Fetch all stocks
  const allBars: Map<string, Bar[]> = new Map();
  const batchSize = useKite ? 8 : 5;
  for (let i = 0; i < NSE_UNIVERSE.length; i += batchSize) {
    const batch = NSE_UNIVERSE.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (stock) => {
      const bars = await fetchBars(stock.symbol, from, to);
      if (bars && bars.length >= MA_PERIOD + 5) allBars.set(stock.symbol, bars);
    }));
    if (i + batchSize < NSE_UNIVERSE.length) await new Promise(r => setTimeout(r, useKite ? 80 : 120));
    if ((i + batchSize) % 100 === 0) console.log(`[BollMR-BT] ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length}...`);
  }
  console.log(`[BollMR-BT] Data for ${allBars.size} stocks. Simulating...`);

  // Date index
  const allDates = new Set<string>();
  for (const bars of allBars.values()) for (const b of bars) if (b.date >= startStr) allDates.add(b.date);
  const sortedDates = Array.from(allDates).sort();

  const barIndex: Map<string, Map<string, number>> = new Map();
  for (const [symbol, bars] of allBars.entries()) {
    const idx = new Map<string, number>();
    bars.forEach((b, i) => idx.set(b.date, i));
    barIndex.set(symbol, idx);
  }

  // Simulation
  let cash = CAPITAL;
  let realizedPnl = 0;
  let tradeId = 0;
  const trades: Trade[] = [];
  const openPositions: OpenPosition[] = [];
  const dailySnapshots: DailySnapshot[] = [];
  let peakValue = CAPITAL;
  const niftyStart = niftyByDate.get(sortedDates[0]) || 0;

  // Watchlist state: tracks which symbols were below −2σ (Python: ongoing_trades[symbol] = {'waitlist': True})
  const watchlist: Set<string> = new Set();

  for (let d = 0; d < sortedDates.length; d++) {
    const today = sortedDates[d];

    const getCurrentValue = (): number => {
      let inv = 0;
      for (const pos of openPositions) {
        const bars = allBars.get(pos.symbol);
        const idxMap = barIndex.get(pos.symbol);
        if (!bars || !idxMap) continue;
        const tIdx = idxMap.get(today);
        if (tIdx === undefined) { inv += pos.capitalAllocated; continue; }
        inv += bars[tIdx].close * pos.shares;
      }
      return cash + inv;
    };

    // ─── Check exits ───
    const toClose: number[] = [];
    for (let p = 0; p < openPositions.length; p++) {
      const pos = openPositions[p];
      const bars = allBars.get(pos.symbol);
      const idxMap = barIndex.get(pos.symbol);
      if (!bars || !idxMap) continue;
      const tIdx = idxMap.get(today);
      if (tIdx === undefined) continue;

      const bar = bars[tIdx];
      pos.tradingDaysHeld++;
      pos.peakPrice = Math.max(pos.peakPrice, bar.high);

      const ma = computeSMA(bars, tIdx, MA_PERIOD);
      const std = computeStdDev(bars, tIdx, MA_PERIOD);

      let exitPrice = 0;
      let exitReason: Trade["exitReason"] | null = null;
      let exitDetail = "";

      // Exit 1: Profit target (configurable: mean, +1σ, +2σ, +3σ)
      const targetLevel = exitTargetCfg.useMean ? ma : (ma + exitTargetCfg.sigma * std);
      const targetLabel = exitTargetCfg.useMean ? "Mean" : `+${exitTargetCfg.sigma}σ`;
      if (bar.close > targetLevel) {
        exitPrice = targetLevel;
        exitReason = "profit_target";
        exitDetail = `✅ ${targetLabel} TARGET: Close ₹${bar.close.toFixed(2)} > ${targetLabel} ₹${targetLevel.toFixed(2)}`;
      }

      // Exit 2: Band stop loss (configurable: -2σ, -3σ, -4σ)
      if (!exitReason) {
        const stopLevel = ma - EXIT_STOP_SIGMA * std;
        if (bar.close < stopLevel) {
          exitPrice = stopLevel;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `🛑 −${EXIT_STOP_SIGMA}σ STOP: Close ₹${bar.close.toFixed(2)} < −${EXIT_STOP_SIGMA}σ ₹${stopLevel.toFixed(2)}`;
        }
      }
      const upperBand = exitTargetCfg.useMean ? ma : (ma + exitTargetCfg.sigma * std);

      // Exit 3: Absolute stop (if configured)
      if (!exitReason && ABS_STOP) {
        const absStopPrice = pos.entryPrice * (1 - ABS_STOP / 100);
        if (bar.low <= absStopPrice) {
          exitPrice = absStopPrice;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `🛑 ABS STOP: Low ₹${bar.low.toFixed(2)} ≤ −${ABS_STOP}% from entry = ₹${absStopPrice.toFixed(2)}`;
        }
      }

      // Exit 4: Trailing stop (if configured)
      if (!exitReason && TRAIL_STOP) {
        const trailStopPrice = pos.peakPrice * (1 - TRAIL_STOP / 100);
        if (bar.low <= trailStopPrice) {
          exitPrice = trailStopPrice;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `🛑 TRAIL STOP: Low ₹${bar.low.toFixed(2)} ≤ −${TRAIL_STOP}% from peak ₹${pos.peakPrice.toFixed(2)} = ₹${trailStopPrice.toFixed(2)}`;
        }
      }

      // Exit 5: Time exit (only if maxHoldDays > 0)
      if (!exitReason && MAX_HOLD > 0 && pos.tradingDaysHeld >= MAX_HOLD) {
        exitPrice = bar.close;
        exitReason = "time_exit_10_days";
        exitDetail = `⏰ TIME EXIT: Held ${pos.tradingDaysHeld} days ≥ ${MAX_HOLD} day limit — exit at close ₹${bar.close.toFixed(2)}`;
      }

      if (exitReason) {
        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        realizedPnl += pnl;
        cash += pos.shares * exitPrice;

        trades.push({
          id: ++tradeId, symbol: pos.symbol.replace(".NS", ""), name: pos.name,
          signalDate: pos.signalDate, entryDate: pos.entryDate,
          entryTime: `${pos.entryDate} 09:20:00 IST`,
          entryPrice: Math.round(pos.entryPrice * 100) / 100,
          shares: pos.shares, capitalAllocated: Math.round(pos.capitalAllocated),
          exitDate: today,
          exitTime: exitReason === "profit_target" ? `${today} (intraday)` : `${today} 15:30:00 IST`,
          exitPrice: Math.round(exitPrice * 100) / 100,
          exitReason, exitReasonDetail: exitDetail,
          pnl: Math.round(pnl), pnlPct: Math.round(((exitPrice - pos.entryPrice) / pos.entryPrice) * 10000) / 100,
          daysHeld: pos.tradingDaysHeld, setupScore: pos.setupScore,
          atr5AtEntry: 0, profitTargetPrice: Math.round(upperBand * 100) / 100,
          portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry),
          portfolioValueAtExit: Math.round(getCurrentValue()),
        });
        toClose.push(p);

        // Remove from watchlist on exit so it can re-enter the cycle
        watchlist.delete(pos.symbol);
      }
    }
    for (const idx of toClose.reverse()) openPositions.splice(idx, 1);

    // ─── Check for new entries ───
    // Two-phase: (1) add to watchlist when close < watchlist band, (2) enter when close crosses above entry band
    // The crossover must be real: stock was below the entry threshold yesterday, and above it today
    for (const [symbol, bars] of allBars.entries()) {
      const idxMap = barIndex.get(symbol);
      if (!idxMap) continue;
      const tIdx = idxMap.get(today);
      if (tIdx === undefined || tIdx < MA_PERIOD + 1) continue;

      const bar = bars[tIdx];
      const prevBar = bars[tIdx - 1];
      const ma = computeSMA(bars, tIdx, MA_PERIOD);
      const std = computeStdDev(bars, tIdx, MA_PERIOD);
      if (ma === 0 || std === 0) continue;

      const prevMa = computeSMA(bars, tIdx - 1, MA_PERIOD);
      const prevStd = computeStdDev(bars, tIdx - 1, MA_PERIOD);

      // Watchlist threshold: configurable (below -Nσ or below mean)
      const watchlistThreshold = watchlistCfg.useMean ? ma : (ma - watchlistCfg.sigma * std);
      // Entry threshold: configurable (cross above mean or cross above ±Nσ)
      const entryThreshold = entryCfg.useMean ? ma : (ma + entryCfg.sigma * std);
      const prevEntryThreshold = entryCfg.useMean ? prevMa : (prevMa + entryCfg.sigma * prevStd);

      // Phase 1: Add to watchlist if close < watchlist threshold
      if (bar.close < watchlistThreshold) {
        if (!watchlist.has(symbol)) {
          if (!ALLOW_PARALLEL && openPositions.some(p => p.symbol === symbol)) continue;
          watchlist.add(symbol);
        }
        continue; // Still below watchlist band — don't check entry yet
      }

      // Phase 2: Entry — must be on watchlist AND a genuine crossover happened
      // Crossover = was below entry threshold yesterday, above it today
      if (watchlist.has(symbol) && openPositions.length < MAX_POS) {
        const wasBelowYesterday = prevBar.close < prevEntryThreshold;
        const isAboveToday = bar.close > entryThreshold;

        if (wasBelowYesterday && isAboveToday) {
          if (!ALLOW_PARALLEL && openPositions.some(p => p.symbol === symbol)) continue;

          // Entry price = the CLOSE price (actual market price, not the band level)
          const entryPrice = bar.close;
          const shares = Math.floor(POSITION_SIZE / entryPrice);
          if (shares <= 0 || cash < shares * entryPrice) continue;

          cash -= shares * entryPrice;
          const targetLevel = exitTargetCfg.useMean ? ma : (ma + exitTargetCfg.sigma * std);
          const distToTarget = ((targetLevel - entryPrice) / entryPrice) * 100;

          openPositions.push({
            id: ++tradeId, symbol, name: NSE_UNIVERSE.find(s => s.symbol === symbol)?.name || symbol.replace(".NS", ""),
            signalDate: today, entryDate: today,
            entryPrice, shares, capitalAllocated: shares * entryPrice,
            setupScore: Math.round(distToTarget * 100) / 100,
            ma20AtEntry: ma, stdDevAtEntry: std,
            tradingDaysHeld: 0, peakPrice: bar.close,
            portfolioValueAtEntry: getCurrentValue(),
          });

          watchlist.delete(symbol);
        } else if (isAboveToday) {
          // Price is above entry threshold but no crossover happened (was already above yesterday)
          // Remove from watchlist — the dip opportunity has passed without a clean crossover
          watchlist.delete(symbol);
        }
        // If still below entry threshold, keep on watchlist and wait
      }
    }

    // ─── Snapshot ───
    let investedValue = 0, unrealizedPnl = 0;
    for (const pos of openPositions) {
      const bars = allBars.get(pos.symbol);
      const idxMap = barIndex.get(pos.symbol);
      if (!bars || !idxMap) continue;
      const tIdx = idxMap.get(today);
      if (tIdx === undefined) continue;
      investedValue += bars[tIdx].close * pos.shares;
      unrealizedPnl += (bars[tIdx].close - pos.entryPrice) * pos.shares;
    }
    const pv = cash + investedValue;
    peakValue = Math.max(peakValue, pv);
    const dd = ((peakValue - pv) / peakValue) * 100;
    const niftyClose = niftyByDate.get(today) || 0;
    const niftyPct = niftyStart > 0 ? ((niftyClose - niftyStart) / niftyStart) * 100 : 0;

    dailySnapshots.push({
      date: today, portfolioValue: Math.round(pv), cash: Math.round(cash),
      investedValue: Math.round(investedValue), unrealizedPnl: Math.round(unrealizedPnl),
      realizedPnl: Math.round(realizedPnl), openPositions: openPositions.length,
      equityPct: Math.round(((pv - CAPITAL) / CAPITAL) * 10000) / 100,
      drawdownPct: Math.round(dd * 100) / 100,
      niftyClose: Math.round(niftyClose * 100) / 100,
      niftyPct: Math.round(niftyPct * 100) / 100,
    });
  }

  // Force close remaining
  for (const pos of [...openPositions]) {
    const bars = allBars.get(pos.symbol);
    if (!bars) continue;
    const lastBar = bars[bars.length - 1];
    const pnl = (lastBar.close - pos.entryPrice) * pos.shares;
    realizedPnl += pnl;
    cash += pos.shares * lastBar.close;
    trades.push({
      id: ++tradeId, symbol: pos.symbol.replace(".NS", ""), name: pos.name,
      signalDate: pos.signalDate, entryDate: pos.entryDate,
      entryTime: `${pos.entryDate} 09:20:00 IST`,
      entryPrice: Math.round(pos.entryPrice * 100) / 100,
      shares: pos.shares, capitalAllocated: Math.round(pos.capitalAllocated),
      exitDate: sortedDates[sortedDates.length - 1],
      exitTime: `${sortedDates[sortedDates.length - 1]} 15:30:00 IST`,
      exitPrice: Math.round(lastBar.close * 100) / 100,
      exitReason: "time_exit_10_days", exitReasonDetail: "Backtest ended — force closed",
      pnl: Math.round(pnl), pnlPct: Math.round(((lastBar.close - pos.entryPrice) / pos.entryPrice) * 10000) / 100,
      daysHeld: pos.analyzed || pos.tradingDaysHeld, setupScore: pos.setupScore,
      atr5AtEntry: 0, profitTargetPrice: 0,
      portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry), portfolioValueAtExit: Math.round(cash),
    } as any);
  }

  // Summary
  const finalValue = cash;
  const totalReturn = finalValue - CAPITAL;
  const yearsActual = sortedDates.length / 252;
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const avgWinPct = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length > 0 ? Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length) : 0;
  const highestWin = winners.reduce((b, t) => !b || t.pnlPct > b.pnlPct ? t : b, null as Trade | null);
  const highestLoss = losers.reduce((b, t) => !b || t.pnlPct < b.pnlPct ? t : b, null as Trade | null);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  const dailyReturns = [];
  for (let i = 1; i < dailySnapshots.length; i++)
    dailyReturns.push((dailySnapshots[i].portfolioValue - dailySnapshots[i-1].portfolioValue) / dailySnapshots[i-1].portfolioValue);
  const avgR = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdR = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgR) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0;

  const maxDDEntry = dailySnapshots.reduce((w, s) => s.drawdownPct > w.drawdownPct ? s : w, { drawdownPct: 0, date: "" });
  let maxConsW = 0, maxConsL = 0, cW = 0, cL = 0;
  for (const t of trades) { if (t.pnl > 0) { cW++; cL = 0; maxConsW = Math.max(maxConsW, cW); } else { cL++; cW = 0; maxConsL = Math.max(maxConsL, cL); } }

  const niftyReturns = dailySnapshots.slice(1).map((s, i) => {
    const prev = dailySnapshots[i].niftyClose;
    return prev > 0 ? (s.niftyClose - prev) / prev : 0;
  });
  const correlation = pearsonCorrelation(dailyReturns, niftyReturns);

  const summary: BacktestSummary = {
    initialCapital: CAPITAL, finalPortfolioValue: Math.round(finalValue),
    totalReturn: Math.round(totalReturn),
    totalReturnPct: Math.round((totalReturn / CAPITAL) * 10000) / 100,
    annualizedReturnPct: yearsActual > 0 ? Math.round((Math.pow(finalValue / CAPITAL, 1 / yearsActual) - 1) * 10000) / 100 : 0,
    totalTrades: trades.length, winningTrades: winners.length, losingTrades: losers.length,
    winningPct: trades.length > 0 ? Math.round((winners.length / trades.length) * 10000) / 100 : 0,
    highestWinPct: highestWin ? Math.round(highestWin.pnlPct * 100) / 100 : 0,
    highestWinSymbol: highestWin?.symbol || "—",
    highestLossPct: highestLoss ? Math.round(highestLoss.pnlPct * 100) / 100 : 0,
    highestLossSymbol: highestLoss?.symbol || "—",
    avgWinPct: Math.round(avgWinPct * 100) / 100, avgLossPct: Math.round(avgLossPct * 100) / 100,
    avgWinToLossRatio: avgLossPct > 0 ? Math.round((avgWinPct / avgLossPct) * 100) / 100 : 999,
    avgTradeDurationDays: trades.length > 0 ? Math.round((trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length) * 10) / 10 : 0,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDDEntry.drawdownPct * 100) / 100,
    maxDrawdownDate: maxDDEntry.date || "",
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 999 : 0,
    maxConsecutiveWins: maxConsW, maxConsecutiveLosses: maxConsL,
    correlationToNifty: Math.round(correlation * 100) / 100,
    maxPositions: MAX_POS, positionSizePct: Math.round((100 / MAX_POS) * 100) / 100,
    capitalPerTrade: POSITION_SIZE,
    totalDays: sortedDates.length,
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };

  console.log(`[BollMR-BT] ${yearsLabel}yr: ${trades.length} trades, ${summary.totalReturnPct}% return, ${summary.winningPct}% win, ${summary.annualizedReturnPct}% ann.`);

  return {
    trades: trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
    dailySnapshots, summary,
    period: { from: startStr, to: sortedDates[sortedDates.length - 1] || to },
  };
}
