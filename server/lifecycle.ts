/**
 * Daily Strategy Lifecycle Engine
 * Manages signal generation, order placement, position management, and snapshots.
 * Supports both paper and real money modes.
 */

import Database from "better-sqlite3";
import {
  DB_PATH, istNow, logSystem, getDeployment, getActiveDeployments,
  getDeploymentPositions, getDeploymentTrades, getDeploymentSnapshots,
  insertOrder, updateOrderStatus, getOrdersLog,
} from "./storage";
import { getKite, isAuthenticated, getKiteStatus } from "./kite";
import { runScreener, clearCache } from "./screener";
import { runBollingerScreener, clearBollingerCache } from "./screener-bollinger";
import { getStrategy } from "./strategies";
import {
  sendTradeAlert, sendMorningBrief, sendDailyPnLSummary,
  sendKiteDisconnectWarning, sendOrderUpdate, sendWatchlistUpdate,
  sendRiskAlert, sendSystemAlert,
} from "./telegram";

// ─── Order Retry with Exponential Backoff ───

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff in ms

async function placeKiteOrderWithRetry(
  kite: any,
  orderParams: any,
  retries: number = MAX_RETRIES
): Promise<{ order_id: string } | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await kite.placeOrder("regular", orderParams);
      return response;
    } catch (err: any) {
      const isRetryable =
        err.message?.includes("NetworkError") ||
        err.message?.includes("ETIMEDOUT") ||
        err.message?.includes("ECONNRESET") ||
        err.message?.includes("Too many requests") ||
        err.status === 429 ||
        err.status === 503;

      if (!isRetryable || attempt === retries - 1) throw err;

      console.log(`[Lifecycle] Order attempt ${attempt + 1} failed: ${err.message}, retrying in ${RETRY_DELAYS[attempt]}ms...`);
      logSystem("lifecycle", "order_retry", `${orderParams.tradingsymbol}: attempt ${attempt + 1} failed, retrying`);
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  return null;
}

// ─── Types ───

export interface LifecycleResult {
  deploymentId: number;
  date: string;
  signalsGenerated: number;
  entriesPlaced: number;
  exitsExecuted: number;
  snapshotTaken: boolean;
  errors: string[];
}

// ─── Helpers ───

const yfRaw = require("yahoo-finance2");
const YFClass = yfRaw.default || yfRaw;
const yahooFinance = typeof YFClass === "function"
  ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;

function todayIST(): string {
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
    } catch { /* fall through to Yahoo */ }
  }
  try {
    const q = await yahooFinance.quote(clean + ".NS");
    if (q?.regularMarketPrice) return {
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose || q.regularMarketPrice,
      high: q.regularMarketDayHigh || q.regularMarketPrice,
      low: q.regularMarketDayLow || q.regularMarketPrice,
    };
  } catch { /* no data */ }
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
  } catch { /* fall through */ }
  try {
    const q = await yahooFinance.quote("^NSEI");
    if (q?.regularMarketPrice) return q.regularMarketPrice;
  } catch { /* no data */ }
  return 0;
}

// ─── Instruments Cache ───

let instrumentsCache: any[] | null = null;
let instrumentsCacheTime = 0;
const INSTRUMENTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getCachedInstruments(): Promise<any[]> {
  if (instrumentsCache && Date.now() - instrumentsCacheTime < INSTRUMENTS_CACHE_TTL) {
    return instrumentsCache;
  }
  const kite = getKite();
  instrumentsCache = await kite.getInstruments("NSE");
  instrumentsCacheTime = Date.now();
  return instrumentsCache;
}

// ─── Bollinger Bands Computation ───

async function getBollingerBands(
  symbol: string,
  maPeriod: number = 20
): Promise<{ mean: number; upper2: number; lower2: number; upper3: number; lower3: number } | null> {
  try {
    const clean = symbol.replace(".NS", "");
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 60); // fetch 60 days to ensure we have maPeriod trading days

    let data: any[] = [];

    // Try Kite historical data first
    if (isAuthenticated()) {
      try {
        const kite = getKite();
        const instruments = await getCachedInstruments();
        const inst = instruments.find((i: any) => i.tradingsymbol === clean);
        if (inst) {
          data = await kite.getHistoricalData(inst.instrument_token, "day", startDate, endDate);
        }
      } catch { /* fall through to Yahoo */ }
    }

    // Fallback to Yahoo Finance
    if (data.length < maPeriod) {
      try {
        const result = await yahooFinance.chart(clean + ".NS", {
          period1: startDate, period2: endDate, interval: "1d"
        });
        data = result.quotes || [];
      } catch { return null; }
    }

    if (data.length < maPeriod) return null;

    // Get last maPeriod closing prices
    const closes = data.slice(-maPeriod).map((d: any) => d.close || d.Close).filter((v: any) => typeof v === "number" && !isNaN(v));
    if (closes.length < maPeriod) return null;

    const mean = closes.reduce((s: number, v: number) => s + v, 0) / closes.length;
    const variance = closes.reduce((s: number, v: number) => s + (v - mean) ** 2, 0) / closes.length;
    const stddev = Math.sqrt(variance);

    return {
      mean,
      upper2: mean + 2 * stddev,
      lower2: mean - 2 * stddev,
      upper3: mean + 3 * stddev,
      lower3: mean - 3 * stddev,
    };
  } catch {
    return null;
  }
}

// ─── Pre-Market Check (9:15 AM IST) ───

export async function runPreMarketCheck(deploymentId: number): Promise<void> {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment || deployment.status !== "active") return;

    logSystem("lifecycle", "pre_market_check", `Deployment #${deploymentId} pre-market check started`);

    // Check Kite connection
    const kiteStatus = getKiteStatus();
    if (!kiteStatus.connected) {
      logSystem("lifecycle", "kite_disconnected", `Kite disconnected during pre-market: ${kiteStatus.error}`);
      try { await sendKiteDisconnectWarning(kiteStatus.error); } catch {}
    }

    // Send morning brief
    try { await sendMorningBrief(deploymentId); } catch {}

    logSystem("lifecycle", "pre_market_check_done", `Deployment #${deploymentId} pre-market check completed`);
  } catch (error: any) {
    console.error(`[Lifecycle] Pre-market check error: ${error.message}`);
    logSystem("lifecycle", "pre_market_error", `Deployment #${deploymentId}: ${error.message}`);
  }
}

// ─── Main Daily Lifecycle (3:15 PM IST) ───

export async function runDeploymentLifecycle(deploymentId: number): Promise<LifecycleResult> {
  const dateStr = todayIST();
  const result: LifecycleResult = {
    deploymentId,
    date: dateStr,
    signalsGenerated: 0,
    entriesPlaced: 0,
    exitsExecuted: 0,
    snapshotTaken: false,
    errors: [],
  };

  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment) {
      result.errors.push("Deployment not found");
      return result;
    }
    if (deployment.status !== "active") {
      result.errors.push(`Deployment status is '${deployment.status}', skipping`);
      return result;
    }

    logSystem("lifecycle", "run_started", `Deployment #${deploymentId} '${deployment.name}' lifecycle started for ${dateStr}`);
    const sqliteDb = new Database(DB_PATH);
    const strategyDef = getStrategy(deployment.strategy_id);
    const strategyLabel = strategyDef?.name || deployment.strategy_id;

    // ─── Step 1: Check Kite connection ───
    const kiteStatus = getKiteStatus();
    if (!kiteStatus.connected && deployment.mode === "real") {
      logSystem("lifecycle", "kite_disconnected", `Kite not connected — skipping real trades for deployment #${deploymentId}`);
      try { await sendKiteDisconnectWarning(kiteStatus.error); } catch {}
      result.errors.push("Kite not connected — no real orders placed");
    }

    // ─── Step 2: Update MTM on open positions + check exits ───
    const openPositions = getDeploymentPositions(deploymentId);
    const exitedIds: number[] = [];

    for (const pos of openPositions) {
      try {
        const quote = await getQuote(pos.symbol);
        if (!quote) continue;

        const currentValue = quote.price * pos.quantity;
        const pnl = (quote.price - pos.entry_price) * pos.quantity;
        const pnlPct = ((quote.price - pos.entry_price) / pos.entry_price) * 100;
        const daysHeld = (pos.trading_days_held || 0) + 1;
        const peakPrice = Math.max(pos.peak_price || pos.entry_price, quote.high);

        // Update position
        sqliteDb.prepare(`
          UPDATE deployment_positions SET
            current_price = ?, current_value = ?, pnl = ?, pnl_pct = ?,
            trading_days_held = ?, peak_price = ?, last_updated = ?
          WHERE id = ?
        `).run(
          Math.round(quote.price * 100) / 100,
          Math.round(currentValue),
          Math.round(pnl),
          Math.round(pnlPct * 100) / 100,
          daysHeld, Math.round(peakPrice * 100) / 100,
          dateStr, pos.id
        );

        // ─── Check exit conditions ───
        let exitPrice = 0;
        let exitReason = "";
        let exitDetail = "";

        // Strategy-specific exit checks based on strategy type
        if (deployment.strategy_id === "atr_dip_buyer") {
          // Profit target: entry + 0.5 * ATR
          const profitTarget = pos.setup_score
            ? pos.entry_price + (pos.setup_score * pos.entry_price * 0.5)
            : pos.entry_price * 1.005;
          if (quote.high >= profitTarget) {
            exitPrice = profitTarget;
            exitReason = "profit_target";
            exitDetail = `High ₹${quote.high.toFixed(2)} ≥ Target ₹${profitTarget.toFixed(2)}`;
          }
          // Time exit
          if (!exitReason && deployment.max_hold_days > 0 && daysHeld >= deployment.max_hold_days) {
            exitPrice = quote.price;
            exitReason = `time_exit_${deployment.max_hold_days}_days`;
            exitDetail = `Held ${daysHeld} days ≥ ${deployment.max_hold_days} day limit`;
          }
        } else {
          // Bollinger strategies — check actual band levels
          const bands = await getBollingerBands(pos.symbol, deployment.ma_period || 20);
          if (bands) {
            // σ = (upper2 - mean) / 2, so target = mean + target_band_sigma * σ
            const oneSigma = (bands.upper2 - bands.mean) / 2;
            const targetSigma = deployment.target_band_sigma ?? 0; // 0 = mean, 2 = upper 2σ
            const targetPrice = bands.mean + targetSigma * oneSigma;

            if (quote.price >= targetPrice) {
              exitPrice = quote.price;
              exitReason = "sigma_target";
              exitDetail = `Price ₹${quote.price.toFixed(2)} ≥ Target (${targetSigma > 0 ? `+${targetSigma}σ` : "Mean"} = ₹${targetPrice.toFixed(2)})`;
            }

            // Stop loss: price drops below stop sigma band
            if (!exitReason && deployment.stop_loss_sigma) {
              const stopPrice = bands.mean - deployment.stop_loss_sigma * oneSigma;
              if (quote.low <= stopPrice) {
                exitPrice = quote.price;  // Use actual current price, consistent with backtest fix
                exitReason = "sigma_stop";
                exitDetail = `Low ₹${quote.low.toFixed(2)} ≤ Stop (−${deployment.stop_loss_sigma}σ = ₹${stopPrice.toFixed(2)})`;
              }
            }
          }

          // Time exit (fallback)
          if (!exitReason && deployment.max_hold_days > 0 && daysHeld >= deployment.max_hold_days) {
            exitPrice = quote.price;
            exitReason = `time_exit_${deployment.max_hold_days}_days`;
            exitDetail = `Held ${daysHeld} days ≥ ${deployment.max_hold_days} day limit`;
          }
        }

        // Absolute stop loss
        if (!exitReason && deployment.absolute_stop_pct) {
          const stopPrice = pos.entry_price * (1 - deployment.absolute_stop_pct / 100);
          if (quote.low <= stopPrice) {
            exitPrice = stopPrice;
            exitReason = "absolute_stop";
            exitDetail = `Low ₹${quote.low.toFixed(2)} ≤ Stop ₹${stopPrice.toFixed(2)} (−${deployment.absolute_stop_pct}%)`;
          }
        }

        // Trailing stop loss
        if (!exitReason && deployment.trailing_stop_pct && peakPrice > 0) {
          const trailStop = peakPrice * (1 - deployment.trailing_stop_pct / 100);
          if (quote.low <= trailStop) {
            exitPrice = trailStop;
            exitReason = "trailing_stop";
            exitDetail = `Low ₹${quote.low.toFixed(2)} ≤ Trail Stop ₹${trailStop.toFixed(2)} (peak ₹${peakPrice.toFixed(2)} −${deployment.trailing_stop_pct}%)`;
          }
        }

        if (exitReason) {
          const exitPnl = (exitPrice - pos.entry_price) * pos.quantity;
          const exitPnlPct = ((exitPrice - pos.entry_price) / pos.entry_price) * 100;
          const exitValue = exitPrice * pos.quantity;
          const now = istNow();

          // Record trade
          sqliteDb.prepare(`
            INSERT INTO deployment_trades (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, exit_date, exit_time, exit_price, exit_value, pnl, pnl_pct, days_held, exit_reason, exit_reason_detail, setup_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            deploymentId, pos.symbol, pos.name, pos.direction,
            pos.signal_date, pos.entry_date, pos.entry_time,
            pos.entry_price, pos.quantity, pos.entry_value,
            dateStr, now, Math.round(exitPrice * 100) / 100, Math.round(exitValue),
            Math.round(exitPnl), Math.round(exitPnlPct * 100) / 100,
            daysHeld, exitReason, exitDetail, pos.setup_score
          );

          // Log order for exit
          insertOrder({
            deployment_id: deploymentId,
            symbol: pos.symbol,
            order_type: deployment.mode === "paper" ? "MARKET" : "MARKET",
            transaction_type: "SELL",
            quantity: pos.quantity,
            price: exitPrice,
            status: "COMPLETE",
            fill_price: exitPrice,
            fill_quantity: pos.quantity,
            strategy: deployment.strategy_id,
            signal_data: JSON.stringify({ exitReason, exitDetail }),
          });

          // Update deployment stats
          sqliteDb.prepare(`
            UPDATE deployments SET
              total_trades = total_trades + 1,
              winning_trades = winning_trades + ?,
              realized_pnl = realized_pnl + ?,
              current_capital = current_capital + ?
            WHERE id = ?
          `).run(exitPnl > 0 ? 1 : 0, Math.round(exitPnl), Math.round(exitValue), deploymentId);

          exitedIds.push(pos.id);
          result.exitsExecuted++;

          // Send Telegram
          try {
            await sendTradeAlert("EXIT", {
              symbol: pos.symbol,
              price: exitPrice,
              quantity: pos.quantity,
              strategy: strategyLabel,
              pnl: exitPnl,
              pnlPct: exitPnlPct,
              exitReason: exitReason.replace(/_/g, " "),
              daysHeld,
            });
          } catch {}

          // Check drawdown after exit
          try { await checkDrawdownAlert(deploymentId); } catch {}

          logSystem("lifecycle", "exit_executed", `${pos.symbol} ${exitReason} | P&L ₹${exitPnl.toFixed(0)} (${exitPnlPct.toFixed(2)}%)`);
        }
      } catch (err: any) {
        result.errors.push(`Exit check failed for ${pos.symbol}: ${err.message}`);
      }
    }

    // Remove exited positions
    for (const id of exitedIds) {
      sqliteDb.prepare("DELETE FROM deployment_positions WHERE id = ?").run(id);
    }

    // ─── Step 3: Generate new signals from screener ───
    let signals: any[] = [];
    try {
      if (deployment.strategy_id === "atr_dip_buyer") {
        clearCache();
        const screenerResult = await runScreener();
        signals = screenerResult.signals || [];
      } else {
        clearBollingerCache();
        const screenerResult = await runBollingerScreener();
        signals = screenerResult.signals || [];
      }
      result.signalsGenerated = signals.length;
    } catch (err: any) {
      result.errors.push(`Signal generation failed: ${err.message}`);
    }

    // ─── Step 4: Place entry orders ───
    const currentPositions = getDeploymentPositions(deploymentId);
    const slotsAvailable = deployment.max_positions - currentPositions.length;
    const existingSymbols = new Set(currentPositions.map((p: any) => p.symbol));

    // Get current portfolio value for position sizing
    const investedValue = currentPositions.reduce((s: number, p: any) => s + (p.current_value || p.entry_value), 0);
    const cashAvailable = deployment.current_capital;
    const portfolioValue = cashAvailable + investedValue;
    const positionSize = portfolioValue / deployment.max_positions;

    let entriesPlaced = 0;
    for (const signal of signals) {
      if (entriesPlaced >= slotsAvailable) break;
      const sym = signal.symbol?.replace(".NS", "") || signal.symbol;
      if (existingSymbols.has(sym) && !deployment.allow_parallel) continue;

      try {
        // Determine entry price based on strategy
        let entryPrice: number;
        if (deployment.strategy_id === "atr_dip_buyer") {
          entryPrice = signal.limitPrice || signal.close;
        } else {
          entryPrice = signal.close || signal.limitPrice;
        }

        const quantity = Math.floor(positionSize / entryPrice);
        if (quantity <= 0) continue;
        if (cashAvailable < quantity * entryPrice) continue;

        const now = istNow();
        const signalName = signal.name || sym;

        if (deployment.mode === "paper") {
          // Paper mode: simulate immediate fill
          sqliteDb.prepare(`
            INSERT INTO deployment_positions (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, current_price, current_value, pnl, pnl_pct, trading_days_held, peak_price, setup_score, last_updated)
            VALUES (?, ?, ?, 'LONG', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
          `).run(
            deploymentId, sym, signalName,
            dateStr, dateStr, now,
            Math.round(entryPrice * 100) / 100, quantity,
            Math.round(quantity * entryPrice),
            Math.round(entryPrice * 100) / 100,
            Math.round(quantity * entryPrice),
            Math.round(entryPrice * 100) / 100,
            signal.setupScore || null, dateStr
          );

          // Deduct entry value from deployment capital (exit path already adds it back)
          sqliteDb.prepare(
            "UPDATE deployments SET current_capital = current_capital - ? WHERE id = ?"
          ).run(Math.round(quantity * entryPrice), deploymentId);

          // Log order
          insertOrder({
            deployment_id: deploymentId,
            symbol: sym,
            order_type: "LIMIT",
            transaction_type: "BUY",
            quantity,
            price: entryPrice,
            status: "COMPLETE",
            fill_price: entryPrice,
            fill_quantity: quantity,
            strategy: deployment.strategy_id,
            signal_data: JSON.stringify(signal),
          });

          entriesPlaced++;
          existingSymbols.add(sym);

          // Send Telegram
          try {
            await sendTradeAlert("ENTRY", {
              symbol: sym,
              price: entryPrice,
              quantity,
              strategy: strategyLabel,
              limitPrice: signal.limitPrice,
            });
          } catch {}

          logSystem("lifecycle", "entry_paper", `${sym}: ${quantity} shares @ ₹${entryPrice.toFixed(2)} (paper)`);
        } else {
          // Real mode: place order via Kite API
          if (!kiteStatus.connected) continue;

          try {
            const kite = getKite();
            const orderParams: any = {
              exchange: "NSE",
              tradingsymbol: sym,
              transaction_type: "BUY",
              quantity,
              product: "CNC",
              order_type: "LIMIT",
              price: Math.round(entryPrice * 100) / 100,
            };

            const kiteResponse = await placeKiteOrderWithRetry(kite, orderParams);
            const kiteOrderId = kiteResponse?.order_id || null;

            // Log order as PLACED
            const orderId = insertOrder({
              deployment_id: deploymentId,
              symbol: sym,
              order_type: "LIMIT",
              transaction_type: "BUY",
              quantity,
              price: entryPrice,
              status: "PLACED",
              kite_order_id: kiteOrderId,
              strategy: deployment.strategy_id,
              signal_data: JSON.stringify(signal),
            });

            entriesPlaced++;

            // Send Telegram
            try {
              await sendOrderUpdate({
                symbol: sym,
                orderType: "LIMIT",
                transactionType: "BUY",
                price: entryPrice,
                quantity,
                status: "PLACED",
                kiteOrderId,
              });
            } catch {}

            logSystem("lifecycle", "entry_real", `${sym}: LIMIT BUY ${quantity} @ ₹${entryPrice.toFixed(2)} — Kite ID: ${kiteOrderId}`);
          } catch (err: any) {
            insertOrder({
              deployment_id: deploymentId,
              symbol: sym,
              order_type: "LIMIT",
              transaction_type: "BUY",
              quantity,
              price: entryPrice,
              status: "FAILED",
              strategy: deployment.strategy_id,
              signal_data: JSON.stringify(signal),
              error_message: err.message,
            });
            result.errors.push(`Kite order failed for ${sym}: ${err.message}`);
            logSystem("lifecycle", "entry_failed", `${sym}: ${err.message}`);
          }
        }
      } catch (err: any) {
        result.errors.push(`Entry failed for ${signal.symbol}: ${err.message}`);
      }
    }
    result.entriesPlaced = entriesPlaced;

    // Update last run date
    sqliteDb.prepare("UPDATE deployments SET last_run_date = ? WHERE id = ?").run(dateStr, deploymentId);

    logSystem("lifecycle", "run_completed", `Deployment #${deploymentId}: ${result.signalsGenerated} signals, ${result.entriesPlaced} entries, ${result.exitsExecuted} exits`);
  } catch (error: any) {
    result.errors.push(`Lifecycle error: ${error.message}`);
    logSystem("lifecycle", "run_error", `Deployment #${deploymentId}: ${error.message}`);
    console.error(`[Lifecycle] Error for deployment #${deploymentId}:`, error.message);
  }

  return result;
}

// ─── End-of-Day Summary (3:30 PM IST) ───

export async function runEndOfDaySummary(deploymentId: number): Promise<void> {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment || deployment.status !== "active") return;

    const dateStr = todayIST();
    const sqliteDb = new Database(DB_PATH);

    logSystem("lifecycle", "eod_summary_start", `Deployment #${deploymentId} end-of-day summary`);

    // Calculate snapshot
    const positions = getDeploymentPositions(deploymentId);
    const allTrades = getDeploymentTrades(deploymentId);
    const allSnapshots = getDeploymentSnapshots(deploymentId);

    const totalRealizedPnl = allTrades.reduce((s: number, t: any) => s + t.pnl, 0);
    const investedValue = positions.reduce((s: number, p: any) => s + (p.current_value || p.entry_value), 0);
    const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
    const cash = deployment.current_capital;
    const portfolioValue = cash + investedValue;
    const returnPct = ((portfolioValue - deployment.initial_capital) / deployment.initial_capital) * 100;

    // Peak for drawdown
    const peak = Math.max(deployment.initial_capital, ...allSnapshots.map((s: any) => s.portfolio_value), portfolioValue);
    const drawdownPct = ((peak - portfolioValue) / peak) * 100;

    // Nifty benchmark
    const niftyClose = await getNiftyPrice();
    const firstSnap = allSnapshots[0];
    const niftyStart = firstSnap?.nifty_close || niftyClose;
    const niftyReturnPct = niftyStart > 0 ? ((niftyClose - niftyStart) / niftyStart) * 100 : 0;

    // Upsert snapshot
    const existingSnap = sqliteDb.prepare(
      "SELECT id FROM deployment_snapshots WHERE deployment_id = ? AND date = ?"
    ).get(deploymentId, dateStr) as any;

    const snapValues = [
      deploymentId, dateStr,
      Math.round(portfolioValue), Math.round(cash),
      Math.round(investedValue), Math.round(unrealizedPnl),
      Math.round(totalRealizedPnl), positions.length,
      Math.round(returnPct * 100) / 100,
      Math.round(drawdownPct * 100) / 100,
      Math.round(niftyClose * 100) / 100,
      Math.round(niftyReturnPct * 100) / 100,
    ];

    if (existingSnap) {
      sqliteDb.prepare(`
        UPDATE deployment_snapshots SET
          portfolio_value = ?, cash = ?, invested_value = ?, unrealized_pnl = ?,
          realized_pnl = ?, open_positions = ?, return_pct = ?, drawdown_pct = ?,
          nifty_close = ?, nifty_return_pct = ?
        WHERE deployment_id = ? AND date = ?
      `).run(
        snapValues[2], snapValues[3], snapValues[4], snapValues[5],
        snapValues[6], snapValues[7], snapValues[8], snapValues[9],
        snapValues[10], snapValues[11], deploymentId, dateStr
      );
    } else {
      sqliteDb.prepare(`
        INSERT INTO deployment_snapshots (deployment_id, date, portfolio_value, cash, invested_value, unrealized_pnl, realized_pnl, open_positions, return_pct, drawdown_pct, nifty_close, nifty_return_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...snapValues);
    }

    // Update deployment drawdown
    const maxDrawdown = Math.max(drawdownPct, ...allSnapshots.map((s: any) => s.drawdown_pct || 0));
    sqliteDb.prepare("UPDATE deployments SET max_drawdown_pct = ?, unrealized_pnl = ? WHERE id = ?")
      .run(Math.round(maxDrawdown * 100) / 100, Math.round(unrealizedPnl), deploymentId);

    // Check drawdown alert
    try { await checkDrawdownAlert(deploymentId); } catch {}

    // Position reconciliation for real mode
    if (deployment.mode === "real") {
      try { await reconcilePositions(deploymentId); } catch {}
    }

    // Send daily summary via Telegram
    try { await sendDailyPnLSummary(deploymentId); } catch {}

    logSystem("lifecycle", "eod_summary_done", `Deployment #${deploymentId}: Portfolio ₹${portfolioValue.toFixed(0)} | Return ${returnPct.toFixed(2)}% | DD ${drawdownPct.toFixed(2)}%`);
  } catch (error: any) {
    console.error(`[Lifecycle] EOD summary error for deployment #${deploymentId}:`, error.message);
    logSystem("lifecycle", "eod_summary_error", `Deployment #${deploymentId}: ${error.message}`);
  }
}

// ─── Risk: Drawdown Alert ───

const DRAWDOWN_THRESHOLD_PCT = 10; // default -10%

async function checkDrawdownAlert(deploymentId: number): Promise<void> {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment) return;

    const snapshots = getDeploymentSnapshots(deploymentId);
    const positions = getDeploymentPositions(deploymentId);
    const trades = getDeploymentTrades(deploymentId);

    const investedValue = positions.reduce((s: number, p: any) => s + (p.current_value || p.entry_value), 0);
    const cash = deployment.current_capital;
    const currentValue = cash + investedValue;

    const peak = Math.max(deployment.initial_capital, ...snapshots.map((s: any) => s.portfolio_value));
    const drawdownPct = ((peak - currentValue) / peak) * 100;

    if (drawdownPct >= DRAWDOWN_THRESHOLD_PCT) {
      const details = `Portfolio drawdown: -${drawdownPct.toFixed(1)}% (threshold: -${DRAWDOWN_THRESHOLD_PCT}%)\nPeak: ₹${peak.toLocaleString("en-IN")} | Current: ₹${currentValue.toLocaleString("en-IN")}`;
      await sendRiskAlert("DRAWDOWN", details);
      logSystem("risk", "drawdown_alert", `Deployment #${deploymentId}: ${details}`);
    }
  } catch (error: any) {
    console.error(`[Risk] Drawdown check error: ${error.message}`);
  }
}

// ─── Risk: Position Reconciliation (real mode) ───

async function reconcilePositions(deploymentId: number): Promise<void> {
  try {
    if (!isAuthenticated()) return;

    const positions = getDeploymentPositions(deploymentId);
    if (positions.length === 0) return;

    const kite = getKite();
    let kiteHoldings: any[];
    try {
      kiteHoldings = await kite.getHoldings();
    } catch {
      return; // Can't reconcile without holdings data
    }

    const kiteMap = new Map<string, number>();
    for (const h of kiteHoldings) {
      if (h.quantity > 0) {
        kiteMap.set(h.tradingsymbol, h.quantity);
      }
    }

    const mismatches: string[] = [];
    for (const pos of positions) {
      const kiteQty = kiteMap.get(pos.symbol) || 0;
      if (kiteQty !== pos.quantity) {
        mismatches.push(`${pos.symbol}: Flameback=${pos.quantity}, Kite=${kiteQty}`);
      }
    }

    if (mismatches.length > 0) {
      const details = `Position mismatch detected:\n${mismatches.join("\n")}`;
      await sendRiskAlert("RECONCILIATION_MISMATCH", details);
      logSystem("risk", "reconciliation_mismatch", `Deployment #${deploymentId}: ${mismatches.length} mismatches`);
    } else {
      logSystem("risk", "reconciliation_ok", `Deployment #${deploymentId}: all positions match Kite holdings`);
    }
  } catch (error: any) {
    console.error(`[Risk] Reconciliation error: ${error.message}`);
  }
}

// ─── Run lifecycle for all active deployments ───

export async function runAllActiveLifecycles(): Promise<LifecycleResult[]> {
  const activeDeployments = getActiveDeployments();
  const results: LifecycleResult[] = [];

  for (const d of activeDeployments) {
    const result = await runDeploymentLifecycle(d.id);
    results.push(result);
  }

  return results;
}

export async function runAllPreMarketChecks(): Promise<void> {
  const activeDeployments = getActiveDeployments();
  for (const d of activeDeployments) {
    await runPreMarketCheck(d.id);
  }
}

export async function runAllEndOfDaySummaries(): Promise<void> {
  const activeDeployments = getActiveDeployments();
  for (const d of activeDeployments) {
    await runEndOfDaySummary(d.id);
  }
}
