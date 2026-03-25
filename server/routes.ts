import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { runScreener, clearCache } from "./screener";
import { startScheduler } from "./scheduler";
import { getLoginURL, generateSession, setAccessToken, isAuthenticated, getKite, getKiteStatus, markKiteFailed, throttledKite } from "./kite";
import { getBacktestResult, clearBacktestCache, runBacktest } from "./backtest";
import { runBollingerMRBacktest } from "./backtest-bollinger-mr";
import { NSE_UNIVERSE } from "./nse-universe";
import Database from "better-sqlite3";
import { logSystem, getSystemLogs, getChangelog, DB_PATH, istNow, getDeployments, getDeployment, getActiveDeployments, getDeploymentPositions, getDeploymentTrades, getDeploymentSnapshots, getFundTransactions, getDeploymentChangelog, getOrdersLog, insertOrder, updateOrderStatus, getOrder, getOrderByKiteId } from "./storage";
import { getFilterBreakdown, clearFilterBreakdownCache } from "./filter-breakdown";
import { getPortfolioSummary, runDailyLifecycle } from "./live-portfolio";
import { runBollingerScreener, clearBollingerCache } from "./screener-bollinger";
import { getAllStrategies, getStrategy } from "./strategies";
import { runDeploymentLifecycle, runPreMarketCheck, runEndOfDaySummary, isMarketOpen } from "./lifecycle";
import { sendMorningBrief, sendDailyPnLSummary, sendTelegramMessage } from "./telegram";
import { startTelegramBot } from "./telegram-bot";
import { istNow as getIstNow } from "./storage";

// ─── API Authentication Middleware ───
// Protects mutating endpoints (POST/PUT/DELETE) with a shared-secret API key.
// Read API_AUTH_KEY from process.env; if not set, auth is skipped (dev mode).
// Set API_AUTH_KEY as an environment variable in production (e.g. Railway).
function apiAuth(req: Request, res: Response, next: NextFunction) {
  const API_AUTH_KEY = process.env.API_AUTH_KEY;

  // If no auth key configured, skip auth (development mode)
  if (!API_AUTH_KEY) return next();

  // Skip for non-mutating requests (GET/HEAD/OPTIONS)
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  // Skip for public POST paths (OAuth callback & Zerodha server-to-server)
  const publicPaths = ["/kite-redirect", "/kite-postback"];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();

  // Check for auth key in header or query param
  const provided = req.headers["x-api-key"] || req.query.apiKey;
  if (provided === API_AUTH_KEY) return next();

  res.status(401).json({ error: "Unauthorized — provide X-API-Key header" });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Apply API auth middleware to all routes
  app.use(apiAuth);

  // ─── Kite Connect Auth ───

  // Get auth status
  app.get("/api/kite/status", (_req, res) => {
    const status = getKiteStatus();
    res.json({
      ...status,
      loginUrl: getLoginURL(),
    });
  });

  // Get login URL
  app.get("/api/kite/login-url", (_req, res) => {
    res.json({ url: getLoginURL() });
  });

  // Exchange request_token for access_token
  app.post("/api/kite/auth", async (req, res) => {
    try {
      const { request_token } = req.body;
      if (!request_token) {
        return res.status(400).json({ error: "request_token required" });
      }
      const session = await generateSession(request_token);
      // Clear screener cache to force refresh with Kite data
      clearCache();
      res.json({ success: true, user: session.user_name });
    } catch (error: any) {
      console.error("[API] Kite auth error:", error.message);
      res.status(401).json({ error: "Authentication failed", message: error.message });
    }
  });

  // Set access token directly
  app.post("/api/kite/token", (req, res) => {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: "access_token required" });
    }
    setAccessToken(access_token);
    clearCache();
    res.json({ success: true });
  });

  // Disconnect Kite
  app.post("/api/kite/disconnect", (_req, res) => {
    markKiteFailed("Manually disconnected");
    clearCache();
    console.log("[Kite] Manually disconnected by user");
    res.json({ success: true, message: "Disconnected from Kite" });
  });

  // Kite redirect handler (after login)
  app.get("/kite-redirect", async (req, res) => {
    const requestToken = req.query.request_token as string;
    if (requestToken) {
      try {
        const session = await generateSession(requestToken);
        clearCache();
        // Send Telegram success notification
        try {
          const time = getIstNow();
          await sendTelegramMessage(
            `✅ <b>Kite Connected</b>\nUser: ${session.user_name}\nTime: ${time}\nToken valid for today's trading session.`
          );
        } catch { /* never break redirect on Telegram failure */ }
        res.redirect("/");
      } catch (e: any) {
        // Send Telegram failure notification
        try {
          const time = getIstNow();
          await sendTelegramMessage(
            `❌ <b>Kite Auth Failed</b>\nError: ${e.message}\nTime: ${time}\nTry again: /login`
          );
        } catch { /* never break redirect on Telegram failure */ }
        res.redirect("/");
      }
    } else {
      res.redirect("/#/");
    }
  });

  // ─── Kite Postback (real-time order updates from Zerodha) ───

  app.post("/kite-postback", async (req, res) => {
    try {
      const payload = req.body;
      // Kite postback sends: order_id, status, tradingsymbol, filled_quantity, average_price, etc.
      const kiteOrderId = payload?.order_id;
      const kiteStatus = payload?.status; // COMPLETE, CANCELLED, REJECTED, etc.
      const tradingsymbol = payload?.tradingsymbol;
      const filledQty = payload?.filled_quantity || 0;
      const averagePrice = payload?.average_price || 0;
      const statusMessage = payload?.status_message || "";
      const transactionType = payload?.transaction_type; // BUY or SELL

      console.log(`[Postback] ${tradingsymbol} ${transactionType} — ${kiteStatus} | Kite ID: ${kiteOrderId} | Filled: ${filledQty} @ ₹${averagePrice}`);
      logSystem("postback", "received", `${tradingsymbol} ${transactionType} ${kiteStatus} | Order: ${kiteOrderId} | Filled: ${filledQty} @ ₹${averagePrice}`);

      // Validate checksum if present
      const KITE_API_SECRET = process.env.KITE_API_SECRET || "6cphs32h6vyjp5q287u7tst2zsyr1hu1";
      const receivedChecksum = req.headers["x-kite-checksum"] as string;
      if (receivedChecksum) {
        const rawBody = (req as any).rawBody as string;
        const expectedChecksum = crypto
          .createHash("sha256")
          .update(rawBody + KITE_API_SECRET)
          .digest("hex");
        if (receivedChecksum !== expectedChecksum) {
          console.error(`[Postback] Checksum mismatch: received=${receivedChecksum}, expected=${expectedChecksum}`);
          logSystem("postback", "checksum_failed", `Checksum mismatch for ${tradingsymbol} ${kiteOrderId}`);
          res.status(403).json({ ok: false, error: "Checksum validation failed" });
          return;
        }
      }

      if (!kiteOrderId) {
        res.json({ ok: true, message: "No order_id, ignored" });
        return;
      }

      // Find the matching order in our orders_log
      const order = getOrderByKiteId(String(kiteOrderId));
      if (!order) {
        console.log(`[Postback] No matching order for Kite ID ${kiteOrderId} — may be external trade`);
        logSystem("postback", "unmatched", `Kite ID ${kiteOrderId} not found in orders_log (${tradingsymbol} ${transactionType})`);
        res.json({ ok: true, message: "Order not tracked" });
        return;
      }

      // Map Kite status to our status
      const statusMap: Record<string, string> = {
        "COMPLETE": "COMPLETE",
        "CANCELLED": "CANCELLED",
        "REJECTED": "REJECTED",
        "OPEN": "OPEN",
        "TRIGGER PENDING": "OPEN",
        "OPEN PENDING": "OPEN",
        "VALIDATION PENDING": "OPEN",
        "PUT ORDER REQ RECEIVED": "PLACED",
      };
      const mappedStatus = statusMap[kiteStatus] || kiteStatus;

      // Update order status
      updateOrderStatus(order.id, {
        status: mappedStatus,
        fill_price: averagePrice > 0 ? averagePrice : undefined,
        fill_quantity: filledQty > 0 ? filledQty : undefined,
        error_message: kiteStatus === "REJECTED" ? statusMessage : undefined,
      });

      // Send Telegram notification for terminal statuses
      const { sendOrderUpdate } = await import("./telegram");
      if (["COMPLETE", "CANCELLED", "REJECTED"].includes(mappedStatus)) {
        try {
          await sendOrderUpdate({
            symbol: tradingsymbol,
            orderType: order.order_type,
            transactionType: transactionType || order.transaction_type,
            price: order.price,
            quantity: filledQty || order.quantity,
            status: mappedStatus,
            fillPrice: averagePrice > 0 ? averagePrice : undefined,
            kiteOrderId: String(kiteOrderId),
          });
        } catch { /* Telegram failure should not break postback */ }
      }

      // If BUY order COMPLETE → create the position in deployment_positions
      if (mappedStatus === "COMPLETE" && (transactionType === "BUY" || order.transaction_type === "BUY")) {
        try {
          const sqliteDb = new Database(DB_PATH);
          const now = istNow();
          const dateStr = now.split(" ")[0];
          const entryPrice = averagePrice > 0 ? averagePrice : order.price;
          const qty = filledQty > 0 ? filledQty : order.quantity;
          const entryValue = Math.round(entryPrice * qty);

          // Check if position already exists (avoid duplicates)
          const existing = sqliteDb.prepare(
            "SELECT id FROM deployment_positions WHERE deployment_id = ? AND symbol = ?"
          ).get(order.deployment_id, tradingsymbol || order.symbol) as any;

          if (!existing) {
            sqliteDb.prepare(`
              INSERT INTO deployment_positions (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, current_price, current_value, pnl, pnl_pct, trading_days_held, peak_price, setup_score, last_updated)
              VALUES (?, ?, ?, 'LONG', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
            `).run(
              order.deployment_id,
              tradingsymbol || order.symbol,
              tradingsymbol || order.symbol,
              dateStr, dateStr, now,
              Math.round(entryPrice * 100) / 100, qty, entryValue,
              Math.round(entryPrice * 100) / 100, entryValue,
              Math.round(entryPrice * 100) / 100,
              null, dateStr
            );

            logSystem("postback", "position_created", `${tradingsymbol}: ${qty} shares @ ₹${entryPrice.toFixed(2)} — from Kite fill`);

            // Send trade alert via Telegram
            try {
              const { sendTradeAlert } = await import("./telegram");
              await sendTradeAlert("ENTRY", {
                symbol: tradingsymbol || order.symbol,
                price: entryPrice,
                quantity: qty,
                strategy: order.strategy,
              });
            } catch { /* Telegram failure OK */ }
          }
        } catch (err: any) {
          console.error(`[Postback] Position creation error: ${err.message}`);
          logSystem("postback", "position_error", `${tradingsymbol}: ${err.message}`);
        }
      }

      // If SELL order COMPLETE → the lifecycle already handles trade recording,
      // but log it for audit
      if (mappedStatus === "COMPLETE" && (transactionType === "SELL" || order.transaction_type === "SELL")) {
        logSystem("postback", "sell_confirmed", `${tradingsymbol}: SELL ${filledQty} @ ₹${averagePrice} confirmed by Kite`);
      }

      // If REJECTED → alert + log
      if (mappedStatus === "REJECTED") {
        logSystem("postback", "order_rejected", `${tradingsymbol} ${transactionType}: ${statusMessage}`);
        try {
          const { sendSystemAlert } = await import("./telegram");
          await sendSystemAlert("Order Rejected", `${tradingsymbol} ${transactionType} rejected: ${statusMessage}`);
        } catch { /* Telegram failure OK */ }
      }

      res.json({ ok: true, message: `Processed: ${tradingsymbol} ${mappedStatus}` });
    } catch (error: any) {
      console.error(`[Postback] Error: ${error.message}`);
      logSystem("postback", "error", error.message);
      // Always return 200 to Kite so it doesn't retry endlessly
      res.json({ ok: false, error: error.message });
    }
  });

  // ─── Screener ───

  app.get("/api/screener", async (_req, res) => {
    try {
      const result = await runScreener();
      res.json(result);
    } catch (error: any) {
      console.error("[API] Screener error:", error.message);
      res.status(500).json({ error: "Failed to run screener", message: error.message });
    }
  });

  app.post("/api/screener/refresh", async (_req, res) => {
    try {
      clearCache();
      const result = await runScreener();
      res.json(result);
    } catch (error: any) {
      console.error("[API] Refresh error:", error.message);
      res.status(500).json({ error: "Failed to refresh", message: error.message });
    }
  });

  // ─── Backtest ───

  // Get a specific saved backtest run (or the latest)
  app.get("/api/backtest", async (req, res) => {
    try {
      const runId = req.query.runId as string;
      const sqlite = new Database(DB_PATH);
      
      if (runId) {
        const row = sqlite.prepare("SELECT * FROM backtest_runs WHERE id = ?").get(parseInt(runId)) as any;
        if (!row) return res.status(404).json({ error: "Run not found" });
        return res.json({
          id: row.id,
          name: row.name,
          trades: JSON.parse(row.trades_json),
          dailySnapshots: JSON.parse(row.snapshots_json),
          summary: JSON.parse(row.summary_json),
          period: { from: row.period_from, to: row.period_to },
        });
      }

      // Return latest saved run if exists
      const latest = sqlite.prepare("SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1").get() as any;
      if (latest) {
        return res.json({
          id: latest.id,
          name: latest.name,
          trades: JSON.parse(latest.trades_json),
          dailySnapshots: JSON.parse(latest.snapshots_json),
          summary: JSON.parse(latest.summary_json),
          period: { from: latest.period_from, to: latest.period_to },
        });
      }

      res.json(null); // No runs yet
    } catch (error: any) {
      console.error("[API] Backtest error:", error.message);
      res.status(500).json({ error: "Backtest failed", message: error.message });
    }
  });

  // List all saved backtest runs (summary only)
  app.get("/api/backtest/runs", (req, res) => {
    try {
      const sqlite = new Database(DB_PATH);
      const strategyFilter = req.query.strategyId as string;
      let query = "SELECT id, name, strategy_id, created_at, period_from, period_to, capital, max_positions, universe_size, universe_label, total_trades, annualized_return_pct, total_return_pct, win_rate, sharpe_ratio, max_drawdown_pct, data_source, params_json FROM backtest_runs";
      if (strategyFilter) query += ` WHERE strategy_id = '${strategyFilter.replace(/'/g, '')}'`;
      query += " ORDER BY id DESC";
      const runs = sqlite.prepare(query).all();
      res.json(runs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Run a new backtest and save it permanently
  app.post("/api/backtest/run", async (req, res) => {
    // Set a longer timeout for backtest requests (5 minutes)
    req.setTimeout(300000);
    res.setTimeout(300000);
    try {
      const { name, capital, maxPositions, years, fromDate, toDate, strategyId, absoluteStopPct, trailingStopPct, maPeriod, entryBandSigma, stopLossSigma, targetBandSigma, maxHoldDays, allowParallelPositions, watchlistCondition, entryCondition, exitTarget, exitStopBand, dmaLength, dipThresholdPct, atrFilterThreshold, limitOrderMultiple, profitTargetMultiple, priceActionExit, universe, benchmark } = req.body;
      const strategy = strategyId || "atr_dip_buyer";

      // Filter universe based on selection
      let filteredUniverse = NSE_UNIVERSE;
      let universeLabel = "All NSE";
      let universeSize = NSE_UNIVERSE.length;
      if (universe === "nifty50") { filteredUniverse = NSE_UNIVERSE.slice(0, 50); universeLabel = "Nifty 50"; universeSize = 50; }
      else if (universe === "nifty100") { filteredUniverse = NSE_UNIVERSE.slice(0, 100); universeLabel = "Nifty 100"; universeSize = 100; }
      else if (universe === "nifty200") { filteredUniverse = NSE_UNIVERSE.slice(0, 200); universeLabel = "Nifty 200"; universeSize = 200; }
      else if (universe === "nifty500") { filteredUniverse = NSE_UNIVERSE.slice(0, 500); universeLabel = "Nifty 500"; universeSize = Math.min(500, NSE_UNIVERSE.length); }
      // else "all" or default: use full NSE_UNIVERSE

      // Map benchmark selection to Yahoo Finance ticker symbol
      const benchmarkTickerMap: Record<string, string> = {
        nifty50: "^NSEI",
        niftynext50: "^NSMIDCP",  // NIFTY NEXT 50 — approximate
        nifty100: "^CNX100",
        nifty200: "^CNX200",
        nifty500: "^CRSLDX",      // NIFTY 500
        niftymidcap100: "^NSEMDCP50",  // NIFTY MIDCAP proxy
        niftysmallcap100: "NIFTYSMLCAP100.NS",
      };
      const benchmarkLabelMap: Record<string, string> = {
        nifty50: "NIFTY 50", niftynext50: "NIFTY NEXT 50", nifty100: "NIFTY 100",
        nifty200: "NIFTY 200", nifty500: "NIFTY 500",
        niftymidcap100: "NIFTY MIDCAP 100", niftysmallcap100: "NIFTY SMALLCAP 100",
      };
      const benchmarkTicker = benchmarkTickerMap[benchmark || "nifty50"] || "^NSEI";
      const benchmarkLabel = benchmarkLabelMap[benchmark || "nifty50"] || "NIFTY 50";

      let result;
      const commonParams = { capitalRs: capital || 1000000, maxPositions: maxPositions || 10, lookbackYears: years || 5 };

      const bollingerConditions = { watchlistCondition, entryCondition, exitTarget, exitStopBand };

      if (strategy === "bollinger_bounce" || strategy === "bollinger_mr") {
        result = await runBollingerMRBacktest({
          ...commonParams,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          maPeriod: maPeriod || 20,
          entryBandSigma: entryBandSigma || 2,
          targetBandSigma: targetBandSigma || 2,
          stopLossSigma: stopLossSigma || 2,
          maxHoldDays: maxHoldDays !== undefined && maxHoldDays !== "" ? Number(maxHoldDays) : 0,
          allowParallelPositions: allowParallelPositions || false,
          absoluteStopPct: absoluteStopPct || undefined,
          trailingStopPct: trailingStopPct || undefined,
          universeOverride: filteredUniverse,
          benchmarkTicker,
          benchmarkLabel,
          ...bollingerConditions,
        });
      } else {
        clearBacktestCache();
        result = await runBacktest({
          ...commonParams,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          maxHoldDays: maxHoldDays || 10,
          absoluteStopPct: absoluteStopPct || undefined,
          trailingStopPct: trailingStopPct || undefined,
          dmaLength: dmaLength || undefined,
          dipThresholdPct: dipThresholdPct || undefined,
          atrFilterThreshold: atrFilterThreshold || undefined,
          limitOrderMultiple: limitOrderMultiple !== undefined ? limitOrderMultiple : undefined,
          profitTargetMultiple: profitTargetMultiple !== undefined ? profitTargetMultiple : undefined,
          priceActionExit: priceActionExit !== undefined ? priceActionExit : undefined,
          universeOverride: filteredUniverse,
          benchmarkTicker,
          benchmarkLabel,
        });
      }

      const strategyLabels: Record<string, string> = { bollinger_mr: "Boll MR", bollinger_bounce: "Bollinger", atr_dip_buyer: "ATR Dip" };
      const autoName = name || `${strategyLabels[strategy] || strategy} | ${result.period.from} → ${result.period.to} | ${commonParams.maxPositions} pos`;
      // IST timestamp
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const now = istNow.toISOString().replace("T", " ").split(".")[0] + " IST";
      const strategyDef = getStrategy(strategy);
      // Build human-readable rule descriptions for this specific run
      const condLabels: Record<string, string> = {
        "below_-1s": "Below −1σ", "below_-2s": "Below −2σ", "below_-3s": "Below −3σ", "below_mean": "Below Mean (20-DMA)",
        "cross_above_-2s": "Cross above −2σ", "cross_above_-1s": "Cross above −1σ",
        "cross_above_mean": "Cross above Mean (20-DMA)", "cross_above_+1s": "Cross above +1σ",
        "reach_mean": "Reach Mean (20-DMA)", "reach_+1s": "Reach +1σ", "reach_+2s": "Reach +2σ", "reach_+3s": "Reach +3σ",
        "below_-2s_stop": "Drop below −2σ", "below_-3s_stop": "Drop below −3σ", "below_-4s_stop": "Drop below −4σ",
      };

      // Build comprehensive rules template
      const rulesTemplate = {
        strategy: strategyDef?.name || strategy,
        runDate: now,
        period: { from: result.period.from, to: result.period.to },
        parameters: {
          maPeriod: maPeriod || "N/A",
          capital: `\u20b9${((capital || 1000000) / 100000).toFixed(0)}L`,
          maxPositions: maxPositions || 10,
          positionSizing: strategy === "atr_dip_buyer" ? "Dynamic (portfolio / max positions)" : "Fixed (capital / max positions)",
          allowParallel: allowParallelPositions ? "Yes" : "No",
        },
        entry: {
          watchlistTrigger: watchlistCondition ? condLabels[watchlistCondition] : (strategy === "atr_dip_buyer" ? `Close > ${dmaLength || 200}-DMA + Drop > ${dipThresholdPct || 3}% + ATR% > ${atrFilterThreshold || 3}` : "N/A"),
          entryCondition: entryCondition ? condLabels[entryCondition] : (strategy === "atr_dip_buyer" ? `Limit order at Close \u2212 ${limitOrderMultiple ?? 0.9}\u00d7ATR(5)` : "N/A"),
          entryPrice: strategy === "atr_dip_buyer" ? `Limit price (Close \u2212 ${limitOrderMultiple ?? 0.9}\u00d7ATR)` : (entryCondition?.includes("mean") ? "20-DMA value" : "Close at crossover"),
          dmaLength: strategy === "atr_dip_buyer" ? (dmaLength || 200) : "N/A",
          dipThreshold: strategy === "atr_dip_buyer" ? `${dipThresholdPct || 3}%` : "N/A",
          atrFilterThreshold: strategy === "atr_dip_buyer" ? (atrFilterThreshold || 3) : "N/A",
          limitOrderMultiple: strategy === "atr_dip_buyer" ? (limitOrderMultiple ?? 0.9) : "N/A",
        },
        exit: {
          profitTarget: exitTarget ? condLabels[exitTarget] : (strategy === "atr_dip_buyer" ? `Entry + ${profitTargetMultiple ?? 0.5}\u00d7ATR(5)` : "N/A"),
          bandStopLoss: exitStopBand ? condLabels[exitStopBand] : "N/A",
          absoluteStopLoss: absoluteStopPct ? `\u2212${absoluteStopPct}% from entry` : "N/A",
          trailingStopLoss: trailingStopPct ? `\u2212${trailingStopPct}% from peak` : "N/A",
          priceActionExit: strategy === "atr_dip_buyer" ? (priceActionExit !== false ? "Close > previous day's high" : "Disabled") : "N/A",
          maxHoldDays: maxHoldDays && maxHoldDays > 0 ? `${maxHoldDays} trading days` : "No limit",
        },
        data: {
          universe: `${universeLabel} (${universeSize} stocks)`,
          dataSource: result.summary.dataSource,
        },
      };

      const allParams = {
        ...commonParams, strategyId: strategy, absoluteStopPct, trailingStopPct,
        maPeriod, entryBandSigma, stopLossSigma, targetBandSigma, maxHoldDays, fromDate, toDate,
        allowParallelPositions,
        universe: universe || "nifty500", benchmark: benchmark || "nifty50", benchmarkLabel,
        // Configurable conditions
        watchlistCondition, entryCondition, exitTarget, exitStopBand,
        // ATR-specific params
        dmaLength, dipThresholdPct, atrFilterThreshold, limitOrderMultiple, profitTargetMultiple, priceActionExit,
        // Comprehensive rules template
        rulesTemplate,
        // Human-readable rules for this specific run
        entryRules: [
          ...(strategyDef?.entryRules || []),
          ...(watchlistCondition ? [`Watchlist: ${condLabels[watchlistCondition] || watchlistCondition}`] : []),
          ...(entryCondition ? [`Entry: ${condLabels[entryCondition] || entryCondition}`] : []),
        ],
        exitRules: [
          ...(strategyDef?.exitRules || []),
          ...(exitTarget ? [{ name: "Profit Target", description: condLabels[exitTarget] || exitTarget }] : []),
          ...(exitStopBand ? [{ name: "Band Stop", description: condLabels[exitStopBand] || exitStopBand }] : []),
          ...(absoluteStopPct ? [{ name: "Absolute Stop", description: `\u2212${absoluteStopPct}% from entry` }] : []),
          ...(trailingStopPct ? [{ name: "Trailing Stop", description: `\u2212${trailingStopPct}% from peak` }] : []),
          ...(maxHoldDays && maxHoldDays > 0 ? [{ name: "Time Exit", description: `${maxHoldDays} trading days max` }] : []),
        ],
      };

      const sqlite = new Database(DB_PATH);
      const stmt = sqlite.prepare(`
        INSERT INTO backtest_runs (name, strategy_id, created_at, period_from, period_to, capital, max_positions, universe_size, universe_label, total_trades, annualized_return_pct, total_return_pct, win_rate, sharpe_ratio, max_drawdown_pct, data_source, params_json, summary_json, trades_json, snapshots_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        autoName, strategy, now, result.period.from, result.period.to,
        commonParams.capitalRs, commonParams.maxPositions,
        universeSize, universeLabel,
        result.summary.totalTrades,
        result.summary.annualizedReturnPct, result.summary.totalReturnPct,
        result.summary.winningPct, result.summary.sharpeRatio,
        result.summary.maxDrawdownPct, result.summary.dataSource,
        JSON.stringify(allParams),
        JSON.stringify(result.summary), JSON.stringify(result.trades),
        JSON.stringify(result.dailySnapshots)
      );

      logSystem("backtest", "run_completed", `${autoName} | ${result.summary.totalTrades} trades | ${result.summary.annualizedReturnPct}% ann. return`);
      res.json({ id: info.lastInsertRowid, name: autoName, ...result });
    } catch (error: any) {
      console.error("[API] Backtest run error:", error.message);
      res.status(500).json({ error: "Backtest failed", message: error.message });
    }
  });

  // Delete a backtest run
  app.delete("/api/backtest/runs/:id", (req, res) => {
    try {
      const sqlite = new Database(DB_PATH);
      sqlite.prepare("DELETE FROM backtest_runs WHERE id = ?").run(parseInt(req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Bollinger Bounce Screener ───

  app.get("/api/bollinger/screener", async (_req, res) => {
    try {
      const result = await runBollingerScreener();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/bollinger/screener/refresh", async (_req, res) => {
    try {
      clearBollingerCache();
      const result = await runBollingerScreener();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Strategy Registry ───

  app.get("/api/strategies", (_req, res) => {
    res.json(getAllStrategies());
  });

  app.get("/api/strategies/:id", (req, res) => {
    const strategy = getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ error: "Strategy not found" });
    res.json(strategy);
  });

  // ─── System Log ───

  app.get("/api/system/logs", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(getSystemLogs(limit));
  });

  // ─── Per-trade chart data (Bollinger Bands + OHLC around trade window) ───

  app.get("/api/trade-chart", async (req, res) => {
    try {
      const symbol = req.query.symbol as string; // e.g., "RELIANCE.NS"
      const entryDate = req.query.entryDate as string;
      const exitDate = req.query.exitDate as string;
      const maPeriod = parseInt(req.query.maPeriod as string) || 20;
      const sigma = parseFloat(req.query.sigma as string) || 2;
      const stopSigma = parseFloat(req.query.stopSigma as string) || 3;
      const dmaLengthParam = parseInt(req.query.dmaLength as string) || 0; // for ATR charts

      if (!symbol || !entryDate || !exitDate) {
        return res.status(400).json({ error: "symbol, entryDate, exitDate required" });
      }

      // Fetch bars with extra buffer before entry for MA warmup + context
      const warmupPeriod = Math.max(maPeriod, dmaLengthParam) + 40;
      const fromD = new Date(entryDate);
      fromD.setDate(fromD.getDate() - warmupPeriod); // extra buffer for MA warmup + visual context
      const toD = new Date(exitDate);
      toD.setDate(toD.getDate() + 10); // show a bit after exit
      const from = fromD.toISOString().split("T")[0];
      const to = toD.toISOString().split("T")[0];

      // Reuse backtest's fetchBars pattern inline
      let bars: { date: string; open: number; high: number; low: number; close: number }[] = [];

      if (isAuthenticated()) {
        try {
          const instruments = await throttledKite(k => k.getInstruments("NSE"));
          const clean = symbol.replace(".NS", "");
          const inst = instruments.find((i: any) => i.tradingsymbol === clean && i.segment === "NSE" && i.instrument_type === "EQ");
          if (inst) {
            const data = await throttledKite(k => k.getHistoricalData(inst.instrument_token, "day", from, to));
            if (data && data.length > 0) {
              bars = data.filter((d: any) => d.close > 0).map((d: any) => ({
                date: new Date(d.date).toISOString().split("T")[0],
                open: d.open, high: d.high, low: d.low, close: d.close,
              }));
            }
          }
        } catch {}
      }

      if (bars.length === 0) {
        // Yahoo Finance fallback
        const yfRaw = require("yahoo-finance2");
        const YFClass = yfRaw.default || yfRaw;
        const yf = typeof YFClass === "function" ? new YFClass({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YFClass;
        try {
          const result = await yf.chart(symbol, { period1: new Date(from), period2: new Date(to), interval: "1d" });
          if (result?.quotes) {
            bars = result.quotes.filter((q: any) => q.close && q.close > 0)
              .map((q: any) => ({
                date: new Date(q.date).toISOString().split("T")[0],
                open: q.open ?? q.close, high: q.high ?? q.close, low: q.low ?? q.close, close: q.close,
              }));
          }
        } catch {}
      }

      const minBarsNeeded = Math.max(maPeriod, dmaLengthParam) + 5;
      if (bars.length < minBarsNeeded) {
        return res.json({ bars: [], bands: [], entryDate, exitDate });
      }

      // Compute Bollinger Bands and optional DMA for each bar
      const bandData: {
        date: string; close: number; open: number; high: number; low: number;
        ma: number; upperBand: number; lowerBand: number; stopBand: number;
        dma?: number;
      }[] = [];

      // Determine the minimum index we can start producing data from
      const minStartIdx = Math.max(maPeriod - 1, dmaLengthParam > 0 ? dmaLengthParam - 1 : 0);

      for (let i = 0; i < bars.length; i++) {
        if (i < minStartIdx) continue;
        // Bollinger Bands (always computed from maPeriod)
        let sum = 0;
        for (let j = i - maPeriod + 1; j <= i; j++) sum += bars[j].close;
        const ma = sum / maPeriod;
        let sumSq = 0;
        for (let j = i - maPeriod + 1; j <= i; j++) sumSq += (bars[j].close - ma) ** 2;
        const std = Math.sqrt(sumSq / maPeriod);

        // Optional long DMA (for ATR charts)
        let dmaVal: number | undefined;
        if (dmaLengthParam > 0 && i >= dmaLengthParam - 1) {
          let dmaSum = 0;
          for (let j = i - dmaLengthParam + 1; j <= i; j++) dmaSum += bars[j].close;
          dmaVal = Math.round((dmaSum / dmaLengthParam) * 100) / 100;
        }

        bandData.push({
          date: bars[i].date,
          close: Math.round(bars[i].close * 100) / 100,
          open: Math.round(bars[i].open * 100) / 100,
          high: Math.round(bars[i].high * 100) / 100,
          low: Math.round(bars[i].low * 100) / 100,
          ma: Math.round(ma * 100) / 100,
          upperBand: Math.round((ma + sigma * std) * 100) / 100,
          lowerBand: Math.round((ma - sigma * std) * 100) / 100,
          stopBand: Math.round((ma - stopSigma * std) * 100) / 100,
          ...(dmaVal !== undefined ? { dma: dmaVal } : {}),
        });
      }

      // Trim to show ~15 bars before entry through ~5 bars after exit for visual context
      const entryIdx = bandData.findIndex(b => b.date >= entryDate);
      const exitIdx = bandData.findIndex(b => b.date >= exitDate);
      const startIdx = Math.max(0, (entryIdx >= 0 ? entryIdx : 0) - 15);
      const endIdx = Math.min(bandData.length, (exitIdx >= 0 ? exitIdx : bandData.length) + 6);

      res.json({
        data: bandData.slice(startIdx, endIdx),
        entryDate,
        exitDate,
        symbol: symbol.replace(".NS", ""),
      });
    } catch (error: any) {
      console.error("[API] Trade chart error:", error.message);
      res.status(500).json({ error: "Failed to fetch chart data", message: error.message });
    }
  });

  // ─── Changelog ───

  app.get("/api/changelog", (req, res) => {
    const scope = req.query.scope as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getChangelog(scope || undefined, limit));
  });

  // ─── Live Portfolio ───

  app.get("/api/live/portfolio", (_req, res) => {
    try {
      const result = getPortfolioSummary();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get portfolio", message: error.message });
    }
  });

  app.post("/api/live/run", async (_req, res) => {
    try {
      const result = await runDailyLifecycle();
      res.json(result);
    } catch (error: any) {
      console.error("[API] Live lifecycle error:", error.message);
      res.status(500).json({ error: "Lifecycle failed", message: error.message });
    }
  });

  // ─── Filter Breakdown ───

  app.get("/api/filters", async (req, res) => {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const result = await getFilterBreakdown({ lookbackDays: days });
      res.json(result);
    } catch (error: any) {
      console.error("[API] Filter breakdown error:", error.message);
      res.status(500).json({ error: "Filter breakdown failed", message: error.message });
    }
  });

  // ─── Deployments ───

  app.post("/api/deployments", (req, res) => {
    try {
      const { name, strategyId, mode, capital, maxPositions, maxHoldDays, absoluteStopPct, trailingStopPct, maPeriod, entryBandSigma, targetBandSigma, stopLossSigma, allowParallel } = req.body;
      if (!strategyId || !capital) return res.status(400).json({ error: "strategyId and capital are required" });
      const now = istNow();
      const deployName = name || `${strategyId} ${mode || 'paper'} ${now.split(" ")[0]}`;
      const sqliteDb = new Database(DB_PATH);
      const result = sqliteDb.prepare(`
        INSERT INTO deployments (name, strategy_id, mode, status, created_at, initial_capital, current_capital, max_positions, max_hold_days, absolute_stop_pct, trailing_stop_pct, ma_period, entry_band_sigma, target_band_sigma, stop_loss_sigma, allow_parallel)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deployName, strategyId, mode || 'paper', now, capital, capital,
        maxPositions ?? 10, maxHoldDays ?? 0,
        absoluteStopPct ?? null, trailingStopPct ?? null,
        maPeriod ?? 20, entryBandSigma ?? 2, targetBandSigma ?? 2, stopLossSigma ?? 2,
        allowParallel ? 1 : 0
      );
      const id = result.lastInsertRowid;
      // Record initial deposit in fund_transactions
      sqliteDb.prepare(`INSERT INTO fund_transactions (deployment_id, date, type, amount, balance_after, note) VALUES (?, ?, 'initial_deposit', ?, ?, 'Initial capital')`)
        .run(id, now, capital, capital);
      logSystem("deployment", "created", `Deployment #${id} '${deployName}' created — ${mode} mode, ₹${capital}`);
      res.json(getDeployment(Number(id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments", (_req, res) => {
    try {
      res.json(getDeployments());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      const positions = getDeploymentPositions(id);
      const trades = getDeploymentTrades(id);
      const snapshots = getDeploymentSnapshots(id);
      const funds = getFundTransactions(id);
      const changelog = getDeploymentChangelog(id);
      const orders = getOrdersLog(id, { limit: 100 });
      res.json({ ...deployment, positions, trades, snapshots, funds, changelog, orders });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/deployments/:id", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      const now = istNow();
      const sqliteDb = new Database(DB_PATH);
      const updatableFields: Record<string, string> = {
        maxPositions: 'max_positions', maxHoldDays: 'max_hold_days',
        absoluteStopPct: 'absolute_stop_pct', trailingStopPct: 'trailing_stop_pct',
        maPeriod: 'ma_period', entryBandSigma: 'entry_band_sigma',
        targetBandSigma: 'target_band_sigma', stopLossSigma: 'stop_loss_sigma',
        allowParallel: 'allow_parallel'
      };
      for (const [jsKey, dbCol] of Object.entries(updatableFields)) {
        if (req.body[jsKey] !== undefined) {
          const oldVal = deployment[dbCol];
          let newVal = req.body[jsKey];
          if (jsKey === 'allowParallel') newVal = newVal ? 1 : 0;
          if (String(oldVal) !== String(newVal)) {
            sqliteDb.prepare(`UPDATE deployments SET ${dbCol} = ? WHERE id = ?`).run(newVal, id);
            sqliteDb.prepare(`INSERT INTO deployment_changelog (deployment_id, date, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)`)
              .run(id, now, dbCol, String(oldVal ?? ''), String(newVal ?? ''));
          }
        }
      }
      logSystem("deployment", "settings_updated", `Deployment #${id} settings updated`);
      res.json(getDeployment(id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/pause", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      if (deployment.status !== 'active') return res.status(400).json({ error: "Only active deployments can be paused" });
      const sqliteDb = new Database(DB_PATH);
      sqliteDb.prepare("UPDATE deployments SET status = 'paused' WHERE id = ?").run(id);
      logSystem("deployment", "paused", `Deployment #${id} '${deployment.name}' paused`);
      res.json(getDeployment(id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/resume", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      if (deployment.status !== 'paused') return res.status(400).json({ error: "Only paused deployments can be resumed" });
      const sqliteDb = new Database(DB_PATH);
      sqliteDb.prepare("UPDATE deployments SET status = 'active' WHERE id = ?").run(id);
      logSystem("deployment", "resumed", `Deployment #${id} '${deployment.name}' resumed`);
      res.json(getDeployment(id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/stop", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      if (deployment.status === 'stopped') return res.status(400).json({ error: "Deployment already stopped" });
      const sqliteDb = new Database(DB_PATH);
      // Close all open positions as market-close trades
      const positions = getDeploymentPositions(id);
      const now = istNow();
      for (const pos of positions) {
        const exitPrice = pos.current_price || pos.entry_price;
        const exitValue = exitPrice * pos.quantity;
        const pnl = exitValue - pos.entry_value;
        const pnlPct = (pnl / pos.entry_value) * 100;
        sqliteDb.prepare(`
          INSERT INTO deployment_trades (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, exit_date, exit_time, exit_price, exit_value, pnl, pnl_pct, days_held, exit_reason, exit_reason_detail, setup_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deployment_stopped', 'Deployment stopped by user', ?)
        `).run(id, pos.symbol, pos.name, pos.direction, pos.signal_date, pos.entry_date, pos.entry_time, pos.entry_price, pos.quantity, pos.entry_value, now.split(" ")[0], now, exitPrice, exitValue, pnl, pnlPct, pos.trading_days_held || 0, pos.setup_score);
      }
      // Delete all open positions
      sqliteDb.prepare("DELETE FROM deployment_positions WHERE deployment_id = ?").run(id);
      sqliteDb.prepare("UPDATE deployments SET status = 'stopped' WHERE id = ?").run(id);
      logSystem("deployment", "stopped", `Deployment #${id} '${deployment.name}' stopped — ${positions.length} positions closed`);
      res.json(getDeployment(id));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/funds", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      const { type, amount, note } = req.body;
      if (!type || amount === undefined) return res.status(400).json({ error: "type and amount required" });
      const sqliteDb = new Database(DB_PATH);
      const now = istNow();
      let fundAmount = Number(amount);
      if (type === 'withdraw') fundAmount = -Math.abs(fundAmount);
      else fundAmount = Math.abs(fundAmount);
      const newCapital = deployment.current_capital + fundAmount;
      if (newCapital < 0) return res.status(400).json({ error: "Insufficient funds for withdrawal" });
      sqliteDb.prepare("UPDATE deployments SET current_capital = ? WHERE id = ?").run(newCapital, id);
      sqliteDb.prepare("INSERT INTO fund_transactions (deployment_id, date, type, amount, balance_after, note) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, now, type, fundAmount, newCapital, note || null);
      logSystem("deployment", "fund_transaction", `Deployment #${id}: ${type} ₹${Math.abs(fundAmount)} → balance ₹${newCapital}`);
      res.json({ deployment: getDeployment(id), transaction: { type, amount: fundAmount, balanceAfter: newCapital } });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id/positions", (req, res) => {
    try {
      res.json(getDeploymentPositions(parseInt(req.params.id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id/trades", (req, res) => {
    try {
      res.json(getDeploymentTrades(parseInt(req.params.id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id/snapshots", (req, res) => {
    try {
      res.json(getDeploymentSnapshots(parseInt(req.params.id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id/funds", (req, res) => {
    try {
      res.json(getFundTransactions(parseInt(req.params.id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/deployments/:id/changelog", (req, res) => {
    try {
      res.json(getDeploymentChangelog(parseInt(req.params.id)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Orders Log ───

  app.get("/api/deployments/:id/orders", (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const status = req.query.status as string | undefined;
      const symbol = req.query.symbol as string | undefined;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const orders = getOrdersLog(id, { status, symbol, limit, offset });
      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/orders", (req, res) => {
    try {
      const deploymentId = parseInt(req.params.id);
      const deployment = getDeployment(deploymentId);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      const { symbol, orderType, transactionType, quantity, price, strategy } = req.body;
      if (!symbol || !orderType || !transactionType || !quantity) {
        return res.status(400).json({ error: "symbol, orderType, transactionType, quantity required" });
      }
      const orderId = insertOrder({
        deployment_id: deploymentId,
        symbol,
        order_type: orderType,
        transaction_type: transactionType,
        quantity,
        price: price || undefined,
        status: "PLACED",
        strategy: strategy || deployment.strategy_id,
      });
      logSystem("orders", "order_placed", `Deployment #${deploymentId}: ${transactionType} ${quantity} ${symbol} @ ₹${price || 'MKT'}`);
      res.json(getOrder(orderId));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/orders/:orderId/status", (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const order = getOrder(orderId);
      if (!order) return res.status(404).json({ error: "Order not found" });
      const { status, fillPrice, fillQuantity, kiteOrderId, errorMessage } = req.body;
      if (!status) return res.status(400).json({ error: "status required" });
      updateOrderStatus(orderId, {
        status,
        fill_price: fillPrice,
        fill_quantity: fillQuantity,
        kite_order_id: kiteOrderId,
        error_message: errorMessage,
      });
      logSystem("orders", "status_updated", `Order #${orderId} ${order.symbol}: ${order.status} → ${status}`);
      res.json(getOrder(orderId));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Order Retry ───

  app.post("/api/orders/:orderId/retry", async (req, res) => {
    const orderId = parseInt(req.params.orderId);
    const order = getOrder(orderId);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "FAILED" && order.status !== "REJECTED") {
      return res.status(400).json({ error: "Can only retry FAILED or REJECTED orders" });
    }
    if (!isAuthenticated()) {
      return res.status(400).json({ error: "Kite not connected" });
    }
    try {
      const variety = isMarketOpen() ? "regular" : "amo";
      const response = await throttledKite(k => k.placeOrder(variety, {
        exchange: order.exchange || "NSE",
        tradingsymbol: order.symbol,
        transaction_type: order.transaction_type,
        quantity: order.quantity,
        product: "CNC",
        order_type: order.order_type,
        price: order.price,
      }));
      const kiteOrderId = response?.order_id || null;
      updateOrderStatus(orderId, {
        status: "PLACED",
        kite_order_id: kiteOrderId,
        error_message: undefined,
      });
      logSystem("orders", "retry_placed", `Order #${orderId} ${order.symbol}: retried, new Kite ID ${kiteOrderId}`);
      res.json(getOrder(orderId));
    } catch (err: any) {
      updateOrderStatus(orderId, { status: "FAILED", error_message: `Retry failed: ${err.message}` });
      res.status(500).json({ error: `Retry failed: ${err.message}` });
    }
  });

  // ─── Lifecycle Manual Triggers ───

  app.post("/api/deployments/:id/run-lifecycle", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      logSystem("lifecycle", "manual_trigger", `Manual lifecycle run for deployment #${id}`);
      const result = await runDeploymentLifecycle(id);
      res.json(result);
    } catch (error: any) {
      console.error("[API] Lifecycle error:", error.message);
      res.status(500).json({ error: "Lifecycle failed", message: error.message });
    }
  });

  app.post("/api/deployments/:id/send-brief", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      await sendMorningBrief(id);
      logSystem("telegram", "brief_sent", `Morning brief sent for deployment #${id}`);
      res.json({ success: true, message: "Morning brief sent" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/deployments/:id/send-summary", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deployment = getDeployment(id);
      if (!deployment) return res.status(404).json({ error: "Deployment not found" });
      await sendDailyPnLSummary(id);
      logSystem("telegram", "summary_sent", `Daily P&L summary sent for deployment #${id}`);
      res.json({ success: true, message: "Daily P&L summary sent" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Kite connection test — actually makes a Kite API call to verify
  app.get("/api/kite/test", async (_req, res) => {
    try {
      const status = getKiteStatus();
      if (!status.connected) {
        return res.json({ ok: false, error: "Not connected", status });
      }
      // Try fetching profile — this will fail if token is invalid
      const kite = getKite();
      const profile = await kite.getProfile();
      res.json({ ok: true, user: profile.user_name || profile.user_id, email: profile.email });
    } catch (err: any) {
      res.json({ ok: false, error: err.message, hint: "Token is in memory but rejected by Kite" });
    }
  });

  // Health check
  app.get("/api/health", (_req, res) => {
    for (const [k, v] of Object.entries(process.env)) {
    }
    res.json({
      status: "ok",
      kite: isAuthenticated(),
      timestamp: new Date().toISOString(),
      dbPath: DB_PATH,
      volumeMounted: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
      volumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH || "none",
    });
  });

  // Strategy rules
  app.get("/api/rules", (_req, res) => {
    res.json({
      entry: {
        universe: "NSE stocks with market cap > ₹1,000 Cr",
        uptrendFilter: "Close > 200-day moving average",
        dipTrigger: "Close drops > 3% from prior close",
        volatilityFilter: "(100 × ATR(5) / Close) > 3",
        limitOrder: "Buy at Close - 0.9 × ATR(5) on the next day",
        setupScore: "ATR(5) / Close — higher = preferred",
      },
      exit: {
        timeBased: "Close after 10 trading days",
        priceAction: "Close above previous day's high",
        profitTarget: "Close + 0.5 × ATR(5)",
      },
    });
  });

  // Start auto-refresh scheduler
  startScheduler();

  // Start Telegram bot command polling
  startTelegramBot();

  // Auto-set access token if available in environment
  if (process.env.KITE_ACCESS_TOKEN) {
    setAccessToken(process.env.KITE_ACCESS_TOKEN);
  }

  return httpServer;
}
