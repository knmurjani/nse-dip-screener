import { runScreener, clearCache } from "./screener";
import { runDailyLifecycle } from "./live-portfolio";

/**
 * Built-in scheduler — refreshes screener data at configured times.
 * No external cron needed — runs inside the Node.js process.
 * 
 * Schedule:
 *   3:15 PM IST (09:45 UTC) — 15 min before market close, signals ready for limit orders
 *   9:15 AM IST (03:45 UTC) — market open refresh
 */

const REFRESH_TIMES_UTC = [
  { hour: 9, minute: 45, label: "3:15 PM IST (pre-close signals)" },
  { hour: 3, minute: 45, label: "9:15 AM IST (market open)" },
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

function scheduleRefresh(hour: number, minute: number, label: string) {
  const run = async () => {
    if (!isWeekday()) {
      console.log(`[Scheduler] Skipping ${label} — weekend`);
    } else {
      console.log(`[Scheduler] Triggering refresh: ${label}`);
      try {
        clearCache();
        const result = await runScreener();
        console.log(
          `[Scheduler] Screener: ${result.stats.totalScanned} stocks, ${result.stats.signalsGenerated} signals`
        );
        // Run live portfolio lifecycle
        await runDailyLifecycle();
        console.log(`[Scheduler] Live portfolio lifecycle complete`);
      } catch (e: any) {
        console.error(`[Scheduler] Refresh failed:`, e.message);
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
  for (const { hour, minute, label } of REFRESH_TIMES_UTC) {
    scheduleRefresh(hour, minute, label);
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
