import type { Express } from "express";
import { createServer, type Server } from "http";
import { runScreener, clearCache } from "./screener";
import { startScheduler } from "./scheduler";
import { getLoginURL, generateSession, setAccessToken, isAuthenticated, getKite, getKiteStatus, markKiteFailed } from "./kite";
import { getBacktestResult, clearBacktestCache } from "./backtest";
import { getFilterBreakdown, clearFilterBreakdownCache } from "./filter-breakdown";
import { getPortfolioSummary, runDailyLifecycle } from "./live-portfolio";

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

  app.get("/api/backtest", async (req, res) => {
    try {
      const capital = parseInt(req.query.capital as string) || 1000000;
      const maxPos = parseInt(req.query.maxPositions as string) || 10;
      const years = parseInt(req.query.years as string) || 5;
      const result = await getBacktestResult({ capitalRs: capital, maxPositions: maxPos, lookbackYears: years });
      res.json(result);
    } catch (error: any) {
      console.error("[API] Backtest error:", error.message);
      res.status(500).json({ error: "Backtest failed", message: error.message });
    }
  });

  app.post("/api/backtest/refresh", async (req, res) => {
    try {
      clearBacktestCache();
      const capital = parseInt(req.query.capital as string) || 1000000;
      const maxPos = parseInt(req.query.maxPositions as string) || 10;
      const years = parseInt(req.query.years as string) || 5;
      const result = await getBacktestResult({ capitalRs: capital, maxPositions: maxPos, lookbackYears: years });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: "Backtest failed", message: error.message });
    }
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
