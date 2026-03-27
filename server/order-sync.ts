/**
 * Order Status Sync — polls Kite API to update pending orders.
 * Supports cross-day reconciliation via kite.getOrderHistory(orderId).
 *
 * kite.getOrders()           — returns today's orders only (bulk, efficient)
 * kite.getOrderHistory(id)   — returns full history for a specific order across sessions
 */

import Database from "better-sqlite3";
import { isAuthenticated, throttledKite } from "./kite";
import {
  DB_PATH, istNow, logSystem,
  getDeployment, getActiveDeployments,
  getPendingOrders, getAllPendingOrders, updateOrderStatus,
} from "./storage";
import { sendTradeAlert, sendOrderUpdate, sendSystemAlert, sendTelegramMessage } from "./telegram";

// Kite status → internal status (same as postback handler)
const STATUS_MAP: Record<string, string> = {
  "COMPLETE": "COMPLETE",
  "CANCELLED": "CANCELLED",
  "REJECTED": "REJECTED",
  "OPEN": "OPEN",
  "TRIGGER PENDING": "OPEN",
  "OPEN PENDING": "OPEN",
  "VALIDATION PENDING": "OPEN",
  "PUT ORDER REQ RECEIVED": "PLACED",
};

export interface SyncResult {
  deploymentId: number;
  synced: number;
  filled: number;
  rejected: number;
  cancelled: number;
  errors: string[];
}

export interface ReconcileResult {
  total: number;
  filled: number;
  rejected: number;
  cancelled: number;
  stillPending: number;
  errors: string[];
}

// ─── Shared helpers for position creation / closure ───

function createPositionFromFill(order: any, tradingsymbol: string, averagePrice: number, filledQty: number): void {
  const sqliteDb = new Database(DB_PATH);
  const now = istNow();
  const dateStr = now.split(" ")[0];
  const entryPrice = averagePrice > 0 ? averagePrice : order.price;
  const qty = filledQty > 0 ? filledQty : order.quantity;
  const entryValue = Math.round(entryPrice * qty);

  const existing = sqliteDb.prepare(
    "SELECT id FROM deployment_positions WHERE deployment_id = ? AND symbol = ?"
  ).get(order.deployment_id, tradingsymbol) as any;

  if (!existing) {
    sqliteDb.prepare(`
      INSERT INTO deployment_positions (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, current_price, current_value, pnl, pnl_pct, trading_days_held, peak_price, setup_score, last_updated)
      VALUES (?, ?, ?, 'LONG', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
    `).run(
      order.deployment_id,
      tradingsymbol, tradingsymbol,
      dateStr, dateStr, now,
      Math.round(entryPrice * 100) / 100, qty, entryValue,
      Math.round(entryPrice * 100) / 100, entryValue,
      Math.round(entryPrice * 100) / 100,
      null, dateStr
    );
    logSystem("order_sync", "position_created", `${tradingsymbol}: ${qty} shares @ ₹${entryPrice.toFixed(2)} — from Kite sync`);
  }
}

function closePositionFromFill(order: any, tradingsymbol: string, averagePrice: number, filledQty: number): { pnl: number; pnlPct: number; daysHeld: number } | null {
  const sqliteDb = new Database(DB_PATH);
  const now = istNow();
  const dateStr = now.split(" ")[0];
  const exitPrice = averagePrice > 0 ? averagePrice : order.price;
  const qty = filledQty > 0 ? filledQty : order.quantity;

  const position = sqliteDb.prepare(
    "SELECT * FROM deployment_positions WHERE deployment_id = ? AND symbol = ?"
  ).get(order.deployment_id, tradingsymbol) as any;

  if (!position) {
    logSystem("order_sync", "sell_no_position", `${tradingsymbol}: SELL filled but no open position found`);
    return null;
  }

  const exitValue = Math.round(exitPrice * qty);
  const pnl = exitValue - position.entry_value;
  const pnlPct = ((exitPrice - position.entry_price) / position.entry_price) * 100;
  const daysHeld = position.trading_days_held || 0;

  sqliteDb.prepare(`
    INSERT INTO deployment_trades (deployment_id, symbol, name, direction, signal_date, entry_date, entry_time, entry_price, quantity, entry_value, exit_date, exit_time, exit_price, exit_value, pnl, pnl_pct, days_held, exit_reason, exit_reason_detail, setup_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.deployment_id,
    position.symbol, position.name, position.direction,
    position.signal_date, position.entry_date, position.entry_time,
    position.entry_price, position.quantity, position.entry_value,
    dateStr, now, Math.round(exitPrice * 100) / 100, exitValue,
    Math.round(pnl * 100) / 100, Math.round(pnlPct * 100) / 100,
    daysHeld, "Kite sell filled", null, position.setup_score
  );

  sqliteDb.prepare("DELETE FROM deployment_positions WHERE id = ?").run(position.id);

  const winIncrement = pnl > 0 ? 1 : 0;
  sqliteDb.prepare(`
    UPDATE deployments SET
      total_trades = total_trades + 1,
      winning_trades = winning_trades + ?,
      realized_pnl = realized_pnl + ?,
      current_capital = current_capital + ?
    WHERE id = ?
  `).run(winIncrement, Math.round(pnl * 100) / 100, exitValue, order.deployment_id);

  logSystem("order_sync", "position_closed", `${tradingsymbol}: SELL ${qty} @ ₹${exitPrice.toFixed(2)} | P&L: ₹${pnl.toFixed(2)} — from Kite sync`);
  return { pnl: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100, daysHeld };
}

/** Process a single order update: update DB, send notifications, create/close positions. */
async function processOrderUpdate(
  order: any,
  kiteStatus: string,
  filledQty: number,
  averagePrice: number,
  statusMessage: string,
  tradingsymbol: string,
  transactionType: string,
  result: SyncResult,
): Promise<void> {
  const mappedStatus = STATUS_MAP[kiteStatus] || kiteStatus;
  if (mappedStatus === order.status) return; // No change

  updateOrderStatus(order.id, {
    status: mappedStatus,
    fill_price: averagePrice > 0 ? averagePrice : undefined,
    fill_quantity: filledQty > 0 ? filledQty : undefined,
    error_message: kiteStatus === "REJECTED" ? statusMessage : undefined,
  });

  result.synced++;

  // Telegram for terminal statuses
  if (["COMPLETE", "CANCELLED", "REJECTED"].includes(mappedStatus)) {
    try {
      await sendOrderUpdate({
        symbol: tradingsymbol,
        orderType: order.order_type,
        transactionType,
        price: order.price,
        quantity: filledQty || order.quantity,
        status: mappedStatus,
        fillPrice: averagePrice > 0 ? averagePrice : undefined,
        kiteOrderId: String(order.kite_order_id),
      });
    } catch { /* Telegram failure OK */ }
  }

  // BUY COMPLETE → create position
  if (mappedStatus === "COMPLETE" && (transactionType === "BUY" || order.transaction_type === "BUY")) {
    result.filled++;
    try {
      createPositionFromFill(order, tradingsymbol, averagePrice, filledQty);
      try {
        await sendTradeAlert("ENTRY", {
          symbol: tradingsymbol,
          price: averagePrice > 0 ? averagePrice : order.price,
          quantity: filledQty > 0 ? filledQty : order.quantity,
          strategy: order.strategy,
        });
      } catch { /* Telegram failure OK */ }
    } catch (err: any) {
      result.errors.push(`Position creation for ${tradingsymbol}: ${err.message}`);
      logSystem("order_sync", "position_error", `${tradingsymbol}: ${err.message}`);
    }
  }

  // SELL COMPLETE → close position
  if (mappedStatus === "COMPLETE" && (transactionType === "SELL" || order.transaction_type === "SELL")) {
    result.filled++;
    try {
      const closed = closePositionFromFill(order, tradingsymbol, averagePrice, filledQty);
      if (closed) {
        try {
          await sendTradeAlert("EXIT", {
            symbol: tradingsymbol,
            price: averagePrice > 0 ? averagePrice : order.price,
            quantity: filledQty > 0 ? filledQty : order.quantity,
            strategy: order.strategy,
            pnl: closed.pnl,
            pnlPct: closed.pnlPct,
            exitReason: "Kite sell filled",
            daysHeld: closed.daysHeld,
          });
        } catch { /* Telegram failure OK */ }
      }
    } catch (err: any) {
      result.errors.push(`Position close for ${tradingsymbol}: ${err.message}`);
      logSystem("order_sync", "close_error", `${tradingsymbol}: ${err.message}`);
    }
  }

  if (mappedStatus === "REJECTED") {
    result.rejected++;
    logSystem("order_sync", "order_rejected", `${tradingsymbol} ${transactionType}: ${statusMessage}`);
    try {
      await sendSystemAlert("Order Rejected", `${tradingsymbol} ${transactionType} rejected: ${statusMessage}`);
    } catch { /* Telegram failure OK */ }
  }

  if (mappedStatus === "CANCELLED") {
    result.cancelled++;
  }
}

// ─── Today's date in IST (YYYY-MM-DD) ───
function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** Check if an order was placed today (IST). */
function isOrderFromToday(order: any): boolean {
  if (!order.placed_at) return true; // If no date, assume today
  const placedDate = order.placed_at.split(" ")[0]; // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DD"
  return placedDate === todayIST();
}

/**
 * Fetch the final status of a single order using kite.getOrderHistory().
 * Returns the last entry in the order history array (final status).
 */
async function fetchOrderHistoryStatus(kiteOrderId: string): Promise<any | null> {
  try {
    const history = await throttledKite(k => k.getOrderHistory(kiteOrderId));
    if (!Array.isArray(history) || history.length === 0) return null;
    return history[history.length - 1]; // Last entry = final/current status
  } catch (err: any) {
    // Order may have been too old or invalid
    logSystem("order_sync", "history_error", `Order ${kiteOrderId}: ${err.message}`);
    return null;
  }
}

/**
 * Sync order statuses for a single deployment.
 * - Orders placed TODAY: uses kite.getOrders() (bulk, efficient)
 * - Orders placed on PREVIOUS days: uses kite.getOrderHistory(orderId) per order
 */
export async function syncDeploymentOrders(deploymentId: number): Promise<SyncResult> {
  const result: SyncResult = {
    deploymentId,
    synced: 0,
    filled: 0,
    rejected: 0,
    cancelled: 0,
    errors: [],
  };

  const deployment = getDeployment(deploymentId);
  if (!deployment) {
    result.errors.push("Deployment not found");
    return result;
  }

  if (deployment.mode !== "real") {
    return result;
  }

  if (!isAuthenticated()) {
    result.errors.push("Kite not authenticated");
    return result;
  }

  const pendingOrders = getPendingOrders(deploymentId);
  if (pendingOrders.length === 0) {
    return result;
  }

  // Separate today's orders from stale (previous-day) orders
  const todayOrders = pendingOrders.filter(o => isOrderFromToday(o));
  const staleOrders = pendingOrders.filter(o => !isOrderFromToday(o));

  // ─── Today's orders: bulk fetch via getOrders() ───
  if (todayOrders.length > 0) {
    let kiteOrders: any[];
    try {
      kiteOrders = await throttledKite(k => k.getOrders());
    } catch (err: any) {
      result.errors.push(`Kite getOrders failed: ${err.message}`);
      logSystem("order_sync", "kite_error", `Deployment #${deploymentId}: ${err.message}`);
      kiteOrders = [];
    }

    const kiteOrderMap = new Map<string, any>();
    for (const ko of kiteOrders) {
      if (ko.order_id) kiteOrderMap.set(String(ko.order_id), ko);
    }

    for (const order of todayOrders) {
      if (!order.kite_order_id) continue;
      const kiteOrder = kiteOrderMap.get(String(order.kite_order_id));
      if (!kiteOrder) continue;

      try {
        await processOrderUpdate(
          order, kiteOrder.status,
          kiteOrder.filled_quantity || 0, kiteOrder.average_price || 0,
          kiteOrder.status_message || "",
          kiteOrder.tradingsymbol || order.symbol,
          kiteOrder.transaction_type || order.transaction_type,
          result,
        );
      } catch (err: any) {
        result.errors.push(`${order.symbol}: ${err.message}`);
      }
    }
  }

  // ─── Stale orders: individual getOrderHistory() calls ───
  for (const order of staleOrders) {
    if (!order.kite_order_id) continue;

    try {
      const kiteOrder = await fetchOrderHistoryStatus(String(order.kite_order_id));
      if (!kiteOrder) continue;

      await processOrderUpdate(
        order, kiteOrder.status,
        kiteOrder.filled_quantity || 0, kiteOrder.average_price || 0,
        kiteOrder.status_message || "",
        kiteOrder.tradingsymbol || order.symbol,
        kiteOrder.transaction_type || order.transaction_type,
        result,
      );
    } catch (err: any) {
      result.errors.push(`${order.symbol} (history): ${err.message}`);
    }
  }

  if (result.synced > 0) {
    logSystem("order_sync", "sync_complete",
      `Deployment #${deploymentId}: synced ${result.synced} orders (${result.filled} filled, ${result.rejected} rejected, ${result.cancelled} cancelled)`
    );
  }

  return result;
}

/**
 * Sync orders for all active real-mode deployments that have pending orders.
 * Called by the scheduler every 5 minutes during market hours.
 */
export async function syncAllPendingOrders(): Promise<SyncResult[]> {
  const deployments = getActiveDeployments();
  const realDeployments = deployments.filter((d: any) => d.mode === "real");

  if (realDeployments.length === 0) return [];

  const results: SyncResult[] = [];

  for (const deployment of realDeployments) {
    const pending = getPendingOrders(deployment.id);
    if (pending.length === 0) continue;

    try {
      const result = await syncDeploymentOrders(deployment.id);
      results.push(result);
    } catch (err: any) {
      results.push({
        deploymentId: deployment.id,
        synced: 0, filled: 0, rejected: 0, cancelled: 0,
        errors: [err.message],
      });
    }
  }

  return results;
}

/**
 * Reconcile ALL pending orders across all deployments using getOrderHistory().
 * This is the key function for catching AMO fills from previous days.
 * Called on login, startup, and manual "Reconcile All" button.
 */
export async function reconcilePendingOrders(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    total: 0,
    filled: 0,
    rejected: 0,
    cancelled: 0,
    stillPending: 0,
    errors: [],
  };

  if (!isAuthenticated()) {
    result.errors.push("Kite not authenticated");
    return result;
  }

  const allPending = getAllPendingOrders();
  result.total = allPending.length;

  if (allPending.length === 0) {
    return result;
  }

  logSystem("reconcile", "started", `Reconciling ${allPending.length} pending orders via getOrderHistory`);

  // Build per-deployment SyncResult accumulators
  const deploymentResults = new Map<number, SyncResult>();

  for (const order of allPending) {
    if (!order.kite_order_id) continue;

    // Get or create SyncResult for this deployment
    if (!deploymentResults.has(order.deployment_id)) {
      deploymentResults.set(order.deployment_id, {
        deploymentId: order.deployment_id,
        synced: 0, filled: 0, rejected: 0, cancelled: 0, errors: [],
      });
    }
    const syncResult = deploymentResults.get(order.deployment_id)!;

    try {
      const kiteOrder = await fetchOrderHistoryStatus(String(order.kite_order_id));
      if (!kiteOrder) {
        result.stillPending++;
        continue;
      }

      const mappedStatus = STATUS_MAP[kiteOrder.status] || kiteOrder.status;

      if (mappedStatus === order.status) {
        result.stillPending++;
        continue;
      }

      await processOrderUpdate(
        order, kiteOrder.status,
        kiteOrder.filled_quantity || 0, kiteOrder.average_price || 0,
        kiteOrder.status_message || "",
        kiteOrder.tradingsymbol || order.symbol,
        kiteOrder.transaction_type || order.transaction_type,
        syncResult,
      );

      // Aggregate into reconcile result
      if (mappedStatus === "COMPLETE") result.filled++;
      else if (mappedStatus === "REJECTED") result.rejected++;
      else if (mappedStatus === "CANCELLED") result.cancelled++;
      else result.stillPending++;
    } catch (err: any) {
      result.errors.push(`${order.symbol}: ${err.message}`);
      result.stillPending++;
    }
  }

  // Log summary
  const summary = `Reconciled ${result.total} orders: ${result.filled} filled, ${result.rejected} rejected, ${result.cancelled} cancelled, ${result.stillPending} still pending`;
  logSystem("reconcile", "complete", summary);

  // Send Telegram summary if anything changed
  if (result.filled > 0 || result.rejected > 0 || result.cancelled > 0) {
    try {
      const parts = [];
      if (result.filled > 0) parts.push(`${result.filled} filled`);
      if (result.rejected > 0) parts.push(`${result.rejected} rejected`);
      if (result.cancelled > 0) parts.push(`${result.cancelled} cancelled`);
      if (result.stillPending > 0) parts.push(`${result.stillPending} still pending`);
      await sendTelegramMessage(
        `🔄 <b>Order Reconciliation</b>\nChecked ${result.total} pending orders:\n${parts.join(", ")}`
      );
    } catch { /* Telegram failure OK */ }
  }

  return result;
}
