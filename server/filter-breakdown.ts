import { getKite, isAuthenticated, throttledKite } from "./kite";
import { NSE_UNIVERSE } from "./nse-universe";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

interface Bar {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

// ─── Types ───

export interface StockDayFilter {
  symbol: string;
  name: string;
  date: string;
  close: number;
  prevClose: number;
  changePct: number;
  dma200: number;
  aboveDma200: boolean;
  dropPct: number;
  dippedOver3: boolean;
  atr5: number;
  atrPctClose: number;
  passedVolFilter: boolean;
  limitPrice: number;
  nextDayLow: number | null;
  limitWouldFill: boolean;
  setupScore: number;
  profitTarget: number;
  passedAll: boolean;
  failReason: string;
  workings: string;
}

export interface FilterBreakdownResult {
  dates: string[];
  stocks: string[];
  data: StockDayFilter[];
  summary: {
    totalStockDays: number;
    passedDma200: number;
    passedDip: number;
    passedVol: number;
    passedAll: number;
    limitFilled: number;
  };
  dataSource: string;
}

// ─── Data fetching ───

let instrumentMap: Map<string, number> = new Map();

async function loadKiteInstruments() {
  if (instrumentMap.size > 0) return;
  try {
    const instruments = await throttledKite(k => k.getInstruments("NSE"));
    for (const inst of instruments) {
      if (inst.segment === "NSE" && inst.instrument_type === "EQ") {
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
      }
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
        if (data && data.length > 0) {
          return data.filter((d: any) => d.close > 0).map((d: any) => ({
            date: new Date(d.date).toISOString().split("T")[0],
            open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
          }));
        }
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

// ─── Main filter breakdown ───

export async function runFilterBreakdown(params: {
  lookbackDays?: number;
}): Promise<FilterBreakdownResult> {
  const LOOKBACK = params.lookbackDays || 30;
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - LOOKBACK - 320); // 200 DMA warmup (~320 calendar days = ~220 trading days)

  const from = fromDate.toISOString().split("T")[0];
  const to = toDate.toISOString().split("T")[0];

  const breakdownStart = new Date();
  breakdownStart.setDate(breakdownStart.getDate() - LOOKBACK);
  const startStr = breakdownStart.toISOString().split("T")[0];

  const useKite = isAuthenticated();
  console.log(`[FilterBreakdown] Fetching ${NSE_UNIVERSE.length} stocks, last ${LOOKBACK} days via ${useKite ? "Kite" : "Yahoo"}...`);

  // Fetch data
  const allBars: Map<string, Bar[]> = new Map();
  const batchSize = useKite ? 8 : 5;
  for (let i = 0; i < NSE_UNIVERSE.length; i += batchSize) {
    const batch = NSE_UNIVERSE.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (stock) => {
      const bars = await fetchBars(stock.symbol, from, to);
      if (bars && bars.length >= 200) allBars.set(stock.symbol, bars);
    }));
    if (i + batchSize < NSE_UNIVERSE.length) await new Promise(r => setTimeout(r, useKite ? 80 : 120));
    if ((i + batchSize) % 50 === 0) console.log(`[FilterBreakdown] ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length}...`);
  }

  console.log(`[FilterBreakdown] Data for ${allBars.size} stocks. Computing filters...`);

  // Build date index
  const allDates = new Set<string>();
  for (const bars of allBars.values()) {
    for (const b of bars) { if (b.date >= startStr) allDates.add(b.date); }
  }
  const sortedDates = Array.from(allDates).sort();

  // Bar index
  const barIndex: Map<string, Map<string, number>> = new Map();
  for (const [symbol, bars] of allBars.entries()) {
    const idx = new Map<string, number>();
    bars.forEach((b, i) => idx.set(b.date, i));
    barIndex.set(symbol, idx);
  }

  const data: StockDayFilter[] = [];
  let passedDma200 = 0, passedDip = 0, passedVol = 0, passedAll = 0, limitFilled = 0;

  for (const date of sortedDates) {
    const dateIdx = sortedDates.indexOf(date);
    const nextDate = dateIdx + 1 < sortedDates.length ? sortedDates[dateIdx + 1] : null;

    for (const [symbol, bars] of allBars.entries()) {
      const idxMap = barIndex.get(symbol);
      if (!idxMap) continue;
      const todayIdx = idxMap.get(date);
      if (todayIdx === undefined || todayIdx < 200) continue;

      const bar = bars[todayIdx];
      const prevBar = bars[todayIdx - 1];
      const name = NSE_UNIVERSE.find(s => s.symbol === symbol)?.name || symbol.replace(".NS", "");

      // 200 DMA
      const closes200 = bars.slice(todayIdx - 199, todayIdx + 1).map(b => b.close);
      const dma200 = closes200.reduce((s, c) => s + c, 0) / 200;
      const aboveDma200 = bar.close > dma200;

      // Drop %
      const changePct = ((bar.close - prevBar.close) / prevBar.close) * 100;
      const dropPct = ((prevBar.close - bar.close) / prevBar.close) * 100;
      const dippedOver3 = dropPct >= 3;

      // ATR(5)
      const atr5 = computeATR(bars, todayIdx, 5);
      const atrPctClose = atr5 > 0 ? (100 * atr5) / bar.close : 0;
      const passedVolFilter = atrPctClose > 3;

      // Limit price
      const limitPrice = bar.close - 0.9 * atr5;
      const setupScore = atr5 > 0 ? atr5 / bar.close : 0;
      const profitTarget = bar.close + 0.5 * atr5;

      // Next day fill check
      let nextDayLow: number | null = null;
      let limitWouldFill = false;
      if (nextDate) {
        const nextIdx = idxMap.get(nextDate);
        if (nextIdx !== undefined) {
          nextDayLow = bars[nextIdx].low;
          limitWouldFill = bars[nextIdx].low <= limitPrice;
        }
      }

      const passesAll = aboveDma200 && dippedOver3 && passedVolFilter;
      let failReason = "";
      if (!aboveDma200) failReason = "Below 200-DMA";
      else if (!dippedOver3) failReason = `Drop only ${dropPct.toFixed(1)}%`;
      else if (!passedVolFilter) failReason = `ATR% only ${atrPctClose.toFixed(1)}%`;
      else if (!limitWouldFill) failReason = "Limit not filled";
      else failReason = "—";

      // Detailed workings
      const w: string[] = [];
      w.push(`Close ₹${bar.close.toFixed(2)} ${aboveDma200 ? '>' : '<'} 200-DMA ₹${dma200.toFixed(2)} → ${aboveDma200 ? 'PASS ✓' : 'FAIL ✗'}`);
      if (aboveDma200) {
        w.push(`Prev Close ₹${prevBar.close.toFixed(2)} → Today ₹${bar.close.toFixed(2)} = ${dropPct.toFixed(2)}% drop ${dippedOver3 ? '> 3% → PASS ✓' : '< 3% → FAIL ✗'}`);
      }
      if (aboveDma200 && dippedOver3) {
        w.push(`ATR(5) = ₹${atr5.toFixed(2)}, ATR% = 100 × ${atr5.toFixed(2)} / ${bar.close.toFixed(2)} = ${atrPctClose.toFixed(2)}% ${passedVolFilter ? '> 3% → PASS ✓' : '≤ 3% → FAIL ✗'}`);
      }
      if (aboveDma200 && dippedOver3 && passedVolFilter) {
        w.push(`Limit = ₹${bar.close.toFixed(2)} − 0.9 × ₹${atr5.toFixed(2)} = ₹${limitPrice.toFixed(2)}`);
        w.push(`Score = ATR(5)/Close = ${atr5.toFixed(2)}/${bar.close.toFixed(2)} = ${(setupScore * 100).toFixed(2)}`);
        w.push(`Profit Target = ₹${bar.close.toFixed(2)} + 0.5 × ₹${atr5.toFixed(2)} = ₹${profitTarget.toFixed(2)}`);
        if (nextDayLow !== null) {
          w.push(`Next day low = ₹${nextDayLow.toFixed(2)} ${limitWouldFill ? '≤' : '>'} Limit ₹${limitPrice.toFixed(2)} → ${limitWouldFill ? 'FILLED ✓' : 'NOT FILLED ✗'}`);
        } else {
          w.push('Next day data unavailable');
        }
      }
      const workings = w.join('\n');

      if (aboveDma200) passedDma200++;
      if (aboveDma200 && dippedOver3) passedDip++;
      if (aboveDma200 && dippedOver3 && passedVolFilter) passedVol++;
      if (passesAll) passedAll++;
      if (passesAll && limitWouldFill) limitFilled++;

      data.push({
        symbol: symbol.replace(".NS", ""),
        name,
        date,
        close: Math.round(bar.close * 100) / 100,
        prevClose: Math.round(prevBar.close * 100) / 100,
        changePct: Math.round(changePct * 100) / 100,
        dma200: Math.round(dma200 * 100) / 100,
        aboveDma200,
        dropPct: Math.round(dropPct * 100) / 100,
        dippedOver3,
        atr5: Math.round(atr5 * 100) / 100,
        atrPctClose: Math.round(atrPctClose * 100) / 100,
        passedVolFilter,
        limitPrice: Math.round(limitPrice * 100) / 100,
        nextDayLow: nextDayLow !== null ? Math.round(nextDayLow * 100) / 100 : null,
        limitWouldFill,
        setupScore: Math.round(setupScore * 10000) / 10000,
        profitTarget: Math.round(profitTarget * 100) / 100,
        passedAll: passesAll && limitWouldFill,
        failReason,
        workings,
      });
    }
  }

  const stockList = [...new Set(data.map(d => d.symbol))].sort();
  console.log(`[FilterBreakdown] Done: ${data.length} stock-days, ${passedAll} passed all filters, ${limitFilled} limit fills`);

  return {
    dates: sortedDates,
    stocks: stockList,
    data,
    summary: {
      totalStockDays: data.length,
      passedDma200,
      passedDip,
      passedVol,
      passedAll,
      limitFilled,
    },
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };
}

// Cache
let cachedBreakdown: FilterBreakdownResult | null = null;
let breakdownCacheTime = 0;

export async function getFilterBreakdown(params?: { lookbackDays?: number }): Promise<FilterBreakdownResult> {
  const now = Date.now();
  if (cachedBreakdown && now - breakdownCacheTime < 3600000) return cachedBreakdown;
  cachedBreakdown = await runFilterBreakdown(params || {});
  breakdownCacheTime = now;
  return cachedBreakdown;
}

export function clearFilterBreakdownCache() {
  cachedBreakdown = null;
  breakdownCacheTime = 0;
}
