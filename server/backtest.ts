import { getKite, isAuthenticated, throttledKite } from "./kite";
import { NSE_UNIVERSE } from "./nse-universe";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

// ─── Types ───

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

export interface Trade {
  id: number;
  symbol: string;
  name: string;
  signalDate: string;
  entryDate: string;
  entryTime: string;
  entryPrice: number;
  shares: number;
  capitalAllocated: number;
  exitDate: string;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  exitReasonDetail: string;
  pnl: number;
  pnlPct: number;
  daysHeld: number;
  setupScore: number;
  atr5AtEntry: number;
  profitTargetPrice: number;
  portfolioValueAtEntry: number;
  portfolioValueAtExit: number;
}

export interface DailySnapshot {
  date: string;
  portfolioValue: number;
  cash: number;
  investedValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openPositions: number;
  equityPct: number;       // % return from initial
  drawdownPct: number;     // from peak
  niftyClose: number;
  niftyPct: number;        // % return from nifty start
}

export interface BacktestSummary {
  initialCapital: number;
  finalPortfolioValue: number;
  totalReturn: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winningPct: number;
  highestWinPct: number;
  highestWinSymbol: string;
  highestLossPct: number;
  highestLossSymbol: string;
  avgWinPct: number;
  avgLossPct: number;
  avgWinToLossRatio: number;
  avgTradeDurationDays: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  maxDrawdownDate: string;
  profitFactor: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  correlationToNifty: number;
  maxPositions: number;
  positionSizePct: number;
  capitalPerTrade: number;
  totalDays: number;
  dataSource: string;
}

export interface BacktestResult {
  trades: Trade[];
  dailySnapshots: DailySnapshot[];
  summary: BacktestSummary;
  period: { from: string; to: string };
}

// ─── Data fetching ───

let instrumentMap: Map<string, number> = new Map();

async function loadKiteInstruments() {
  if (instrumentMap.size > 0) return;
  try {
    const instruments = await throttledKite(k => k.getInstruments("NSE"));
    for (const inst of instruments) {
      if (inst.segment === "NSE" && inst.instrument_type === "EQ")
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
    }
  } catch {}
}

async function fetchBars(symbol: string, from: string, to: string): Promise<Bar[] | null> {
  if (isAuthenticated()) {
    try {
      await loadKiteInstruments();
      const clean = symbol.replace(".NS", "");
      const token = instrumentMap.get(clean);
      if (token) {
        const data = await throttledKite(k => k.getHistoricalData(token, "day", from, to));
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
    return result.quotes.filter((q: any) => q.close !== null && q.close > 0 && q.high !== null)
      .map((q: any) => ({
        date: new Date(q.date).toISOString().split("T")[0],
        open: q.open ?? q.close, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
      }));
  } catch { return null; }
}

// ─── Indicators ───

function computeATR(bars: Bar[], idx: number, period: number): number {
  if (idx < period) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    sum += Math.max(bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close));
  }
  return sum / period;
}

function computeSMA(bars: Bar[], idx: number, period: number): number {
  if (idx < period - 1) return 0;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += bars[i].close;
  return sum / period;
}

// ─── Correlation ───

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  const xSlice = x.slice(0, n), ySlice = y.slice(0, n);
  const xMean = xSlice.reduce((s, v) => s + v, 0) / n;
  const yMean = ySlice.reduce((s, v) => s + v, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean, dy = ySlice[i] - yMean;
    num += dx * dy; denX += dx * dx; denY += dy * dy;
  }
  return denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0;
}

// ─── Backtest Engine ───

export interface ATRBacktestParams {
  capitalRs?: number;
  maxPositions?: number;
  lookbackYears?: number;
  fromDate?: string;         // YYYY-MM-DD, takes precedence over lookbackYears
  toDate?: string;           // YYYY-MM-DD, defaults to today
  maxHoldDays?: number;      // default 10
  absoluteStopPct?: number;  // e.g. 5 means -5% absolute stop from entry
  trailingStopPct?: number;  // e.g. 3 means -3% trailing stop from peak
  dmaLength?: number;          // default 200 (can be 50, 100, 200)
  dipThresholdPct?: number;    // default 3 (can be 2, 3, 5)
  atrFilterThreshold?: number; // default 3 (can be 2, 3, 4, 5)
  limitOrderMultiple?: number; // default 0.9 (can be 0.5, 0.7, 0.9, 1.0)
  profitTargetMultiple?: number; // default 0.5 (can be 0.3, 0.5, 0.7, 1.0)
  priceActionExit?: boolean;   // default true (close > prev high)
  universeOverride?: typeof NSE_UNIVERSE; // optional filtered universe
  benchmarkTicker?: string; // Yahoo Finance ticker for benchmark (default: ^NSEI)
  benchmarkLabel?: string;  // Human-readable benchmark name
}

interface OpenPosition {
  id: number; symbol: string; name: string; signalDate: string; entryDate: string;
  entryPrice: number; shares: number; capitalAllocated: number;
  setupScore: number; atr5: number; tradingDaysHeld: number; profitTarget: number;
  peakPrice: number; // for trailing stop
  portfolioValueAtEntry: number;
}

export async function runBacktest(params: ATRBacktestParams): Promise<BacktestResult> {
  const CAPITAL = params.capitalRs || 1000000;
  const MAX_POS = params.maxPositions || 10;
  const MAX_HOLD = params.maxHoldDays || 10;
  const ABS_STOP = params.absoluteStopPct;   // undefined = disabled
  const TRAIL_STOP = params.trailingStopPct; // undefined = disabled
  const DMA_LEN = params.dmaLength || 200;
  const DIP_THRESH = params.dipThresholdPct || 3;
  const ATR_FILTER = params.atrFilterThreshold || 3;
  const LIMIT_MULT = params.limitOrderMultiple ?? 0.9;
  const PROFIT_MULT = params.profitTargetMultiple ?? 0.5;
  const PRICE_ACTION_EXIT = params.priceActionExit !== false; // default true
  const universe = params.universeOverride || NSE_UNIVERSE;

  // Determine backtest period — fromDate/toDate take precedence over lookbackYears
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
  fromDate.setDate(fromDate.getDate() - (DMA_LEN + 120)); // extra buffer for DMA warmup

  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];
  const startStr = backtestStart.toISOString().split("T")[0];

  const yearsLabel = ((toDate.getTime() - backtestStart.getTime()) / (365.25 * 86400000)).toFixed(1);
  const useKite = isAuthenticated();
  console.log(`[Backtest] ${yearsLabel}yr (${startStr} → ${to}), ₹${(CAPITAL/1e5).toFixed(0)}L, ${MAX_POS} max pos, hold ${MAX_HOLD}d, DMA=${DMA_LEN}, dip=${DIP_THRESH}%, atrFilt=${ATR_FILTER}, limit=${LIMIT_MULT}×ATR, profit=${PROFIT_MULT}×ATR, priceAction=${PRICE_ACTION_EXIT}, absStop=${ABS_STOP ?? 'off'}, trailStop=${TRAIL_STOP ?? 'off'}, via ${useKite ? "Kite" : "Yahoo"}`);

  // ─── Fetch Nifty 50 for correlation ───
  const bmTicker = params.benchmarkTicker || "^NSEI";
  const niftyBars = await fetchBars(bmTicker, from, to) || await fetchBars("NIFTY_50.NS", from, to) || [];
  const niftyByDate: Map<string, number> = new Map();
  for (const b of niftyBars) niftyByDate.set(b.date, b.close);

  // ─── Fetch all stock data ───
  const allBars: Map<string, Bar[]> = new Map();
  const batchSize = useKite ? 8 : 5;
  for (let i = 0; i < universe.length; i += batchSize) {
    const batch = universe.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (stock) => {
      const bars = await fetchBars(stock.symbol, from, to);
      if (bars && bars.length >= DMA_LEN) allBars.set(stock.symbol, bars);
    }));
    if (i + batchSize < universe.length) await new Promise(r => setTimeout(r, useKite ? 80 : 120));
    if ((i + batchSize) % 100 === 0) console.log(`[Backtest] Fetched ${Math.min(i + batchSize, universe.length)} / ${universe.length}...`);
  }
  console.log(`[Backtest] Data for ${allBars.size} stocks. Simulating ${yearsLabel} years...`);

  // ─── Build date index ───
  const allDates = new Set<string>();
  for (const bars of allBars.values()) for (const b of bars) if (b.date >= startStr) allDates.add(b.date);
  const sortedDates = Array.from(allDates).sort();

  const barIndex: Map<string, Map<string, number>> = new Map();
  for (const [symbol, bars] of allBars.entries()) {
    const idx = new Map<string, number>();
    bars.forEach((b, i) => idx.set(b.date, i));
    barIndex.set(symbol, idx);
  }

  // ─── Simulation ───
  let cash = CAPITAL;
  let realizedPnl = 0;
  let tradeId = 0;
  const trades: Trade[] = [];
  const openPositions: OpenPosition[] = [];
  const dailySnapshots: DailySnapshot[] = [];
  let peakValue = CAPITAL;
  const niftyStart = niftyByDate.get(sortedDates[0]) || 0;

  for (let d = 0; d < sortedDates.length; d++) {
    const today = sortedDates[d];

    // ─── Calculate current portfolio value ───
    const getCurrentPortfolioValue = (): number => {
      let invested = 0;
      for (const pos of openPositions) {
        const bars = allBars.get(pos.symbol);
        const idxMap = barIndex.get(pos.symbol);
        if (!bars || !idxMap) continue;
        const todayIdx = idxMap.get(today);
        if (todayIdx === undefined) { invested += pos.capitalAllocated; continue; }
        invested += bars[todayIdx].close * pos.shares;
      }
      return cash + invested;
    };

    // ─── Check exits (FIFO) ───
    const toClose: number[] = [];
    for (let p = 0; p < openPositions.length; p++) {
      const pos = openPositions[p];
      const bars = allBars.get(pos.symbol);
      const idxMap = barIndex.get(pos.symbol);
      if (!bars || !idxMap) continue;
      const todayIdx = idxMap.get(today);
      if (todayIdx === undefined) continue;

      const bar = bars[todayIdx];
      const prevBar = todayIdx > 0 ? bars[todayIdx - 1] : null;
      pos.tradingDaysHeld++;
      pos.peakPrice = Math.max(pos.peakPrice, bar.high);

      let exitPrice = 0;
      let exitReason: Trade["exitReason"] | null = null;
      let exitReasonDetail = "";

      // Exit 1: Profit target — entry + 0.5 * ATR(5)
      if (bar.high >= pos.profitTarget) {
        exitPrice = pos.profitTarget;
        exitReason = "Profit Target";
        exitReasonDetail = `High ₹${bar.high.toFixed(2)} ≥ Target ₹${pos.profitTarget.toFixed(2)} (Entry ₹${pos.entryPrice.toFixed(2)} + ${PROFIT_MULT}×ATR ₹${(pos.atr5 * PROFIT_MULT).toFixed(2)})`;
      }

      // Exit 2: Price action — close > previous day's high (configurable)
      if (!exitReason && PRICE_ACTION_EXIT && prevBar && bar.close > prevBar.high) {
        exitPrice = bar.close;
        exitReason = "Price Action";
        exitReasonDetail = `Close ₹${bar.close.toFixed(2)} > Prev High ₹${prevBar.high.toFixed(2)} — rebound confirmed`;
      }

      // Exit 3: Absolute stop loss (if configured)
      if (!exitReason && ABS_STOP) {
        const absStopPrice = pos.entryPrice * (1 - ABS_STOP / 100);
        if (bar.low <= absStopPrice) {
          exitPrice = absStopPrice;
          exitReason = "Stop Loss";
          exitReasonDetail = `🛑 ABS STOP: Low ₹${bar.low.toFixed(2)} ≤ −${ABS_STOP}% from entry = ₹${absStopPrice.toFixed(2)}`;
        }
      }

      // Exit 4: Trailing stop (if configured)
      if (!exitReason && TRAIL_STOP) {
        const trailStopPrice = pos.peakPrice * (1 - TRAIL_STOP / 100);
        if (bar.low <= trailStopPrice) {
          exitPrice = trailStopPrice;
          exitReason = "Trailing Stop Loss";
          exitReasonDetail = `🛑 TRAIL STOP: Low ₹${bar.low.toFixed(2)} ≤ −${TRAIL_STOP}% from peak ₹${pos.peakPrice.toFixed(2)} = ₹${trailStopPrice.toFixed(2)}`;
        }
      }

      // Exit 5: Time-based — configurable max hold days
      if (!exitReason && pos.tradingDaysHeld >= MAX_HOLD) {
        exitPrice = bar.close;
        exitReason = "Timed Out";
        exitReasonDetail = `Held ${pos.tradingDaysHeld} trading days ≥ ${MAX_HOLD} day limit — forced exit at close ₹${bar.close.toFixed(2)}`;
      }

      if (exitReason) {
        const pnl = (exitPrice - pos.entryPrice) * pos.shares;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
        realizedPnl += pnl;
        cash += pos.shares * exitPrice;
        const portfolioValueAtExit = getCurrentPortfolioValue();

        trades.push({
          id: ++tradeId,
          symbol: pos.symbol.replace(".NS", ""),
          name: pos.name,
          signalDate: pos.signalDate,
          entryDate: pos.entryDate,
          entryTime: `${pos.entryDate} 09:20:00 IST`,
          entryPrice: Math.round(pos.entryPrice * 100) / 100,
          shares: pos.shares,
          capitalAllocated: Math.round(pos.capitalAllocated),
          exitDate: today,
          exitTime: exitReason === "Profit Target" ? `${today} (intraday)` : `${today} 15:30:00 IST`,
          exitPrice: Math.round(exitPrice * 100) / 100,
          exitReason,
          exitReasonDetail,
          pnl: Math.round(pnl),
          pnlPct: Math.round(pnlPct * 100) / 100,
          daysHeld: pos.tradingDaysHeld,
          setupScore: pos.setupScore,
          atr5AtEntry: Math.round(pos.atr5 * 100) / 100,
          profitTargetPrice: Math.round(pos.profitTarget * 100) / 100,
          portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry),
          portfolioValueAtExit: Math.round(portfolioValueAtExit),
        });
        toClose.push(p);
      }
    }
    for (const idx of toClose.reverse()) openPositions.splice(idx, 1);

    // ─── Check for new signals ───
    if (openPositions.length < MAX_POS && d + 1 < sortedDates.length) {
      const candidates: {
        symbol: string; name: string; signalDate: string; close: number;
        atr5: number; setupScore: number; limitPrice: number; profitTarget: number;
      }[] = [];

      for (const [symbol, bars] of allBars.entries()) {
        if (openPositions.some(p => p.symbol === symbol)) continue;
        const idxMap = barIndex.get(symbol);
        if (!idxMap) continue;
        const todayIdx = idxMap.get(today);
        if (todayIdx === undefined || todayIdx < DMA_LEN + 1) continue;

        const bar = bars[todayIdx];
        const prevBar = bars[todayIdx - 1];

        // N-DMA filter (configurable)
        const dma = computeSMA(bars, todayIdx, DMA_LEN);
        if (bar.close <= dma) continue;

        // Dip > threshold% (configurable)
        const dropPct = ((prevBar.close - bar.close) / prevBar.close) * 100;
        if (dropPct < DIP_THRESH) continue;

        // ATR(5) volatility filter (configurable threshold)
        const atr5 = computeATR(bars, todayIdx, 5);
        if (atr5 === 0) continue;
        const atrPctClose = (100 * atr5) / bar.close;
        if (atrPctClose <= ATR_FILTER) continue;

        candidates.push({
          symbol,
          name: universe.find(s => s.symbol === symbol)?.name || symbol.replace(".NS", ""),
          signalDate: today,
          close: bar.close,
          atr5,
          setupScore: atr5 / bar.close,
          limitPrice: bar.close - LIMIT_MULT * atr5,
          profitTarget: bar.close + PROFIT_MULT * atr5,
        });
      }

      // Sort by conviction (setup score) — highest first
      candidates.sort((a, b) => b.setupScore - a.setupScore);
      const slotsAvailable = MAX_POS - openPositions.length;
      const toEnter = candidates.slice(0, slotsAvailable);

      const nextDay = sortedDates[d + 1];

      for (const cand of toEnter) {
        const bars = allBars.get(cand.symbol);
        const idxMap = barIndex.get(cand.symbol);
        if (!bars || !idxMap) continue;
        const nextIdx = idxMap.get(nextDay);
        if (nextIdx === undefined) continue;
        const nextBar = bars[nextIdx];

        // Check if limit order fills
        if (nextBar.low <= cand.limitPrice) {
          // Dynamic position sizing: (invested value + realized P&L) / MAX_POS
          const currentPortfolio = getCurrentPortfolioValue();
          const positionSize = currentPortfolio / MAX_POS;
          const entryPrice = cand.limitPrice;
          const shares = Math.floor(positionSize / entryPrice);
          if (shares <= 0 || cash < shares * entryPrice) continue;

          const allocated = shares * entryPrice;
          cash -= allocated;

          openPositions.push({
            id: ++tradeId,
            symbol: cand.symbol,
            name: cand.name,
            signalDate: cand.signalDate,
            entryDate: nextDay,
            entryPrice,
            shares,
            capitalAllocated: allocated,
            setupScore: Math.round(cand.setupScore * 10000) / 10000,
            atr5: cand.atr5,
            tradingDaysHeld: 0,
            profitTarget: cand.profitTarget,
            peakPrice: entryPrice,
            portfolioValueAtEntry: currentPortfolio,
          });
        }
      }
    }

    // ─── Daily snapshot ───
    let investedValue = 0;
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      const bars = allBars.get(pos.symbol);
      const idxMap = barIndex.get(pos.symbol);
      if (!bars || !idxMap) continue;
      const todayIdx = idxMap.get(today);
      if (todayIdx === undefined) continue;
      const mv = bars[todayIdx].close * pos.shares;
      investedValue += mv;
      unrealizedPnl += (bars[todayIdx].close - pos.entryPrice) * pos.shares;
    }

    const portfolioValue = cash + investedValue;
    peakValue = Math.max(peakValue, portfolioValue);
    const dd = ((peakValue - portfolioValue) / peakValue) * 100;
    const equityPct = ((portfolioValue - CAPITAL) / CAPITAL) * 100;
    const niftyClose = niftyByDate.get(today) || 0;
    const niftyPct = niftyStart > 0 ? ((niftyClose - niftyStart) / niftyStart) * 100 : 0;

    dailySnapshots.push({
      date: today,
      portfolioValue: Math.round(portfolioValue),
      cash: Math.round(cash),
      investedValue: Math.round(investedValue),
      unrealizedPnl: Math.round(unrealizedPnl),
      realizedPnl: Math.round(realizedPnl),
      openPositions: openPositions.length,
      equityPct: Math.round(equityPct * 100) / 100,
      drawdownPct: Math.round(dd * 100) / 100,
      niftyClose: Math.round(niftyClose * 100) / 100,
      niftyPct: Math.round(niftyPct * 100) / 100,
    });
  }

  // ─── Force close remaining positions ───
  const lastDate = sortedDates[sortedDates.length - 1];
  for (const pos of [...openPositions]) {
    const bars = allBars.get(pos.symbol);
    if (!bars) continue;
    const lastBar = bars[bars.length - 1];
    const pnl = (lastBar.close - pos.entryPrice) * pos.shares;
    const pnlPct = ((lastBar.close - pos.entryPrice) / pos.entryPrice) * 100;
    realizedPnl += pnl;
    cash += pos.shares * lastBar.close;

    trades.push({
      id: ++tradeId,
      symbol: pos.symbol.replace(".NS", ""),
      name: pos.name,
      signalDate: pos.signalDate,
      entryDate: pos.entryDate,
      entryTime: `${pos.entryDate} 09:20:00 IST`,
      entryPrice: Math.round(pos.entryPrice * 100) / 100,
      shares: pos.shares,
      capitalAllocated: Math.round(pos.capitalAllocated),
      exitDate: lastDate,
      exitTime: `${lastDate} 15:30:00 IST`,
      exitPrice: Math.round(lastBar.close * 100) / 100,
      exitReason: "Forced Exit",
      exitReasonDetail: `Backtest ended — force closed at ₹${lastBar.close.toFixed(2)}`,
      pnl: Math.round(pnl),
      pnlPct: Math.round(pnlPct * 100) / 100,
      daysHeld: pos.tradingDaysHeld,
      setupScore: pos.setupScore,
      atr5AtEntry: Math.round(pos.atr5 * 100) / 100,
      profitTargetPrice: Math.round(pos.profitTarget * 100) / 100,
      portfolioValueAtEntry: Math.round(pos.portfolioValueAtEntry),
      portfolioValueAtExit: Math.round(cash),
    });
  }

  // ─── Summary stats ───
  const finalValue = cash;
  const totalReturn = finalValue - CAPITAL;
  const totalReturnPct = (totalReturn / CAPITAL) * 100;
  const totalDays = sortedDates.length;
  const yearsActual = totalDays / 252;
  const annualizedReturn = yearsActual > 0 ? (Math.pow(finalValue / CAPITAL, 1 / yearsActual) - 1) * 100 : 0;

  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const avgWinPct = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length > 0 ? Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length) : 0;

  const highestWin = winners.length > 0 ? winners.reduce((best, t) => t.pnlPct > best.pnlPct ? t : best) : null;
  const highestLoss = losers.length > 0 ? losers.reduce((worst, t) => t.pnlPct < worst.pnlPct ? t : worst) : null;

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  // Sharpe (daily returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < dailySnapshots.length; i++) {
    dailyReturns.push((dailySnapshots[i].portfolioValue - dailySnapshots[i-1].portfolioValue) / dailySnapshots[i-1].portfolioValue);
  }
  const avgDailyReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDailyReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyReturn) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = stdDailyReturn > 0 ? (avgDailyReturn / stdDailyReturn) * Math.sqrt(252) : 0;

  // Max drawdown
  const maxDDEntry = dailySnapshots.reduce((worst, s) => s.drawdownPct > worst.drawdownPct ? s : worst, { drawdownPct: 0, date: "" });

  // Consecutive wins/losses
  let maxConsW = 0, maxConsL = 0, consW = 0, consL = 0;
  for (const t of trades) {
    if (t.pnl > 0) { consW++; consL = 0; maxConsW = Math.max(maxConsW, consW); }
    else { consL++; consW = 0; maxConsL = Math.max(maxConsL, consL); }
  }

  // Correlation to Nifty 50
  const portfolioReturns = dailyReturns;
  const niftyReturns: number[] = [];
  for (let i = 1; i < dailySnapshots.length; i++) {
    const prev = dailySnapshots[i-1].niftyClose;
    const curr = dailySnapshots[i].niftyClose;
    niftyReturns.push(prev > 0 ? (curr - prev) / prev : 0);
  }
  const correlation = pearsonCorrelation(portfolioReturns, niftyReturns);

  const summary: BacktestSummary = {
    initialCapital: CAPITAL,
    finalPortfolioValue: Math.round(finalValue),
    totalReturn: Math.round(totalReturn),
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    annualizedReturnPct: Math.round(annualizedReturn * 100) / 100,
    totalTrades: trades.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winningPct: trades.length > 0 ? Math.round((winners.length / trades.length) * 10000) / 100 : 0,
    highestWinPct: highestWin ? Math.round(highestWin.pnlPct * 100) / 100 : 0,
    highestWinSymbol: highestWin ? highestWin.symbol : "—",
    highestLossPct: highestLoss ? Math.round(highestLoss.pnlPct * 100) / 100 : 0,
    highestLossSymbol: highestLoss ? highestLoss.symbol : "—",
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    avgWinToLossRatio: avgLossPct > 0 ? Math.round((avgWinPct / avgLossPct) * 100) / 100 : avgWinPct > 0 ? Infinity : 0,
    avgTradeDurationDays: trades.length > 0 ? Math.round((trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length) * 10) / 10 : 0,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    maxDrawdownPct: Math.round(maxDDEntry.drawdownPct * 100) / 100,
    maxDrawdownDate: maxDDEntry.date || "",
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 999 : 0,
    maxConsecutiveWins: maxConsW,
    maxConsecutiveLosses: maxConsL,
    correlationToNifty: Math.round(correlation * 100) / 100,
    maxPositions: MAX_POS,
    positionSizePct: Math.round((100 / MAX_POS) * 100) / 100,
    capitalPerTrade: Math.round(CAPITAL / MAX_POS),
    totalDays: totalDays,
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };

  console.log(`[Backtest] ${yearsLabel}yr complete: ${trades.length} trades, ${summary.totalReturnPct}% return, ${summary.winningPct}% win rate, ${summary.annualizedReturnPct}% annualized`);

  return {
    trades: trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
    dailySnapshots,
    summary,
    period: { from: startStr, to: sortedDates[sortedDates.length - 1] || to },
  };
}

// Cache
let cachedBacktest: BacktestResult | null = null;
let backtestCacheTime = 0;

export async function getBacktestResult(params?: {
  capitalRs?: number; maxPositions?: number; lookbackYears?: number;
}): Promise<BacktestResult> {
  const now = Date.now();
  if (cachedBacktest && now - backtestCacheTime < 3600000) return cachedBacktest;
  cachedBacktest = await runBacktest(params || {});
  backtestCacheTime = now;
  return cachedBacktest;
}

export function clearBacktestCache() {
  cachedBacktest = null;
  backtestCacheTime = 0;
}
