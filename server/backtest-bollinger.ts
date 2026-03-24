import { getKite, isAuthenticated } from "./kite";
import { NSE_UNIVERSE } from "./nse-universe";
import type { BacktestResult, BacktestSummary, Trade, DailySnapshot } from "./backtest";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

// Re-export types
export type { BacktestResult, Trade, DailySnapshot };

// ─── Data fetching (shared) ───
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
    return result.quotes.filter((q: any) => q.close !== null && q.close > 0)
      .map((q: any) => ({ date: new Date(q.date).toISOString().split("T")[0], open: q.open ?? q.close, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
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

// ─── Bollinger Backtest Engine ───

export interface BollingerBacktestParams {
  capitalRs?: number;
  maxPositions?: number;
  lookbackYears?: number;
  maPeriod?: number;        // default 20
  entryBandSigma?: number;  // default 2
  stopLossSigma?: number;   // default 3
  maxHoldDays?: number;     // default 10
  absoluteStopPct?: number; // optional: e.g., 5 means -5% absolute stop
  trailingStopPct?: number; // optional: e.g., 3 means -3% trailing from peak
}

interface OpenPosition {
  id: number; symbol: string; name: string; signalDate: string; entryDate: string;
  entryPrice: number; shares: number; capitalAllocated: number;
  setupScore: number; ma20AtEntry: number; stdDevAtEntry: number;
  tradingDaysHeld: number; targetPrice: number; stopPrice: number;
  peakPrice: number; // for trailing stop
  portfolioValueAtEntry: number;
}

export async function runBollingerBacktest(params: BollingerBacktestParams): Promise<BacktestResult> {
  const CAPITAL = params.capitalRs || 1000000;
  const MAX_POS = params.maxPositions || 10;
  const YEARS = params.lookbackYears || 5;
  const MA_PERIOD = params.maPeriod || 20;
  const ENTRY_SIGMA = params.entryBandSigma || 2;
  const STOP_SIGMA = params.stopLossSigma || 3;
  const MAX_HOLD = params.maxHoldDays || 10;
  const ABS_STOP = params.absoluteStopPct; // undefined = disabled
  const TRAIL_STOP = params.trailingStopPct; // undefined = disabled

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setFullYear(fromDate.getFullYear() - YEARS - 1);
  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];
  const backtestStart = new Date();
  backtestStart.setFullYear(backtestStart.getFullYear() - YEARS);
  const startStr = backtestStart.toISOString().split("T")[0];

  const useKite = isAuthenticated();
  console.log(`[BollingerBT] ${YEARS}yr, ₹${(CAPITAL/1e5).toFixed(0)}L, ${MAX_POS} pos, ${MA_PERIOD}MA, ±${ENTRY_SIGMA}σ entry, -${STOP_SIGMA}σ stop`);

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
    if ((i + batchSize) % 100 === 0) console.log(`[BollingerBT] ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length}...`);
  }
  console.log(`[BollingerBT] Data for ${allBars.size} stocks. Simulating...`);

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

  // Track which stocks were below -2σ yesterday (for crossover detection)
  const wasBelowBand: Map<string, boolean> = new Map();

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

      let exitPrice = 0;
      let exitReason: Trade["exitReason"] | null = null;
      let exitDetail = "";

      // Exit 1: Mean reversion target — price reaches MA
      const ma = computeSMA(bars, tIdx, MA_PERIOD);
      if (bar.high >= ma) {
        exitPrice = ma;
        exitReason = "profit_target";
        exitDetail = `High ₹${bar.high.toFixed(2)} ≥ ${MA_PERIOD}-DMA ₹${ma.toFixed(2)} — mean reversion target hit`;
      }

      // Exit 2: Stop loss — drops to -3σ
      if (!exitReason) {
        const std = computeStdDev(bars, tIdx, MA_PERIOD);
        const stopBand = ma - STOP_SIGMA * std;
        if (bar.low <= stopBand) {
          exitPrice = stopBand;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `Low ₹${bar.low.toFixed(2)} ≤ −${STOP_SIGMA}σ band ₹${stopBand.toFixed(2)} — stop loss triggered`;
        }
      }

      // Exit 3: Absolute stop loss (if configured)
      if (!exitReason && ABS_STOP) {
        const absStopPrice = pos.entryPrice * (1 - ABS_STOP / 100);
        if (bar.low <= absStopPrice) {
          exitPrice = absStopPrice;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `Low ₹${bar.low.toFixed(2)} ≤ Absolute stop −${ABS_STOP}% = ₹${absStopPrice.toFixed(2)}`;
        }
      }

      // Exit 4: Trailing stop (if configured)
      if (!exitReason && TRAIL_STOP) {
        const trailStopPrice = pos.peakPrice * (1 - TRAIL_STOP / 100);
        if (bar.low <= trailStopPrice) {
          exitPrice = trailStopPrice;
          exitReason = "price_action_close_above_prev_high";
          exitDetail = `Low ₹${bar.low.toFixed(2)} ≤ Trailing stop −${TRAIL_STOP}% from peak ₹${pos.peakPrice.toFixed(2)} = ₹${trailStopPrice.toFixed(2)}`;
        }
      }

      // Exit 5: Time exit
      if (!exitReason && pos.tradingDaysHeld >= MAX_HOLD) {
        exitPrice = bar.close;
        exitReason = "time_exit_10_days";
        exitDetail = `Held ${pos.tradingDaysHeld} days ≥ ${MAX_HOLD} day limit — exit at ₹${bar.close.toFixed(2)}`;
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
          atr5AtEntry: 0, profitTargetPrice: Math.round(pos.targetPrice * 100) / 100,
          portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry),
          portfolioValueAtExit: Math.round(getCurrentValue()),
        });
        toClose.push(p);
      }
    }
    for (const idx of toClose.reverse()) openPositions.splice(idx, 1);

    // ─── Check for new Bollinger signals ───
    if (openPositions.length < MAX_POS) {
      const candidates: {
        symbol: string; name: string; date: string; close: number;
        ma: number; std: number; setupScore: number; target: number; stop: number;
      }[] = [];

      for (const [symbol, bars] of allBars.entries()) {
        if (openPositions.some(p => p.symbol === symbol)) continue;
        const idxMap = barIndex.get(symbol);
        if (!idxMap) continue;
        const tIdx = idxMap.get(today);
        if (tIdx === undefined || tIdx < MA_PERIOD + 1) continue;

        const bar = bars[tIdx];
        const prevBar = bars[tIdx - 1];
        const ma = computeSMA(bars, tIdx, MA_PERIOD);
        const std = computeStdDev(bars, tIdx, MA_PERIOD);
        if (ma === 0 || std === 0) continue;

        const lowerBand = ma - ENTRY_SIGMA * std;
        const prevMa = computeSMA(bars, tIdx - 1, MA_PERIOD);
        const prevStd = computeStdDev(bars, tIdx - 1, MA_PERIOD);
        const prevLower = prevMa - ENTRY_SIGMA * prevStd;

        // Signal: was below -2σ yesterday, crossed above -2σ today
        const wasBelowYesterday = prevBar.close < prevLower;
        const isAboveToday = bar.close >= lowerBand;

        // Track state
        const prevWasBelow = wasBelowBand.get(symbol) || false;
        wasBelowBand.set(symbol, bar.close < lowerBand);

        if ((wasBelowYesterday || prevWasBelow) && isAboveToday) {
          const distToMean = ((ma - bar.close) / bar.close) * 100;
          candidates.push({
            symbol, name: NSE_UNIVERSE.find(s => s.symbol === symbol)?.name || symbol.replace(".NS", ""),
            date: today, close: bar.close, ma, std,
            setupScore: Math.abs(distToMean), // deeper dip = higher conviction
            target: ma,
            stop: ma - STOP_SIGMA * std,
          });
        }
      }

      candidates.sort((a, b) => b.setupScore - a.setupScore);
      const slots = MAX_POS - openPositions.length;

      for (const cand of candidates.slice(0, slots)) {
        const currentPortfolio = getCurrentValue();
        const posSize = currentPortfolio / MAX_POS;
        const shares = Math.floor(posSize / cand.close);
        if (shares <= 0 || cash < shares * cand.close) continue;

        cash -= shares * cand.close;
        openPositions.push({
          id: ++tradeId, symbol: cand.symbol, name: cand.name,
          signalDate: cand.date, entryDate: cand.date,
          entryPrice: cand.close, shares, capitalAllocated: shares * cand.close,
          setupScore: Math.round(cand.setupScore * 100) / 100,
          ma20AtEntry: cand.ma, stdDevAtEntry: cand.std,
          tradingDaysHeld: 0, targetPrice: cand.target, stopPrice: cand.stop,
          peakPrice: cand.close,
          portfolioValueAtEntry: currentPortfolio,
        });
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
      daysHeld: pos.tradingDaysHeld, setupScore: pos.setupScore,
      atr5AtEntry: 0, profitTargetPrice: Math.round(pos.targetPrice * 100) / 100,
      portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry), portfolioValueAtExit: Math.round(cash),
    });
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
    capitalPerTrade: Math.round(CAPITAL / MAX_POS),
    totalDays: sortedDates.length,
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };

  console.log(`[BollingerBT] ${YEARS}yr: ${trades.length} trades, ${summary.totalReturnPct}% return, ${summary.winningPct}% win, ${summary.annualizedReturnPct}% ann.`);

  return {
    trades: trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
    dailySnapshots, summary,
    period: { from: startStr, to: sortedDates[sortedDates.length - 1] || to },
  };
}
