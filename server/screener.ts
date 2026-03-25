import { NSE_UNIVERSE } from "./nse-universe";
import { getKite, isAuthenticated, markKiteFailed, throttledKite } from "./kite";
import type { ScreenerStock, UniverseStock } from "@shared/schema";

// Fallback: Yahoo Finance (when Kite not authenticated)
const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] })
  : YFClass;
console.log("[YF] Fallback initialized:", typeof yahooFinance.chart === "function" ? "OK" : "FAIL");

// ─── Instrument token cache (Kite uses numeric tokens, not symbols) ───
let instrumentMap: Map<string, number> = new Map();
let instrumentsLoaded = false;

async function loadInstruments() {
  if (instrumentsLoaded) return;
  try {
    const instruments = await throttledKite(k => k.getInstruments("NSE"));
    for (const inst of instruments) {
      if (inst.segment === "NSE" && inst.instrument_type === "EQ") {
        instrumentMap.set(inst.tradingsymbol, inst.instrument_token);
      }
    }
    instrumentsLoaded = true;
    console.log(`[Kite] Loaded ${instrumentMap.size} NSE equity instruments`);
  } catch (e: any) {
    console.error("[Kite] Failed to load instruments:", e.message);
    markKiteFailed();
  }
}

// ─── Technical indicator calculations ───

interface Bar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function computeATR(bars: Bar[], period: number): number {
  if (bars.length < period + 1) return 0;
  const recent = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function compute200DMA(bars: Bar[]): number {
  if (bars.length < 200) return 0;
  return bars.slice(-200).reduce((s, b) => s + b.close, 0) / 200;
}

// ─── Data fetchers: Kite Connect (primary) + Yahoo Finance (fallback) ───

async function fetchBarsKite(symbol: string): Promise<Bar[] | null> {
  try {
    const cleanSymbol = symbol.replace(".NS", "");
    const token = instrumentMap.get(cleanSymbol);
    if (!token) return null;

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 400);

    const data = await throttledKite(k => k.getHistoricalData(
      token,
      "day",
      from.toISOString().split("T")[0],
      to.toISOString().split("T")[0]
    ));

    if (!data || data.length < 10) return null;
    return data
      .filter((d: any) => d.close > 0)
      .map((d: any) => ({
        date: new Date(d.date),
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));
  } catch (e: any) {
    return null;
  }
}

async function fetchQuoteKite(symbol: string): Promise<{
  price: number; prevClose: number; marketCap: number; name: string;
} | null> {
  try {
    const cleanSymbol = symbol.replace(".NS", "");
    const quotes = await throttledKite(k => k.getQuote([`NSE:${cleanSymbol}`]));
    const q = quotes[`NSE:${cleanSymbol}`];
    if (!q || !q.last_price) return null;

    return {
      price: q.last_price,
      prevClose: q.ohlc?.close || q.last_price,
      marketCap: 0, // Kite doesn't provide mcap — we'll skip this filter or use a separate source
      name: cleanSymbol,
    };
  } catch {
    return null;
  }
}

async function fetchBarsYahoo(symbol: string): Promise<Bar[] | null> {
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 400);
    const result = await yahooFinance.chart(symbol, {
      period1: start, period2: end, interval: "1d",
    });
    if (!result?.quotes || result.quotes.length < 10) return null;
    return result.quotes
      .filter((q: any) => q.close !== null && q.close > 0 && q.high !== null)
      .map((q: any) => ({
        date: new Date(q.date),
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

async function fetchQuoteYahoo(symbol: string): Promise<{
  price: number; prevClose: number; marketCap: number; name: string;
} | null> {
  try {
    const q = await yahooFinance.quote(symbol);
    if (!q?.regularMarketPrice) return null;
    return {
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose,
      marketCap: (q.marketCap ?? 0) / 1e7,
      name: q.shortName || q.longName || symbol.replace(".NS", ""),
    };
  } catch {
    return null;
  }
}

// ─── Main data fetcher (auto-selects Kite or Yahoo) ───

async function fetchBars(symbol: string): Promise<Bar[] | null> {
  if (isAuthenticated() && instrumentsLoaded) {
    try {
      const bars = await fetchBarsKite(symbol);
      if (bars && bars.length > 0) return bars;
    } catch {}
  }
  return fetchBarsYahoo(symbol);
}

async function fetchQuote(symbol: string): Promise<{
  price: number; prevClose: number; marketCap: number; name: string;
} | null> {
  if (isAuthenticated() && instrumentsLoaded) {
    try {
      const quote = await fetchQuoteKite(symbol);
      if (quote) return quote;
    } catch {}
  }
  return fetchQuoteYahoo(symbol);
}

// ─── Screener cache ───

let cachedResult: {
  signals: ScreenerStock[];
  universe: UniverseStock[];
  stats: { totalScanned: number; above200dma: number; dippedOver3pct: number; passedVolFilter: number; signalsGenerated: number; };
  lastUpdated: string;
  dataSource: string;
} | null = null;

let lastFetchTime = 0;
const CACHE_DURATION = 10 * 60 * 1000;

// ─── Main screener ───

export async function runScreener() {
  const now = Date.now();
  if (cachedResult && now - lastFetchTime < CACHE_DURATION) {
    return cachedResult;
  }

  const useKite = isAuthenticated();
  const dataSource = useKite ? "Kite Connect" : "Yahoo Finance";

  // Load Kite instruments if authenticated
  if (useKite && !instrumentsLoaded) {
    await loadInstruments();
  }

  console.log(`[Screener] Starting scan of ${NSE_UNIVERSE.length} stocks via ${dataSource}...`);

  const signals: ScreenerStock[] = [];
  const universe: UniverseStock[] = [];
  let above200dma = 0, dippedOver3pct = 0, passedVolFilter = 0, totalScanned = 0;

  const batchSize = useKite ? 8 : 5;

  for (let i = 0; i < NSE_UNIVERSE.length; i += batchSize) {
    const batch = NSE_UNIVERSE.slice(i, i + batchSize);

    await Promise.allSettled(
      batch.map(async (stock) => {
        try {
          const [bars, quote] = await Promise.all([
            fetchBars(stock.symbol),
            fetchQuote(stock.symbol),
          ]);
          if (!bars || !quote || bars.length < 200) return;

          // Market cap filter (skip if Kite — doesn't provide mcap)
          if (!useKite && quote.marketCap < 1000) return;

          totalScanned++;
          const dma200 = compute200DMA(bars);
          const atr5 = computeATR(bars, 5);
          if (atr5 === 0 || dma200 === 0) return;

          const close = quote.price;
          const prevClose = quote.prevClose;
          const changePct = ((close - prevClose) / prevClose) * 100;
          const atrPctClose = (100 * atr5) / close;
          const aboveDma200 = close > dma200;

          universe.push({
            symbol: stock.symbol.replace(".NS", ""),
            name: quote.name || stock.name,
            close: Math.round(close * 100) / 100,
            dma200: Math.round(dma200 * 100) / 100,
            aboveDma200,
            atr5: Math.round(atr5 * 100) / 100,
            atrPctClose: Math.round(atrPctClose * 100) / 100,
            marketCap: Math.round(quote.marketCap),
            changePct: Math.round(changePct * 100) / 100,
          });

          if (!aboveDma200) return;
          above200dma++;

          const dropPct = ((prevClose - close) / prevClose) * 100;
          if (dropPct < 3) return;
          dippedOver3pct++;

          if (atrPctClose <= 3) return;
          passedVolFilter++;

          const limitPrice = close - 0.9 * atr5;
          const setupScore = atr5 / close;
          const profitTarget = close + 0.5 * atr5;
          const exitDate = new Date();
          exitDate.setDate(exitDate.getDate() + 14);

          signals.push({
            symbol: stock.symbol.replace(".NS", ""),
            name: quote.name || stock.name,
            close: Math.round(close * 100) / 100,
            prevClose: Math.round(prevClose * 100) / 100,
            dropPct: Math.round(dropPct * 100) / 100,
            dma200: Math.round(dma200 * 100) / 100,
            aboveDma200: true,
            atr5: Math.round(atr5 * 100) / 100,
            atrPctClose: Math.round(atrPctClose * 100) / 100,
            limitPrice: Math.round(limitPrice * 100) / 100,
            setupScore: Math.round(setupScore * 10000) / 10000,
            marketCap: Math.round(quote.marketCap),
            profitTarget: Math.round(profitTarget * 100) / 100,
            timeExit: exitDate.toISOString().split("T")[0],
          });
        } catch {}
      })
    );

    if (i + batchSize < NSE_UNIVERSE.length) {
      await new Promise((r) => setTimeout(r, useKite ? 100 : 150));
    }
    if ((i + batchSize) % 25 === 0 || i + batchSize >= NSE_UNIVERSE.length) {
      console.log(`[Screener] ${Math.min(i + batchSize, NSE_UNIVERSE.length)} / ${NSE_UNIVERSE.length}...`);
    }
  }

  signals.sort((a, b) => b.setupScore - a.setupScore);
  universe.sort((a, b) => b.marketCap - a.marketCap);

  cachedResult = {
    signals, universe,
    stats: { totalScanned, above200dma, dippedOver3pct, passedVolFilter, signalsGenerated: signals.length },
    lastUpdated: new Date().toISOString(),
    dataSource,
  };
  lastFetchTime = now;

  console.log(`[Screener] Done via ${dataSource}. ${totalScanned} scanned, ${signals.length} signals.`);
  return cachedResult;
}

export function clearCache() {
  cachedResult = null;
  lastFetchTime = 0;
}
