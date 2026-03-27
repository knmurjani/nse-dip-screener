import cron from "node-cron";
import { runScreener, clearCache } from "./screener";
import { runDailyLifecycle } from "./live-portfolio";
import { runAllActiveLifecycles, runAllPreMarketChecks, runAllEndOfDaySummaries, isMarketOpen } from "./lifecycle";
import { sendSystemAlert, sendTelegramMessage } from "./telegram";
import { logSystem, getActiveDeployments } from "./storage";
import { isAuthenticated } from "./kite";
import { syncAllPendingOrders, reconcilePendingOrders } from "./order-sync";

/**
 * Cron-based scheduler — refreshes screener data and runs deployment lifecycles.
 * No external cron needed — runs inside the Node.js process via node-cron.
 *
 * Schedule (IST → UTC):
 *   8:45 AM IST (03:15 UTC) — Kite token expiry reminder
 *   9:15 AM IST (03:45 UTC) — pre-market check: verify Kite, send morning brief
 *   3:15 PM IST (09:45 UTC) — main lifecycle: signals, entries, exits
 *   3:30 PM IST (10:00 UTC) — end-of-day: snapshots, P&L summary, reconciliation
 */

const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login?v=3&api_key=qdjxlkbtg8gy0ec3";

export function startScheduler() {
  console.log("[Scheduler] Starting cron-based scheduler (weekdays only)...");

  // 8:45 AM IST = 3:15 AM UTC — Kite token check
  cron.schedule("15 3 * * 1-5", async () => {
    console.log("[Scheduler] Checking Kite token for morning reminder...");
    try {
      if (!isAuthenticated()) {
        await sendTelegramMessage(
          [
            "⏰ <b>Good Morning! Kite token expired.</b>",
            "",
            "Click to re-authenticate for today's session:",
            `<a href="${KITE_LOGIN_URL}">Login to Zerodha</a>`,
            "",
            "Pre-market check runs at 9:15 AM IST.",
          ].join("\n")
        );
        console.log("[Scheduler] Kite token expiry reminder sent");
      } else {
        console.log("[Scheduler] Kite already connected — no reminder needed");
      }
    } catch (e: any) {
      console.error("[Scheduler] Token reminder error:", e.message);
    }
  });

  // 9:15 AM IST = 3:45 AM UTC — Pre-market check
  cron.schedule("45 3 * * 1-5", async () => {
    console.log("[Scheduler] Running pre-market checks for active deployments...");
    try {
      await runAllPreMarketChecks();
      console.log("[Scheduler] Pre-market checks complete");
    } catch (e: any) {
      console.error("[Scheduler] Pre-market check error:", e.message);
      logSystem("scheduler", "pre_market_error", e.message);
    }
    // Also refresh screener data
    try {
      clearCache();
      const result = await runScreener();
      console.log(`[Scheduler] Screener: ${result.stats.totalScanned} stocks, ${result.stats.signalsGenerated} signals`);
    } catch (e: any) {
      console.error("[Scheduler] Screener refresh failed:", e.message);
    }
  });

  // 3:15 PM IST = 9:45 AM UTC — Main lifecycle
  cron.schedule("45 9 * * 1-5", async () => {
    console.log("[Scheduler] Running main lifecycle for active deployments...");
    try {
      // Refresh screener first
      clearCache();
      await runScreener();
    } catch (e: any) {
      console.error("[Scheduler] Screener refresh failed:", e.message);
    }
    // Run legacy live portfolio lifecycle
    try {
      await runDailyLifecycle();
      console.log("[Scheduler] Legacy live portfolio lifecycle complete");
    } catch (e: any) {
      console.error("[Scheduler] Legacy lifecycle failed:", e.message);
    }
    // Run deployment-based lifecycle for all active deployments
    try {
      const results = await runAllActiveLifecycles();
      const total = results.length;
      const entries = results.reduce((s, r) => s + r.entriesPlaced, 0);
      const exits = results.reduce((s, r) => s + r.exitsExecuted, 0);
      console.log(`[Scheduler] Deployment lifecycle: ${total} deployments, ${entries} entries, ${exits} exits`);
      logSystem("scheduler", "lifecycle_complete", `${total} deployments processed, ${entries} entries, ${exits} exits`);
    } catch (e: any) {
      console.error("[Scheduler] Deployment lifecycle failed:", e.message);
      logSystem("scheduler", "lifecycle_error", e.message);
      try { await sendSystemAlert("Scheduler Error", `Lifecycle run failed: ${e.message}`); } catch {}
    }
  });

  // 3:30 PM IST = 10:00 AM UTC — End-of-day summary
  cron.schedule("0 10 * * 1-5", async () => {
    console.log("[Scheduler] Running end-of-day summaries...");
    try {
      await runAllEndOfDaySummaries();
      console.log("[Scheduler] End-of-day summaries complete");
      logSystem("scheduler", "eod_complete", "End-of-day summaries sent for all active deployments");
    } catch (e: any) {
      console.error("[Scheduler] EOD summary failed:", e.message);
      logSystem("scheduler", "eod_error", e.message);
    }
  });

  // Every 5 minutes during market hours — sync pending order statuses from Kite
  // 9:15 AM - 3:30 PM IST weekdays; isMarketOpen() guards the actual execution
  cron.schedule("*/5 * * * 1-5", async () => {
    if (!isMarketOpen()) return;
    if (!isAuthenticated()) return;
    try {
      const results = await syncAllPendingOrders();
      const totalSynced = results.reduce((s, r) => s + r.synced, 0);
      if (totalSynced > 0) {
        console.log(`[Scheduler] Order sync: ${totalSynced} orders updated across ${results.length} deployments`);
        logSystem("scheduler", "order_sync", `${totalSynced} orders synced across ${results.length} deployments`);
      }
    } catch (e: any) {
      console.error("[Scheduler] Order sync error:", e.message);
      logSystem("scheduler", "order_sync_error", e.message);
    }
  });

  // Initial data load on startup (5s delay)
  setTimeout(async () => {
    console.log("[Scheduler] Running initial data load...");
    try {
      const result = await runScreener();
      console.log(
        `[Scheduler] Initial load: ${result.stats.totalScanned} stocks, ${result.stats.signalsGenerated} signals`
      );
    } catch (e: any) {
      console.error("[Scheduler] Initial load failed:", e.message);
    }

    // Reconcile pending orders on startup if Kite is authenticated
    if (isAuthenticated()) {
      try {
        console.log("[Scheduler] Running startup order reconciliation...");
        const reconcileResult = await reconcilePendingOrders();
        if (reconcileResult.total > 0) {
          console.log(`[Scheduler] Startup reconciliation: ${reconcileResult.filled} filled, ${reconcileResult.rejected} rejected, ${reconcileResult.cancelled} cancelled out of ${reconcileResult.total}`);
        } else {
          console.log("[Scheduler] No pending orders to reconcile on startup");
        }
      } catch (e: any) {
        console.error("[Scheduler] Startup reconciliation failed:", e.message);
      }
    } else {
      console.log("[Scheduler] Kite not authenticated — skipping startup reconciliation");
    }
  }, 5000);
}
