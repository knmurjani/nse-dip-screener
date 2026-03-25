import { NSE_UNIVERSE } from "./nse-universe";
import { getKite, isAuthenticated, markKiteFailed, throttledKite } from "./kite";
import type { ScreenerStock, UniverseStock } from "@shared/schema";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }

// ─── Instrument cache ───
let instrumentMap: Map<string, number> = new Map();
let instrumentsLoaded = false;

async function loadInstruments() {
  if (instrumentsLoaded) return;
  try {
    const instruments = await throttledKite(k => k.getInstruments("NSE"));
    for (const inst of instruments)
      if (inst.segment === "NSE" && inst.instrument_type === "EQ")
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
    instrumentsLoaded = true;
  } catch (e: any) { markKiteFailed(e.message); }
}

// ─── Data fetching (same as ATR screener) ───

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  if (isAuthenticated()) {
    try {
      await loadInstruments();
      const clean = symbol.replace(".NS", "");
      const token = instrumentMap.get(clean);
      if (token) {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 60); // 60 days for 20-day MA + buffer
        const data = await throttledKite(k => k.getHistoricalData(token, "day", start.toISOString().split("T")[0], end.toISOString().split("T")[0]));
        if (data && data.length > 0)
          return data.filter((d: any) => d.close > 0).map((d: any) => ({
            date: new Date(d.date).toISOString().split("T")[0],
            open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
          }));
      }
    } catch {}
  }
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 60);
    const result = await yahooFinance.chart(symbol, { period1: start, period2: end, interval: "1d" });
    if (!result?.quotes) return null;
    return result.quotes.filter((q: any) => q.close !== null && q.close > 0)
      .map((q: any) => ({
        date: new Date(q.date).toISOString().split("T")[0],
        open: q.open ?? q.close, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
      }));
  } catch { return null; }
}

async function fetchQuote(symbol: string): Promise<{
  price: number; prevClose: number; marketCap: number; name: string;
} | null> {
  const clean = symbol.replace(".NS", "");
  if (isAuthenticated() && instrumentsLoaded) {
    try {
      const quotes = await throttledKite(k => k.getQuote([`NSE:${clean}`]));
      const q = quotes[`NSE:${clean}`];
      if (q?.last_price) return {
        price: q.last_price, prevClose: q.ohlc?.close || q.last_price,
        marketCap: 0, name: clean,
      };
    } catch {}
  }
  try {
    const q = await yahooFinance.quote(clean + ".NS");
    if (q?.regularMarketPrice) return {
      price: q.regularMarketPrice, prevClose: q.regularMarketPreviousClose || q.regularMarketPrice,
      marketCap: (q.marketCap ?? 0) / 1e7, name: q.shortName || q.longName || clean,
    };
  } catch {}
  return null;
}

// ─── Bollinger Band calculations ───

function computeSMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  return closes.slice(-period).reduce((s, c) => s + c, 0) / period;
}

function computeStdDev(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, c) => s + c, 0) / period;
  const variance = slice.reduce((s, c) => s + (c - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

// ─── Bollinger Bounce Signal ───

export interface BollingerSignal {
  symbol: string;
  name: string;
  close: number;
  prevClose: number;
  changePct: number;
  ma20: number;
  stdDev: number;
  upperBand2: number;  // +2σ
  lowerBand2: number;  // −2σ
  lowerBand3: number;  // −3σ
  zScore: number;      // how many σ below mean
  belowMinus2: boolean;    // currently below −2σ
  crossedAboveMinus2: boolean; // was below, now above (BUY signal)
  distanceToMeanPct: number;  // potential upside to mean
  stopLossPrice: number;     // −3σ
  targetPrice: number;       // mean (20-day MA)
  setupScore: number;        // distance below mean — deeper = higher conviction
  marketCap: number;
  status: string;  // "watchlist" | "signal" | "neutral"
}

export interface BollingerScreenerResult {
  lastUpdated: string;
  signals: BollingerSignal[];      // crossed above −2σ → BUY
  watchlist: BollingerSignal[];    // below −2σ → watching
  universe: BollingerSignal[];     // all stocks with Bollinger data
  stats: {
    totalScanned: number;
    belowMinus2: number;
    crossedAbove: number;
    signalsGenerated: number;
  };
  dataSource: string;
}

// ─── Cache ───
let cachedResult: BollingerScreenerResult | null = null;
let lastFetchTime = 0;
const CACHE_DURATION = 10 * 60 * 1000;

export async function runBollingerScreener(): Promise<BollingerScreenerResult> {
  const now = Date.now();
  if (cachedResult && now - lastFetchTime < CACHE_DURATION) return cachedResult;

  const useKite = isAuthenticated();
  console.log(`[Bollinger] Starting scan of ${NSE_UNIVERSE.length} stocks via ${useKite ? "Kite" : "Yahoo"}...`);

  const signals: BollingerSignal[] = [];
  const watchlist: BollingerSignal[] = [];
  const universe: BollingerSignal[] = [];
  let totalScanned = 0, belowMinus2Count = 0, crossedAboveCount = 0;

  const batchSize = useKite ? 8 : 5;
  for (let i = 0; i < NSE_UNIVERSE.length; i += batchSize) {
    const batch = NSE_UNIVERSE.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (stock) => {
      try {
        const [bars, quote] = await Promise.all([fetchBars(stock.symbol), fetchQuote(stock.symbol)]);
        if (!bars || bars.length < 22 || !quote) return;

        totalScanned++;
        const closes = bars.map(b => b.close);
        const ma20 = computeSMA(closes, 20);
        const stdDev = computeStdDev(closes, 20);
        if (ma20 === 0 || stdDev === 0) return;

        const close = quote.price;
        const prevClose = quote.prevClose;
        const changePct = ((close - prevClose) / prevClose) * 100;
        const lowerBand2 = ma20 - 2 * stdDev;
        const lowerBand3 = ma20 - 3 * stdDev;
        const upperBand2 = ma20 + 2 * stdDev;
        const zScore = (close - ma20) / stdDev;
        const belowMinus2 = close < lowerBand2;
        const distanceToMeanPct = ((ma20 - close) / close) * 100;

        // Check if it crossed above −2σ today (was below yesterday, above today)
        const prevCloseVal = bars.length >= 2 ? bars[bars.length - 2].close : prevClose;
        const prevMa20 = bars.length >= 22 ? computeSMA(bars.slice(0, -1).map(b => b.close), 20) : ma20;
        const prevStd = bars.length >= 22 ? computeStdDev(bars.slice(0, -1).map(b => b.close), 20) : stdDev;
        const prevLower2 = prevMa20 - 2 * prevStd;
        const crossedAboveMinus2 = prevCloseVal < prevLower2 && close >= lowerBand2;

        let status = "neutral";
        if (crossedAboveMinus2) { status = "signal"; crossedAboveCount++; }
        else if (belowMinus2) { status = "watchlist"; belowMinus2Count++; }

        const signal: BollingerSignal = {
          symbol: stock.symbol.replace(".NS", ""),
          name: quote.name || stock.name,
          close: Math.round(close * 100) / 100,
          prevClose: Math.round(prevClose * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          ma20: Math.round(ma20 * 100) / 100,
          stdDev: Math.round(stdDev * 100) / 100,
          upperBand2: Math.round(upperBand2 * 100) / 100,
          lowerBand2: Math.round(lowerBand2 * 100) / 100,
          lowerBand3: Math.round(lowerBand3 * 100) / 100,
          zScore: Math.round(zScore * 100) / 100,
          belowMinus2,
          crossedAboveMinus2,
          distanceToMeanPct: Math.round(distanceToMeanPct * 100) / 100,
          stopLossPrice: Math.round(lowerBand3 * 100) / 100,
          targetPrice: Math.round(ma20 * 100) / 100,
          setupScore: Math.round(Math.abs(distanceToMeanPct) * 100) / 100, // deeper dip = higher score
          marketCap: Math.round(quote.marketCap),
          status,
        };

        universe.push(signal);
        if (status === "signal") signals.push(signal);
        else if (status === "watchlist") watchlist.push(signal);
      } catch {}
    }));

    if (i + batchSize < NSE_UNIVERSE.length) await new Promise(r => setTimeout(r, useKite ? 80 : 120));
    if ((i + batchSize) % 100 === 0) console.log(`[Bollinger] ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length}...`);
  }

  // Sort by setup score (deepest dip first)
  signals.sort((a, b) => b.setupScore - a.setupScore);
  watchlist.sort((a, b) => b.setupScore - a.setupScore);
  universe.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  cachedResult = {
    lastUpdated: new Date().toISOString(),
    signals, watchlist, universe,
    stats: { totalScanned, belowMinus2: belowMinus2Count, crossedAbove: crossedAboveCount, signalsGenerated: signals.length },
    dataSource: useKite ? "Kite Connect" : "Yahoo Finance",
  };
  lastFetchTime = now;

  console.log(`[Bollinger] Done. ${totalScanned} scanned, ${belowMinus2Count} below −2σ, ${crossedAboveCount} signals.`);
  return cachedResult;
}

export function clearBollingerCache() {
  cachedResult = null;
  lastFetchTime = 0;
}
