import type { Express } from "express";
import { createServer, type Server } from "http";
import { runScreener, clearCache } from "./screener";
import { startScheduler } from "./scheduler";
import { getLoginURL, generateSession, setAccessToken, isAuthenticated, getKite, getKiteStatus, markKiteFailed } from "./kite";
import { getBacktestResult, clearBacktestCache, runBacktest } from "./backtest";
import Database from "better-sqlite3";
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
      const sqlite = new Database("data.db");
      
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
  app.get("/api/backtest/runs", (_req, res) => {
    try {
      const sqlite = new Database("data.db");
      const runs = sqlite.prepare(
        "SELECT id, name, created_at, period_from, period_to, capital, max_positions, universe_size, universe_label, total_trades, annualized_return_pct, total_return_pct, win_rate, sharpe_ratio, max_drawdown_pct, data_source FROM backtest_runs ORDER BY id DESC"
      ).all();
      res.json(runs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Run a new backtest and save it permanently
  app.post("/api/backtest/run", async (req, res) => {
    try {
      const { name, capital, maxPositions, years } = req.body;
      const params = {
        capitalRs: capital || 1000000,
        maxPositions: maxPositions || 10,
        lookbackYears: years || 5,
      };

      console.log(`[API] Running backtest: ${name || 'Unnamed'}, ${params.lookbackYears}yr, ₹${params.capitalRs/1e5}L, ${params.maxPositions} pos`);
      clearBacktestCache();
      const result = await runBacktest(params);

      // Generate auto-name if not provided
      const autoName = name || `${result.period.from} → ${result.period.to} | ${params.maxPositions} pos`;
      const now = new Date().toISOString();

      // Save to database
      const sqlite = new Database("data.db");
      const stmt = sqlite.prepare(`
        INSERT INTO backtest_runs (name, created_at, period_from, period_to, capital, max_positions, universe_size, universe_label, total_trades, annualized_return_pct, total_return_pct, win_rate, sharpe_ratio, max_drawdown_pct, data_source, summary_json, trades_json, snapshots_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        autoName, now, result.period.from, result.period.to,
        params.capitalRs, params.maxPositions,
        result.summary.totalTrades, "Nifty 500",
        result.summary.totalTrades,
        result.summary.annualizedReturnPct,
        result.summary.totalReturnPct,
        result.summary.winningPct,
        result.summary.sharpeRatio,
        result.summary.maxDrawdownPct,
        result.summary.dataSource,
        JSON.stringify(result.summary),
        JSON.stringify(result.trades),
        JSON.stringify(result.dailySnapshots)
      );

      res.json({ id: info.lastInsertRowid, name: autoName, ...result });
    } catch (error: any) {
      console.error("[API] Backtest run error:", error.message);
      res.status(500).json({ error: "Backtest failed", message: error.message });
    }
  });

  // Delete a backtest run
  app.delete("/api/backtest/runs/:id", (req, res) => {
    try {
      const sqlite = new Database("data.db");
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
    res.json({
      status: "ok",
      kite: isAuthenticated(),
      timestamp: new Date().toISOString(),
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
