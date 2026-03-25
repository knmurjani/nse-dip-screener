import type { Express } from "express";
import { createServer, type Server } from "http";
import { runScreener, clearCache } from "./screener";
import { startScheduler } from "./scheduler";
import { getLoginURL, generateSession, setAccessToken, isAuthenticated, getKite, getKiteStatus, markKiteFailed } from "./kite";
import { getBacktestResult, clearBacktestCache, runBacktest } from "./backtest";
import { runBollingerBacktest } from "./backtest-bollinger";
import { runBollingerMRBacktest } from "./backtest-bollinger-mr";
import Database from "better-sqlite3";
import { logSystem, getSystemLogs, getChangelog, DB_PATH } from "./storage";
import { getFilterBreakdown, clearFilterBreakdownCache } from "./filter-breakdown";
import { getPortfolioSummary, runDailyLifecycle } from "./live-portfolio";
import { runBollingerScreener, clearBollingerCache } from "./screener-bollinger";
import { getAllStrategies, getStrategy } from "./strategies";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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
        await generateSession(requestToken);
        clearCache();
        res.redirect("/#/?kite=connected");
      } catch (e: any) {
        res.redirect("/#/?kite=error&msg=" + encodeURIComponent(e.message));
      }
    } else {
      res.redirect("/#/");
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
    try {
      const { name, capital, maxPositions, years, fromDate, toDate, strategyId, absoluteStopPct, trailingStopPct, maPeriod, entryBandSigma, stopLossSigma, targetBandSigma, maxHoldDays, allowParallelPositions } = req.body;
      const strategy = strategyId || "atr_dip_buyer";

      let result;
      const commonParams = { capitalRs: capital || 1000000, maxPositions: maxPositions || 10, lookbackYears: years || 5 };

      if (strategy === "bollinger_mr") {
        result = await runBollingerMRBacktest({
          ...commonParams,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          maPeriod: maPeriod || 20,
          entryBandSigma: entryBandSigma || 2,
          targetBandSigma: targetBandSigma || 2,
          stopLossSigma: stopLossSigma || 2,
          maxHoldDays: maxHoldDays || 0,
          allowParallelPositions: allowParallelPositions || false,
          absoluteStopPct: absoluteStopPct || undefined,
          trailingStopPct: trailingStopPct || undefined,
        });
      } else if (strategy === "bollinger_bounce") {
        result = await runBollingerBacktest({
          ...commonParams,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          maPeriod: maPeriod || 20,
          entryBandSigma: entryBandSigma || 2,
          stopLossSigma: stopLossSigma || 3,
          maxHoldDays: maxHoldDays || 10,
          absoluteStopPct: absoluteStopPct || undefined,
          trailingStopPct: trailingStopPct || undefined,
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
        });
      }

      const strategyLabels: Record<string, string> = { bollinger_mr: "Boll MR", bollinger_bounce: "Bollinger", atr_dip_buyer: "ATR Dip" };
      const autoName = name || `${strategyLabels[strategy] || strategy} | ${result.period.from} → ${result.period.to} | ${commonParams.maxPositions} pos`;
      // IST timestamp
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const now = istNow.toISOString().replace("T", " ").split(".")[0] + " IST";
      const strategyDef = getStrategy(strategy);
      const allParams = {
        ...commonParams, strategyId: strategy, absoluteStopPct, trailingStopPct,
        maPeriod, entryBandSigma, stopLossSigma, maxHoldDays, fromDate, toDate,
        entryRules: strategyDef?.entryRules || [],
        exitRules: strategyDef?.exitRules || [],
      };

      const sqlite = new Database(DB_PATH);
      const stmt = sqlite.prepare(`
        INSERT INTO backtest_runs (name, strategy_id, created_at, period_from, period_to, capital, max_positions, universe_size, universe_label, total_trades, annualized_return_pct, total_return_pct, win_rate, sharpe_ratio, max_drawdown_pct, data_source, params_json, summary_json, trades_json, snapshots_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        autoName, strategy, now, result.period.from, result.period.to,
        commonParams.capitalRs, commonParams.maxPositions,
        result.summary.totalTrades, "Nifty 500",
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

      if (!symbol || !entryDate || !exitDate) {
        return res.status(400).json({ error: "symbol, entryDate, exitDate required" });
      }

      // Fetch bars with extra buffer before entry for MA warmup + context
      const fromD = new Date(entryDate);
      fromD.setDate(fromD.getDate() - (maPeriod + 40)); // extra buffer for MA warmup + visual context
      const toD = new Date(exitDate);
      toD.setDate(toD.getDate() + 10); // show a bit after exit
      const from = fromD.toISOString().split("T")[0];
      const to = toD.toISOString().split("T")[0];

      // Reuse backtest's fetchBars pattern inline
      let bars: { date: string; open: number; high: number; low: number; close: number }[] = [];

      if (isAuthenticated()) {
        try {
          const kite = getKite();
          const instruments = await kite.getInstruments("NSE");
          const clean = symbol.replace(".NS", "");
          const inst = instruments.find((i: any) => i.tradingsymbol === clean && i.segment === "NSE" && i.instrument_type === "EQ");
          if (inst) {
            const data = await kite.getHistoricalData(inst.instrument_token, "day", from, to);
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

      if (bars.length < maPeriod + 5) {
        return res.json({ bars: [], bands: [], entryDate, exitDate });
      }

      // Compute Bollinger Bands for each bar
      const bandData: {
        date: string; close: number; open: number; high: number; low: number;
        ma: number; upperBand: number; lowerBand: number; stopBand: number;
      }[] = [];

      for (let i = 0; i < bars.length; i++) {
        if (i < maPeriod - 1) continue;
        let sum = 0;
        for (let j = i - maPeriod + 1; j <= i; j++) sum += bars[j].close;
        const ma = sum / maPeriod;
        let sumSq = 0;
        for (let j = i - maPeriod + 1; j <= i; j++) sumSq += (bars[j].close - ma) ** 2;
        const std = Math.sqrt(sumSq / maPeriod);

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

  // Auto-set access token if available in environment
  if (process.env.KITE_ACCESS_TOKEN) {
    setAccessToken(process.env.KITE_ACCESS_TOKEN);
  }

  return httpServer;
}
