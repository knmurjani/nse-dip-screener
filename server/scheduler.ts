import { runScreener, clearCache } from "./screener";
import { runDailyLifecycle } from "./live-portfolio";
import { runAllActiveLifecycles, runAllPreMarketChecks, runAllEndOfDaySummaries } from "./lifecycle";
import { sendSystemAlert } from "./telegram";
import { logSystem, getActiveDeployments } from "./storage";

/**
 * Built-in scheduler — refreshes screener data and runs deployment lifecycles.
 * No external cron needed — runs inside the Node.js process.
 * 
 * Schedule (IST → UTC):
 *   9:15 AM IST (03:45 UTC) — pre-market check: verify Kite, send morning brief
 *   3:15 PM IST (09:45 UTC) — main lifecycle: signals, entries, exits
 *   3:30 PM IST (10:00 UTC) — end-of-day: snapshots, P&L summary, reconciliation
 */

interface ScheduleEntry {
  hour: number;
  minute: number;
  label: string;
  handler: () => Promise<void>;
}

const SCHEDULE: ScheduleEntry[] = [
  {
    hour: 3, minute: 45,
    label: "9:15 AM IST (pre-market check)",
    handler: async () => {
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
    },
  },
  {
    hour: 9, minute: 45,
    label: "3:15 PM IST (main lifecycle)",
    handler: async () => {
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
    },
  },
  {
    hour: 10, minute: 0,
    label: "3:30 PM IST (end-of-day summary)",
    handler: async () => {
      console.log("[Scheduler] Running end-of-day summaries...");
      try {
        await runAllEndOfDaySummaries();
        console.log("[Scheduler] End-of-day summaries complete");
        logSystem("scheduler", "eod_complete", "End-of-day summaries sent for all active deployments");
      } catch (e: any) {
        console.error("[Scheduler] EOD summary failed:", e.message);
        logSystem("scheduler", "eod_error", e.message);
      }
    },
  },
];

function isWeekday(): boolean {
  const day = new Date().getUTCDay();
  return day >= 1 && day <= 5; // Mon-Fri
}

function msUntilNext(targetHour: number, targetMinute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(targetHour, targetMinute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  // Skip weekends
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleEntry(entry: ScheduleEntry) {
  const { hour, minute, label, handler } = entry;

  const run = async () => {
    if (!isWeekday()) {
      console.log(`[Scheduler] Skipping ${label} — weekend`);
    } else {
      console.log(`[Scheduler] Triggering: ${label}`);
      try {
        await handler();
      } catch (e: any) {
        console.error(`[Scheduler] ${label} failed:`, e.message);
      }
    }
    // Schedule next run
    const nextMs = msUntilNext(hour, minute);
    const hrs = Math.floor(nextMs / 3600000);
    const mins = Math.round((nextMs % 3600000) / 60000);
    console.log(`[Scheduler] Next "${label}" in ${hrs}h ${mins}m`);
    setTimeout(run, nextMs);
  };

  const initialMs = msUntilNext(hour, minute);
  const hrs = Math.floor(initialMs / 3600000);
  const mins = Math.round((initialMs % 3600000) / 60000);
  console.log(`[Scheduler] Scheduled: ${label} — first run in ${hrs}h ${mins}m`);
  setTimeout(run, initialMs);
}

export function startScheduler() {
  console.log("[Scheduler] Starting auto-refresh (weekdays only)...");
  for (const entry of SCHEDULE) {
    scheduleEntry(entry);
  }

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
  }, 5000);
}
