/**
 * Telegram Notification Module
 * Sends trade alerts, watchlist updates, risk warnings, and daily summaries.
 * All Telegram calls are try/caught so failures never break trading logic.
 */

import { getDeployment, getDeploymentPositions, getDeploymentTrades, getDeploymentSnapshots, istNow } from "./storage";

// ─── Config ───

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8682452975:AAEPCOG2hYG_mcgFU2u7BGU-arFEyoOT6iM";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "941382795";

// ─── Types ───

export interface TradeDetails {
  symbol: string;
  price: number;
  quantity: number;
  strategy: string;
  limitPrice?: number;
  pnl?: number;
  pnlPct?: number;
  exitReason?: string;
  daysHeld?: number;
}

export interface OrderDetails {
  symbol: string;
  orderType: string;       // 'LIMIT', 'MARKET', 'SL', 'SL-M'
  transactionType: string; // 'BUY', 'SELL'
  price: number;
  quantity: number;
  status: string;
  fillPrice?: number;
  kiteOrderId?: string;
}

// ─── Core Send Function ───

export async function sendTelegramMessage(text: string, parseMode: "HTML" | "Markdown" = "HTML"): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[Telegram] Send failed (${response.status}): ${err}`);

      // Retry once after 1s for rate limits
      if (response.status === 429) {
        await new Promise(r => setTimeout(r, 1000));
        const retry = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: true,
          }),
        });
        return retry.ok;
      }
      return false;
    }
    return true;
  } catch (error: any) {
    console.error(`[Telegram] Send error: ${error.message}`);
    return false;
  }
}

// ─── Specific Notification Types ───

export async function sendTradeAlert(type: "ENTRY" | "EXIT", trade: TradeDetails): Promise<void> {
  try {
    let msg: string;
    if (type === "ENTRY") {
      const limitPart = trade.limitPrice ? ` | Limit ₹${fmtNum(trade.limitPrice)} placed` : "";
      msg = `🟢 <b>BUY ${trade.symbol}</b> @ ₹${fmtNum(trade.price)} | Qty: ${trade.quantity} | Strategy: ${trade.strategy}${limitPart}`;
    } else {
      const pnlSign = (trade.pnl || 0) >= 0 ? "+" : "";
      const pnlPctSign = (trade.pnlPct || 0) >= 0 ? "+" : "";
      msg = `🔴 <b>SELL ${trade.symbol}</b> @ ₹${fmtNum(trade.price)} | P&amp;L: ${pnlSign}₹${fmtNum(trade.pnl || 0)} (${pnlPctSign}${(trade.pnlPct || 0).toFixed(2)}%) | Reason: ${trade.exitReason || "N/A"} | Held ${trade.daysHeld || 0} days`;
    }
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Trade alert error: ${error.message}`);
  }
}

export async function sendWatchlistUpdate(strategy: string, added: string[], removed: string[]): Promise<void> {
  try {
    const addedPart = added.length > 0 ? `\n➕ Added: ${added.join(", ")}` : "";
    const removedPart = removed.length > 0 ? `\n➖ Removed: ${removed.join(", ")}` : "";
    const total = added.length + removed.length;
    const msg = `📋 <b>${strategy} Watchlist</b>${addedPart}${removedPart}\nTotal changes: ${total} stocks`;
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Watchlist update error: ${error.message}`);
  }
}

export async function sendKiteDisconnectWarning(error: string): Promise<void> {
  try {
    const time = istNow();
    const msg = `⚠️ <b>KITE DISCONNECTED</b>\nError: ${escapeHtml(error)}\nTime: ${time}\nAction: Re-authenticate in the dashboard`;
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Kite disconnect warning error: ${(error as Error).message}`);
  }
}

export async function sendOrderUpdate(order: OrderDetails): Promise<void> {
  try {
    const kiteIdPart = order.kiteOrderId ? `\nKite Order ID: ${order.kiteOrderId}` : "";
    const fillPart = order.fillPrice ? ` | Fill: ₹${fmtNum(order.fillPrice)}` : "";
    const msg = `📝 <b>ORDER UPDATE</b>\n${order.symbol} ${order.orderType} ${order.transactionType} @ ₹${fmtNum(order.price)}\nStatus: ${order.status}${fillPart} | Qty: ${order.quantity}${kiteIdPart}`;
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Order update error: ${error.message}`);
  }
}

export async function sendDailyPnLSummary(deploymentId: number): Promise<void> {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment) return;

    const positions = getDeploymentPositions(deploymentId);
    const trades = getDeploymentTrades(deploymentId);
    const snapshots = getDeploymentSnapshots(deploymentId);

    const investedValue = positions.reduce((s: number, p: any) => s + (p.current_value || p.entry_value), 0);
    const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
    const totalRealizedPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);
    const cash = deployment.current_capital;
    const portfolioValue = cash + investedValue;
    const returnPct = ((portfolioValue - deployment.initial_capital) / deployment.initial_capital * 100).toFixed(2);

    // Today's trades
    const todayStr = istNow().split(" ")[0];
    const todayTrades = trades.filter((t: any) => t.exit_date && t.exit_date.startsWith(todayStr));
    const todayPnl = todayTrades.reduce((s: number, t: any) => s + t.pnl, 0);

    const msg = [
      `📊 <b>Daily P&amp;L Summary — ${deployment.name}</b>`,
      ``,
      `Portfolio Value: ₹${fmtNum(portfolioValue)}`,
      `Day's P&amp;L: ${todayPnl >= 0 ? "+" : ""}₹${fmtNum(todayPnl)}`,
      `Open Positions: ${positions.length}`,
      `Trades Today: ${todayTrades.length}`,
      `Total Return: ${returnPct}%`,
      `Unrealized P&amp;L: ${unrealizedPnl >= 0 ? "+" : ""}₹${fmtNum(unrealizedPnl)}`,
      `Realized P&amp;L: ${totalRealizedPnl >= 0 ? "+" : ""}₹${fmtNum(totalRealizedPnl)}`,
    ].join("\n");

    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Daily P&L summary error: ${error.message}`);
  }
}

export async function sendMorningBrief(deploymentId: number): Promise<void> {
  try {
    const deployment = getDeployment(deploymentId);
    if (!deployment) return;

    const positions = getDeploymentPositions(deploymentId);
    const investedValue = positions.reduce((s: number, p: any) => s + (p.current_value || p.entry_value), 0);
    const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
    const trades = getDeploymentTrades(deploymentId);
    const totalRealizedPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);
    const cash = deployment.current_capital;
    const portfolioValue = cash + investedValue;

    const positionList = positions.length > 0
      ? positions.map((p: any) => `  ${p.symbol}: ${p.quantity} @ ₹${fmtNum(p.entry_price)} (${(p.pnl_pct || 0) >= 0 ? "+" : ""}${(p.pnl_pct || 0).toFixed(1)}%)`).join("\n")
      : "  No open positions";

    const msg = [
      `☀️ <b>Morning Brief — ${deployment.name}</b>`,
      ``,
      `Mode: ${deployment.mode.toUpperCase()} | Status: ${deployment.status}`,
      `Strategy: ${deployment.strategy_id}`,
      `Portfolio: ₹${fmtNum(portfolioValue)} | Cash: ₹${fmtNum(cash)}`,
      `Open Positions (${positions.length}/${deployment.max_positions}):`,
      positionList,
      ``,
      `Unrealized P&amp;L: ${unrealizedPnl >= 0 ? "+" : ""}₹${fmtNum(unrealizedPnl)}`,
      `Total Closed Trades: ${trades.length}`,
    ].join("\n");

    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Morning brief error: ${error.message}`);
  }
}

export async function sendRiskAlert(type: "DRAWDOWN" | "RECONCILIATION_MISMATCH", details: string): Promise<void> {
  try {
    const label = type === "DRAWDOWN" ? "DRAWDOWN ALERT" : "RECONCILIATION MISMATCH";
    const msg = `🚨 <b>${label}</b>\n${escapeHtml(details)}`;
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] Risk alert error: ${error.message}`);
  }
}

export async function sendSystemAlert(category: string, message: string): Promise<void> {
  try {
    const msg = `🔔 <b>SYSTEM: ${escapeHtml(category)}</b>\n${escapeHtml(message)}`;
    await sendTelegramMessage(msg);
  } catch (error: any) {
    console.error(`[Telegram] System alert error: ${error.message}`);
  }
}

// ─── Helpers ───

function fmtNum(v: number): string {
  return v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
