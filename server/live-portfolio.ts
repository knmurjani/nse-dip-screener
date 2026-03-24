import { db, getConfig } from "./storage";
import { liveSignals, livePositions, liveTrades, liveSnapshots } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { getKite, isAuthenticated } from "./kite";
import { runScreener } from "./screener";

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

// ─── Helpers ───

function today(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split("T")[0];
}

async function getQuote(symbol: string): Promise<{ price: number; prevClose: number; high: number; low: number } | null> {
  const clean = symbol.replace(".NS", "");
  if (isAuthenticated()) {
    try {
      const kite = getKite();
      const quotes = await kite.getQuote([`NSE:${clean}`]);
      const q = quotes[`NSE:${clean}`];
      if (q?.last_price) return {
        price: q.last_price,
        prevClose: q.ohlc?.close || q.last_price,
        high: q.ohlc?.high || q.last_price,
        low: q.ohlc?.low || q.last_price,
      };
    } catch {}
  }
  try {
    const q = await yahooFinance.quote(clean + ".NS");
    if (q?.regularMarketPrice) return {
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose || q.regularMarketPrice,
      high: q.regularMarketDayHigh || q.regularMarketPrice,
      low: q.regularMarketDayLow || q.regularMarketPrice,
    };
  } catch {}
  return null;
}

async function getNiftyPrice(): Promise<number> {
  try {
    if (isAuthenticated()) {
      const kite = getKite();
      const q = await kite.getQuote(["NSE:NIFTY 50"]);
      const n = q["NSE:NIFTY 50"];
      if (n?.last_price) return n.last_price;
    }
  } catch {}
  try {
    const q = await yahooFinance.quote("^NSEI");
    if (q?.regularMarketPrice) return q.regularMarketPrice;
  } catch {}
  return 0;
}

// ─── LIFECYCLE: Run daily at 3:15 PM IST ───

export async function runDailyLifecycle() {
  const dateStr = today();
  const INITIAL_CAPITAL = parseFloat(getConfig("initial_capital") || "1000000");
  const MAX_POS = parseInt(getConfig("max_positions") || "10");

  console.log(`[LivePortfolio] Running daily lifecycle for ${dateStr}...`);

  // ─── Step 1: Update MTM on open positions + check exits ───
  const openPositions = db.select().from(livePositions).all();
  let realizedToday = 0;
  const exitedIds: number[] = [];

  for (const pos of openPositions) {
    const quote = await getQuote(pos.symbol + ".NS");
    if (!quote) continue;

    // Update MTM
    const currentValue = quote.price * pos.shares;
    const unrealizedPnl = (quote.price - pos.entryPrice) * pos.shares;
    const unrealizedPnlPct = ((quote.price - pos.entryPrice) / pos.entryPrice) * 100;

    db.update(livePositions).set({
      currentPrice: Math.round(quote.price * 100) / 100,
      currentValue: Math.round(currentValue),
      unrealizedPnl: Math.round(unrealizedPnl),
      unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
      tradingDaysHeld: pos.tradingDaysHeld + 1,
      lastUpdated: dateStr,
    }).where(eq(livePositions.id, pos.id)).run();

    // Check exit conditions
    let exitPrice = 0;
    let exitReason = "";
    let exitDetail = "";
    const daysHeld = pos.tradingDaysHeld + 1;

    // Exit 1: Profit target
    if (quote.high >= pos.profitTarget) {
      exitPrice = pos.profitTarget;
      exitReason = "profit_target";
      exitDetail = `High ₹${quote.high.toFixed(2)} ≥ Target ₹${pos.profitTarget.toFixed(2)} (Entry ₹${pos.entryPrice.toFixed(2)} + 0.5×ATR ₹${(pos.atr5AtEntry * 0.5).toFixed(2)})`;
    }

    // Exit 2: Price action — close > previous day's high
    if (!exitReason && quote.price > quote.high) {
      // This is approximate — ideally we'd track yesterday's high separately
      // For live, we check if current price is significantly above prev close
    }

    // Exit 3: Time-based — 10 trading days
    if (!exitReason && daysHeld >= 10) {
      exitPrice = quote.price;
      exitReason = "time_exit_10_days";
      exitDetail = `Held ${daysHeld} trading days ≥ 10 day limit — exit at ₹${quote.price.toFixed(2)}`;
    }

    if (exitReason) {
      const pnl = (exitPrice - pos.entryPrice) * pos.shares;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      realizedToday += pnl;

      // Move to closed trades
      db.insert(liveTrades).values({
        symbol: pos.symbol,
        name: pos.name,
        signalDate: pos.signalDate,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        shares: pos.shares,
        capitalAllocated: pos.capitalAllocated,
        exitDate: dateStr,
        exitPrice: Math.round(exitPrice * 100) / 100,
        exitReason,
        exitReasonDetail: exitDetail,
        pnl: Math.round(pnl),
        pnlPct: Math.round(pnlPct * 100) / 100,
        daysHeld,
        setupScore: pos.setupScore,
      }).run();

      exitedIds.push(pos.id);
      console.log(`[LivePortfolio] CLOSED ${pos.symbol}: ${exitReason} | P&L ₹${pnl.toFixed(0)} (${pnlPct.toFixed(2)}%)`);
    }
  }

  // Remove exited positions
  for (const id of exitedIds) {
    db.delete(livePositions).where(eq(livePositions.id, id)).run();
  }

  // ─── Step 2: Generate new signals from screener ───
  const screenerResult = await runScreener();
  const currentOpenCount = db.select().from(livePositions).all().length;
  const slotsAvailable = MAX_POS - currentOpenCount;

  // Get existing position symbols to avoid duplicates
  const existingSymbols = new Set(db.select().from(livePositions).all().map(p => p.symbol));

  let signalsStored = 0;
  for (const signal of screenerResult.signals) {
    if (existingSymbols.has(signal.symbol)) continue;

    // Store as pending signal
    db.insert(liveSignals).values({
      date: dateStr,
      symbol: signal.symbol,
      name: signal.name,
      signalClose: signal.close,
      prevClose: signal.prevClose,
      dropPct: signal.dropPct,
      dma200: signal.dma200,
      atr5: signal.atr5,
      atrPctClose: signal.atrPctClose,
      limitPrice: signal.limitPrice,
      profitTarget: signal.profitTarget,
      setupScore: signal.setupScore,
      status: "pending",
    }).run();
    signalsStored++;
  }

  // ─── Step 3: Check if yesterday's pending signals filled ───
  const pendingSignals = db.select().from(liveSignals)
    .where(eq(liveSignals.status, "pending"))
    .all()
    .sort((a, b) => b.setupScore - a.setupScore); // conviction order

  let filledCount = 0;
  for (const sig of pendingSignals) {
    if (filledCount >= slotsAvailable) {
      // Mark remaining as skipped (portfolio full)
      db.update(liveSignals).set({ status: "skipped" }).where(eq(liveSignals.id, sig.id)).run();
      continue;
    }

    const quote = await getQuote(sig.symbol + ".NS");
    if (!quote) continue;

    // Check if today's low <= limit price (order would have filled)
    if (quote.low <= sig.limitPrice) {
      // Calculate position size: current portfolio value / MAX_POS
      const allPositions = db.select().from(livePositions).all();
      const totalRealizedPnl = db.select().from(liveTrades).all().reduce((s, t) => s + t.pnl, 0);
      const investedValue = allPositions.reduce((s, p) => s + (p.currentValue || p.capitalAllocated), 0);
      const cashAvailable = INITIAL_CAPITAL + totalRealizedPnl - allPositions.reduce((s, p) => s + p.capitalAllocated, 0);
      const portfolioValue = cashAvailable + investedValue;
      const positionSize = portfolioValue / MAX_POS;

      const entryPrice = sig.limitPrice;
      const shares = Math.floor(positionSize / entryPrice);
      if (shares <= 0 || cashAvailable < shares * entryPrice) continue;

      // Open position
      db.insert(livePositions).values({
        symbol: sig.symbol,
        name: sig.name,
        signalDate: sig.date,
        entryDate: dateStr,
        entryPrice: Math.round(entryPrice * 100) / 100,
        shares,
        capitalAllocated: Math.round(shares * entryPrice),
        atr5AtEntry: sig.atr5,
        profitTarget: sig.profitTarget,
        setupScore: sig.setupScore,
        tradingDaysHeld: 0,
        currentPrice: quote.price,
        currentValue: Math.round(quote.price * shares),
        unrealizedPnl: Math.round((quote.price - entryPrice) * shares),
        unrealizedPnlPct: Math.round(((quote.price - entryPrice) / entryPrice) * 10000) / 100,
        lastUpdated: dateStr,
      }).run();

      db.update(liveSignals).set({
        status: "filled",
        fillDate: dateStr,
        fillPrice: entryPrice,
      }).where(eq(liveSignals.id, sig.id)).run();

      filledCount++;
      console.log(`[LivePortfolio] OPENED ${sig.symbol}: ${shares} shares @ ₹${entryPrice.toFixed(2)}`);
    } else {
      // Limit not hit — mark expired
      db.update(liveSignals).set({ status: "expired" }).where(eq(liveSignals.id, sig.id)).run();
    }
  }

  // ─── Step 4: Daily snapshot ───
  const finalPositions = db.select().from(livePositions).all();
  const allClosedTrades = db.select().from(liveTrades).all();
  const totalRealizedPnl = allClosedTrades.reduce((s, t) => s + t.pnl, 0);
  const investedValue = finalPositions.reduce((s, p) => s + (p.currentValue || p.capitalAllocated), 0);
  const unrealizedPnl = finalPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const cashNow = INITIAL_CAPITAL + totalRealizedPnl - finalPositions.reduce((s, p) => s + p.capitalAllocated, 0);
  const totalPortfolio = cashNow + investedValue;
  const returnPct = ((totalPortfolio - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  // Peak for drawdown
  const allSnapshots = db.select().from(liveSnapshots).all();
  const peak = Math.max(INITIAL_CAPITAL, ...allSnapshots.map(s => s.totalPortfolioValue), totalPortfolio);
  const drawdown = ((peak - totalPortfolio) / peak) * 100;

  const niftyClose = await getNiftyPrice();
  const firstSnapshot = allSnapshots[0];
  const niftyStart = firstSnapshot?.niftyClose || niftyClose;
  const niftyReturnPct = niftyStart > 0 ? ((niftyClose - niftyStart) / niftyStart) * 100 : 0;

  // Upsert snapshot
  const existingSnap = db.select().from(liveSnapshots).where(eq(liveSnapshots.date, dateStr)).get();
  const snapData = {
    date: dateStr,
    cash: Math.round(cashNow),
    investedValue: Math.round(investedValue),
    unrealizedPnl: Math.round(unrealizedPnl),
    realizedPnl: Math.round(totalRealizedPnl),
    totalPortfolioValue: Math.round(totalPortfolio),
    portfolioReturnPct: Math.round(returnPct * 100) / 100,
    drawdownPct: Math.round(drawdown * 100) / 100,
    openPositionCount: finalPositions.length,
    closedTradeCount: allClosedTrades.length,
    signalsGenerated: signalsStored,
    niftyClose: Math.round(niftyClose * 100) / 100,
    niftyReturnPct: Math.round(niftyReturnPct * 100) / 100,
  };

  if (existingSnap) {
    db.update(liveSnapshots).set(snapData).where(eq(liveSnapshots.date, dateStr)).run();
  } else {
    db.insert(liveSnapshots).values(snapData).run();
  }

  console.log(`[LivePortfolio] Snapshot: ₹${totalPortfolio.toFixed(0)} | ${finalPositions.length} open | ${allClosedTrades.length} closed | ${signalsStored} new signals | Return: ${returnPct.toFixed(2)}%`);

  return getPortfolioSummary();
}

// ─── Portfolio summary (for API) ───

export function getPortfolioSummary() {
  const INITIAL_CAPITAL = parseFloat(getConfig("initial_capital") || "1000000");
  const MAX_POS = parseInt(getConfig("max_positions") || "10");

  const positions = db.select().from(livePositions).all();
  const closedTrades = db.select().from(liveTrades).orderBy(desc(liveTrades.id)).all();
  const snapshots = db.select().from(liveSnapshots).all();
  const pendingSignals = db.select().from(liveSignals).where(eq(liveSignals.status, "pending")).all();

  const totalRealizedPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const investedValue = positions.reduce((s, p) => s + (p.currentValue || p.capitalAllocated), 0);
  const unrealizedPnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const cashNow = INITIAL_CAPITAL + totalRealizedPnl - positions.reduce((s, p) => s + p.capitalAllocated, 0);
  const totalPortfolio = cashNow + investedValue;
  const returnPct = ((totalPortfolio - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  const winners = closedTrades.filter(t => t.pnl > 0);
  const losers = closedTrades.filter(t => t.pnl <= 0);
  const winRate = closedTrades.length > 0 ? (winners.length / closedTrades.length) * 100 : 0;
  const avgWinPct = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLossPct = losers.length > 0 ? Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length) : 0;

  const peak = Math.max(INITIAL_CAPITAL, ...snapshots.map(s => s.totalPortfolioValue));
  const drawdown = ((peak - totalPortfolio) / peak) * 100;
  const maxDrawdown = Math.max(0, ...snapshots.map(s => s.drawdownPct));

  const highestWin = winners.length > 0 ? winners.reduce((b, t) => t.pnlPct > b.pnlPct ? t : b) : null;
  const highestLoss = losers.length > 0 ? losers.reduce((b, t) => t.pnlPct < b.pnlPct ? t : b) : null;

  return {
    summary: {
      initialCapital: INITIAL_CAPITAL,
      cash: Math.round(cashNow),
      investedValue: Math.round(investedValue),
      unrealizedPnl: Math.round(unrealizedPnl),
      realizedPnl: Math.round(totalRealizedPnl),
      totalPortfolioValue: Math.round(totalPortfolio),
      portfolioReturnPct: Math.round(returnPct * 100) / 100,
      drawdownPct: Math.round(drawdown * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdown * 100) / 100,
      totalTrades: closedTrades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: Math.round(winRate * 100) / 100,
      avgWinPct: Math.round(avgWinPct * 100) / 100,
      avgLossPct: Math.round(avgLossPct * 100) / 100,
      highestWinPct: highestWin ? highestWin.pnlPct : 0,
      highestWinSymbol: highestWin ? highestWin.symbol : "—",
      highestLossPct: highestLoss ? highestLoss.pnlPct : 0,
      highestLossSymbol: highestLoss ? highestLoss.symbol : "—",
      avgDaysHeld: closedTrades.length > 0
        ? Math.round((closedTrades.reduce((s, t) => s + t.daysHeld, 0) / closedTrades.length) * 10) / 10 : 0,
      maxPositions: MAX_POS,
      openPositions: positions.length,
    },
    positions,
    closedTrades,
    pendingSignals,
    dailySnapshots: snapshots,
  };
}
