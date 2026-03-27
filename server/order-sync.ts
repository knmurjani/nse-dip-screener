/**
 * Order Status Sync — polls Kite API to update pending orders.
 * Reuses the same logic as the postback handler for status mapping,
 * position creation, and Telegram notifications.
 */

import Database from "better-sqlite3";
import { isAuthenticated, throttledKite } from "./kite";
import {
  DB_PATH, istNow, logSystem,
  getDeployment, getActiveDeployments,
  getPendingOrders, getOrderByKiteId, updateOrderStatus,
} from "./storage";
import { sendTradeAlert, sendOrderUpdate, sendSystemAlert } from "./telegram";

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

/**
 * Sync order statuses for a single deployment by polling kite.getOrders().
 * Returns a summary of what changed.
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
    return result; // Paper mode doesn't need Kite sync
  }

  if (!isAuthenticated()) {
    result.errors.push("Kite not authenticated");
    return result;
  }

  // Get all pending orders for this deployment
  const pendingOrders = getPendingOrders(deploymentId);
  if (pendingOrders.length === 0) {
    return result; // Nothing to sync
  }

  // Fetch all today's orders from Kite (single API call)
  let kiteOrders: any[];
  try {
    kiteOrders = await throttledKite(k => k.getOrders());
  } catch (err: any) {
    result.errors.push(`Kite getOrders failed: ${err.message}`);
    logSystem("order_sync", "kite_error", `Deployment #${deploymentId}: ${err.message}`);
    return result;
  }

  // Build a lookup map: kite_order_id → kite order object
  const kiteOrderMap = new Map<string, any>();
  for (const ko of kiteOrders) {
    if (ko.order_id) {
      kiteOrderMap.set(String(ko.order_id), ko);
    }
  }

  // Process each pending order
  for (const order of pendingOrders) {
    if (!order.kite_order_id) continue;

    const kiteOrder = kiteOrderMap.get(String(order.kite_order_id));
    if (!kiteOrder) continue; // Order not found in today's Kite session

    const kiteStatus = kiteOrder.status;
    const mappedStatus = STATUS_MAP[kiteStatus] || kiteStatus;

    // Skip if status hasn't changed
    if (mappedStatus === order.status) continue;

    const filledQty = kiteOrder.filled_quantity || 0;
    const averagePrice = kiteOrder.average_price || 0;
    const statusMessage = kiteOrder.status_message || "";
    const tradingsymbol = kiteOrder.tradingsymbol || order.symbol;
    const transactionType = kiteOrder.transaction_type || order.transaction_type;

    try {
      // Update order status in orders_log
      updateOrderStatus(order.id, {
        status: mappedStatus,
        fill_price: averagePrice > 0 ? averagePrice : undefined,
        fill_quantity: filledQty > 0 ? filledQty : undefined,
        error_message: kiteStatus === "REJECTED" ? statusMessage : undefined,
      });

      result.synced++;

      // Send Telegram order update for terminal statuses
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
          const sqliteDb = new Database(DB_PATH);
          const now = istNow();
          const dateStr = now.split(" ")[0];
          const entryPrice = averagePrice > 0 ? averagePrice : order.price;
          const qty = filledQty > 0 ? filledQty : order.quantity;
          const entryValue = Math.round(entryPrice * qty);

          // Check for duplicate position
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

            try {
              await sendTradeAlert("ENTRY", {
                symbol: tradingsymbol,
                price: entryPrice,
                quantity: qty,
                strategy: order.strategy,
              });
            } catch { /* Telegram failure OK */ }
          }
        } catch (err: any) {
          result.errors.push(`Position creation for ${tradingsymbol}: ${err.message}`);
          logSystem("order_sync", "position_error", `${tradingsymbol}: ${err.message}`);
        }
      }

      // SELL COMPLETE → close position (move to trades)
      if (mappedStatus === "COMPLETE" && (transactionType === "SELL" || order.transaction_type === "SELL")) {
        result.filled++;
        try {
          const sqliteDb = new Database(DB_PATH);
          const now = istNow();
          const dateStr = now.split(" ")[0];
          const exitPrice = averagePrice > 0 ? averagePrice : order.price;
          const qty = filledQty > 0 ? filledQty : order.quantity;

          // Find matching open position
          const position = sqliteDb.prepare(
            "SELECT * FROM deployment_positions WHERE deployment_id = ? AND symbol = ?"
          ).get(order.deployment_id, tradingsymbol) as any;

          if (position) {
            const exitValue = Math.round(exitPrice * qty);
            const pnl = exitValue - position.entry_value;
            const pnlPct = ((exitPrice - position.entry_price) / position.entry_price) * 100;
            const daysHeld = position.trading_days_held || 0;

            // Insert closed trade
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

            // Remove open position
            sqliteDb.prepare("DELETE FROM deployment_positions WHERE id = ?").run(position.id);

            // Update deployment stats
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

            try {
              await sendTradeAlert("EXIT", {
                symbol: tradingsymbol,
                price: exitPrice,
                quantity: qty,
                strategy: order.strategy,
                pnl: Math.round(pnl * 100) / 100,
                pnlPct: Math.round(pnlPct * 100) / 100,
                exitReason: "Kite sell filled",
                daysHeld,
              });
            } catch { /* Telegram failure OK */ }
          } else {
            logSystem("order_sync", "sell_no_position", `${tradingsymbol}: SELL filled but no open position found`);
          }
        } catch (err: any) {
          result.errors.push(`Position close for ${tradingsymbol}: ${err.message}`);
          logSystem("order_sync", "close_error", `${tradingsymbol}: ${err.message}`);
        }
      }

      // REJECTED → alert
      if (mappedStatus === "REJECTED") {
        result.rejected++;
        logSystem("order_sync", "order_rejected", `${tradingsymbol} ${transactionType}: ${statusMessage}`);
        try {
          await sendSystemAlert("Order Rejected", `${tradingsymbol} ${transactionType} rejected: ${statusMessage}`);
        } catch { /* Telegram failure OK */ }
      }

      // CANCELLED
      if (mappedStatus === "CANCELLED") {
        result.cancelled++;
      }
    } catch (err: any) {
      result.errors.push(`${tradingsymbol}: ${err.message}`);
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
