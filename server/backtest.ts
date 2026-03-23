import { getKite, isAuthenticated } from "./kite";
import { NSE_UNIVERSE } from "./nse-universe";

// ─── Yahoo Finance fallback ───
const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance =
  typeof YFClass === "function"
    ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] })
    : YFClass;

// ─── Types ───

interface Bar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  symbol: string;
  name: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  exitReason: "profit_target" | "price_action" | "time_exit";
  pnl: number;
  pnlPct: number;
  daysHeld: number;
  setupScore: number;
}

export interface EquityCurvePoint {
  date: string;
  equity: number;
  drawdownPct: number;
}

export interface BacktestResult {
  trades: Trade[];
  summary: {
    initialCapital: number;
    finalEquity: number;
    totalReturn: number;
    totalReturnPct: number;
    totalTrades: number;
    winners: number;
    losers: number;
    winRate: number;
    avgWinPct: number;
    avgLossPct: number;
    avgTradePnl: number;
    avgTradePct: number;
    maxDrawdownPct: number;
    profitFactor: number;
    sharpeRatio: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    avgDaysHeld: number;
    capitalPerTrade: number;
    maxPositions: number;
  };
  equityCurve: EquityCurvePoint[];
  period: { from: string; to: string };
  dataSource: string;
}

// ─── Data fetching ───

let instrumentMap: Map<string, number> = new Map();

async function loadKiteInstruments() {
  if (instrumentMap.size > 0) return;
  try {
    const kite = getKite();
    const instruments = await kite.getInstruments("NSE");
    for (const inst of instruments) {
      if (inst.segment === "NSE" && inst.instrument_type === "EQ") {
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
      }
    }
  } catch {}
}

async function fetchHistoricalBars(
  symbol: string,
  from: string,
  to: string
): Promise<Bar[] | null> {
  // Try Kite first
  if (isAuthenticated()) {
    try {
      await loadKiteInstruments();
      const clean = symbol.replace(".NS", "");
      const token = instrumentMap.get(clean);
      if (token) {
        const data = await getKite().getHistoricalData(token, "day", from, to);
        if (data && data.length > 0) {
          return data
            .filter((d: any) => d.close > 0)
            .map((d: any) => ({
              date: new Date(d.date).toISOString().split("T")[0],
              open: d.open,
              high: d.high,
              low: d.low,
              close: d.close,
              volume: d.volume,
            }));
        }
      }
    } catch {}
  }

  // Yahoo Finance fallback
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(from),
      period2: new Date(to),
      interval: "1d",
    });
    if (!result?.quotes) return null;
    return result.quotes
      .filter((q: any) => q.close !== null && q.close > 0 && q.high !== null)
      .map((q: any) => ({
        date: new Date(q.date).toISOString().split("T")[0],
        open: q.open ?? q.close,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume ?? 0,
      }));
  } catch {
    return null;
  }
}

// ─── Technical indicators ───

function computeSMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  return closes.slice(-period).reduce((s, c) => s + c, 0) / period;
}

function computeATR(bars: Bar[], idx: number, period: number): number {
  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

// ─── Backtest engine ───

interface OpenPosition {
  symbol: string;
  name: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  setupScore: number;
  atr5AtEntry: number;
  tradingDaysHeld: number;
  capitalAllocated: number;
  shares: number;
}

export async function runBacktest(params: {
  capitalRs?: number;
  maxPositions?: number;
  lookbackMonths?: number;
}): Promise<BacktestResult> {
  const CAPITAL = params.capitalRs || 1000000; // ₹10 lakh
  const MAX_POS = params.maxPositions || 20;
  const LOOKBACK = params.lookbackMonths || 12;

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - LOOKBACK - 8); // extra 8 months for 200-DMA warmup

  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];

  const backtestStart = new Date();
  backtestStart.setMonth(backtestStart.getMonth() - LOOKBACK);
  const backtestStartStr = backtestStart.toISOString().split("T")[0];

  const useKite = isAuthenticated();
  console.log(
    `[Backtest] Starting: ₹${(CAPITAL / 100000).toFixed(1)}L capital, ${MAX_POS} max positions, ${LOOKBACK}mo lookback via ${useKite ? "Kite" : "Yahoo"}`
  );

  // ─── Fetch all historical data ───
  const allBars: Map<string, Bar[]> = new Map();
  const batchSize = useKite ? 8 : 5;

  for (let i = 0; i < NSE_UNIVERSE.length; i += batchSize) {
    const batch = NSE_UNIVERSE.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (stock) => {
        const bars = await fetchHistoricalBars(stock.symbol, from, to);
        if (bars && bars.length >= 200) {
          allBars.set(stock.symbol, bars);
        }
      })
    );
    if (i + batchSize < NSE_UNIVERSE.length) {
      await new Promise((r) => setTimeout(r, useKite ? 100 : 150));
    }
    if ((i + batchSize) % 50 === 0) {
      console.log(`[Backtest] Fetched ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length} stocks...`);
    }
  }

  console.log(`[Backtest] Data ready for ${allBars.size} stocks. Simulating...`);

  // ─── Build unified date index ───
  const allDates = new Set<string>();
  for (const bars of allBars.values()) {
    for (const b of bars) {
      if (b.date >= backtestStartStr) allDates.add(b.date);
    }
  }
  const sortedDates = Array.from(allDates).sort();

  // ─── Simulation ───
  let cash = CAPITAL;
  const trades: Trade[] = [];
  const openPositions: OpenPosition[] = [];
  const equityCurve: EquityCurvePoint[] = [];
  let peakEquity = CAPITAL;

  // Build bar index for quick lookup
  const barIndex: Map<string, Map<string, number>> = new Map();
  for (const [symbol, bars] of allBars.entries()) {
    const idx = new Map<string, number>();
    bars.forEach((b, i) => idx.set(b.date, i));
    barIndex.set(symbol, idx);
  }

  for (let d = 0; d < sortedDates.length; d++) {
    const today = sortedDates[d];
    const yesterday = d > 0 ? sortedDates[d - 1] : null;

    // ─── Check exits on open positions ───
    const toClose: number[] = [];

    for (let p = 0; p < openPositions.length; p++) {
      const pos = openPositions[p];
      const bars = allBars.get(pos.symbol + (pos.symbol.endsWith(".NS") ? "" : ""))
        || allBars.get(pos.symbol);
      if (!bars) continue;

      const idxMap = barIndex.get(pos.symbol + (pos.symbol.endsWith(".NS") ? "" : ""))
        || barIndex.get(pos.symbol);
      if (!idxMap) continue;

      const todayIdx = idxMap.get(today);
      if (todayIdx === undefined) continue;

      const bar = bars[todayIdx];
      const prevBar = todayIdx > 0 ? bars[todayIdx - 1] : null;
      pos.tradingDaysHeld++;

      let exitPrice = 0;
      let exitReason: Trade["exitReason"] | null = null;

      // Exit Rule 1: Profit target — close + 0.5 * ATR(5)
      const profitTarget = pos.entryPrice + 0.5 * pos.atr5AtEntry;
      if (bar.high >= profitTarget) {
        exitPrice = profitTarget;
        exitReason = "profit_target";
      }

      // Exit Rule 2: Price action — close > previous day's high
      if (!exitReason && prevBar && bar.close > prevBar.high) {
        exitPrice = bar.close;
        exitReason = "price_action";
      }

      // Exit Rule 3: Time-based — 10 trading days
      if (!exitReason && pos.tradingDaysHeld >= 10) {
        exitPrice = bar.close;
        exitReason = "time_exit";
      }

      if (exitReason) {
        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

        trades.push({
          symbol: pos.symbol.replace(".NS", ""),
          name: pos.name,
          signalDate: pos.signalDate,
          entryDate: pos.entryDate,
          entryPrice: Math.round(pos.entryPrice * 100) / 100,
          exitDate: today,
          exitPrice: Math.round(exitPrice * 100) / 100,
          exitReason,
          pnl: Math.round(pnl),
          pnlPct: Math.round(pnlPct * 100) / 100,
          daysHeld: pos.tradingDaysHeld,
          setupScore: pos.setupScore,
        });

        cash += pos.capitalAllocated + pnl;
        toClose.push(p);
      }
    }

    // Remove closed positions (reverse order to keep indices valid)
    for (const idx of toClose.reverse()) {
      openPositions.splice(idx, 1);
    }

    // ─── Check for new signals ───
    if (openPositions.length < MAX_POS) {
      const candidates: {
        symbol: string;
        name: string;
        signalDate: string;
        close: number;
        atr5: number;
        setupScore: number;
        limitPrice: number;
      }[] = [];

      for (const [symbol, bars] of allBars.entries()) {
        // Skip if already holding
        if (openPositions.some((p) => p.symbol === symbol)) continue;

        const idxMap = barIndex.get(symbol);
        if (!idxMap) continue;

        const todayIdx = idxMap.get(today);
        if (todayIdx === undefined || todayIdx < 201) continue;

        const bar = bars[todayIdx];
        const prevBar = bars[todayIdx - 1];

        // 200 DMA
        const closes = bars.slice(todayIdx - 199, todayIdx + 1).map((b) => b.close);
        const dma200 = computeSMA(closes, 200);
        if (bar.close <= dma200) continue;

        // Dip > 3%
        const dropPct = ((prevBar.close - bar.close) / prevBar.close) * 100;
        if (dropPct < 3) continue;

        // ATR(5) volatility filter
        const atr5 = computeATR(bars, todayIdx, 5);
        if (atr5 === 0) continue;
        const atrPctClose = (100 * atr5) / bar.close;
        if (atrPctClose <= 3) continue;

        const limitPrice = bar.close - 0.9 * atr5;
        const setupScore = atr5 / bar.close;

        candidates.push({
          symbol,
          name: NSE_UNIVERSE.find((s) => s.symbol === symbol)?.name || symbol.replace(".NS", ""),
          signalDate: today,
          close: bar.close,
          atr5,
          setupScore,
          limitPrice,
        });
      }

      // Sort by setup score (highest first), take up to available slots
      candidates.sort((a, b) => b.setupScore - a.setupScore);
      const slotsAvailable = MAX_POS - openPositions.length;
      const toEnter = candidates.slice(0, slotsAvailable);

      // Next trading day: check if limit order fills
      if (d + 1 < sortedDates.length) {
        const nextDay = sortedDates[d + 1];

        for (const cand of toEnter) {
          const bars = allBars.get(cand.symbol);
          if (!bars) continue;
          const idxMap = barIndex.get(cand.symbol);
          if (!idxMap) continue;
          const nextIdx = idxMap.get(nextDay);
          if (nextIdx === undefined) continue;

          const nextBar = bars[nextIdx];

          // Check if limit price is hit (low <= limitPrice)
          if (nextBar.low <= cand.limitPrice) {
            const entryPrice = cand.limitPrice;
            const capitalPerTrade = CAPITAL / MAX_POS;

            if (cash >= capitalPerTrade) {
              const shares = Math.floor(capitalPerTrade / entryPrice);
              if (shares <= 0) continue;

              const allocated = shares * entryPrice;
              cash -= allocated;

              openPositions.push({
                symbol: cand.symbol,
                name: cand.name,
                signalDate: cand.signalDate,
                entryDate: nextDay,
                entryPrice,
                setupScore: Math.round(cand.setupScore * 10000) / 10000,
                atr5AtEntry: cand.atr5,
                tradingDaysHeld: 0,
                capitalAllocated: allocated,
                shares,
              });
            }
          }
        }
      }
    }

    // ─── Equity curve ───
    let openPnl = 0;
    for (const pos of openPositions) {
      const bars = allBars.get(pos.symbol);
      if (!bars) continue;
      const idxMap = barIndex.get(pos.symbol);
      if (!idxMap) continue;
      const todayIdx = idxMap.get(today);
      if (todayIdx === undefined) continue;
      openPnl += (bars[todayIdx].close - pos.entryPrice) * pos.shares;
    }

    const equity = cash + openPositions.reduce((s, p) => s + p.capitalAllocated, 0) + openPnl;
    peakEquity = Math.max(peakEquity, equity);
    const dd = ((peakEquity - equity) / peakEquity) * 100;

    // Sample equity curve (every 5th day to keep payload small)
    if (d % 5 === 0 || d === sortedDates.length - 1) {
      equityCurve.push({
        date: today,
        equity: Math.round(equity),
        drawdownPct: Math.round(dd * 100) / 100,
      });
    }
  }

  // ─── Force close any remaining open positions at last date ───
  const lastDate = sortedDates[sortedDates.length - 1];
  for (const pos of openPositions) {
    const bars = allBars.get(pos.symbol);
    if (!bars) continue;
    const lastBar = bars[bars.length - 1];
    const pnl = (lastBar.close - pos.entryPrice) * pos.shares;
    const pnlPct = ((lastBar.close - pos.entryPrice) / pos.entryPrice) * 100;
    trades.push({
      symbol: pos.symbol.replace(".NS", ""),
      name: pos.name,
      signalDate: pos.signalDate,
      entryDate: pos.entryDate,
      entryPrice: Math.round(pos.entryPrice * 100) / 100,
      exitDate: lastDate,
      exitPrice: Math.round(lastBar.close * 100) / 100,
      exitReason: "time_exit",
      pnl: Math.round(pnl),
      pnlPct: Math.round(pnlPct * 100) / 100,
      daysHeld: pos.tradingDaysHeld,
      setupScore: pos.setupScore,
    });
    cash += pos.capitalAllocated + pnl;
  }

  // ─── Performance summary ───
  const finalEquity = cash;
  const totalReturn = finalEquity - CAPITAL;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);

  const avgWinPct = winners.length > 0
    ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length > 0
    ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max consecutive wins/losses
  let maxConsWins = 0, maxConsLosses = 0, consW = 0, consL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { consW++; consL = 0; maxConsWins = Math.max(maxConsWins, consW); }
    else { consL++; consW = 0; maxConsLosses = Math.max(maxConsLosses, consL); }
  }

  // Sharpe ratio (annualized, using daily equity returns)
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
  }
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  const maxDD = equityCurve.reduce((max, p) => Math.max(max, p.drawdownPct), 0);

  const result: BacktestResult = {
    trades: trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
    summary: {
      initialCapital: CAPITAL,
      finalEquity: Math.round(finalEquity),
      totalReturn: Math.round(totalReturn),
      totalReturnPct: Math.round((totalReturn / CAPITAL) * 10000) / 100,
      totalTrades: trades.length,
      winners: winners.length,
      losers: losers.length,
      winRate: trades.length > 0 ? Math.round((winners.length / trades.length) * 10000) / 100 : 0,
      avgWinPct: Math.round(avgWinPct * 100) / 100,
      avgLossPct: Math.round(avgLossPct * 100) / 100,
      avgTradePnl: trades.length > 0 ? Math.round(totalReturn / trades.length) : 0,
      avgTradePct: trades.length > 0
        ? Math.round((trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length) * 100) / 100 : 0,
      maxDrawdownPct: Math.round(maxDD * 100) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      avgDaysHeld: trades.length > 0
        ? Math.round((trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length) * 10) / 10 : 0,
      capitalPerTrade: Math.round(CAPITAL / MAX_POS),
      maxPositions: MAX_POS,
    },
    equityCurve,
    period: { from: backtestStartStr, to: sortedDates[sortedDates.length - 1] || to },
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };

  console.log(
    `[Backtest] Complete: ${trades.length} trades, ${result.summary.totalReturnPct}% return, ${result.summary.winRate}% win rate`
  );

  return result;
}

// Cache
let cachedBacktest: BacktestResult | null = null;
let backtestCacheTime = 0;

export async function getBacktestResult(params?: {
  capitalRs?: number;
  maxPositions?: number;
  lookbackMonths?: number;
}): Promise<BacktestResult> {
  const now = Date.now();
  if (cachedBacktest && now - backtestCacheTime < 3600000) {
    return cachedBacktest;
  }
  cachedBacktest = await runBacktest(params || {});
  backtestCacheTime = now;
  return cachedBacktest;
}

export function clearBacktestCache() {
  cachedBacktest = null;
  backtestCacheTime = 0;
}
