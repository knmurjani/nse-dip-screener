/**
 * Telegram Bot Command Handler
 * Uses long polling to listen for incoming commands.
 * Only responds to the authorized chat ID.
 */

import { getKiteStatus, getLoginURL, isAuthenticated, getKite } from "./kite";
import { sendTelegramMessage } from "./telegram";
import { istNow, getActiveDeployments, getDeploymentPositions, getDeploymentTrades, getDeploymentSnapshots } from "./storage";

// ─── Config ───

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8682452975:AAEPCOG2hYG_mcgFU2u7BGU-arFEyoOT6iM";
const AUTHORIZED_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "941382795";
const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login?v=3&api_key=qdjxlkbtg8gy0ec3";
const POLL_INTERVAL_MS = 3000; // 3 seconds

let lastUpdateId = 0;
let isPolling = false;

// ─── Command Handlers ───

async function handleLogin(): Promise<string> {
  return [
    "🔑 <b>Kite Login</b>",
    "",
    "Click to authenticate:",
    `<a href="${KITE_LOGIN_URL}">Login to Zerodha</a>`,
    "",
    "After login, you'll be redirected back and connected automatically.",
  ].join("\n");
}

async function handleStatus(): Promise<string> {
  const status = getKiteStatus();
  const time = istNow();

  const lines = [
    "📡 <b>System Status</b>",
    "",
    `Kite: ${status.connected ? "✅ Connected" : "❌ Disconnected"}`,
    `Token: ${status.token ? "✅ Present" : "❌ Missing"}`,
  ];

  if (status.error) {
    lines.push(`Error: ${escapeHtml(status.error)}`);
  }

  // Show active deployments summary
  try {
    const deployments = getActiveDeployments();
    if (deployments.length > 0) {
      lines.push("");
      lines.push(`Active Deployments: ${deployments.length}`);
      for (const d of deployments) {
        const positions = getDeploymentPositions(d.id);
        lines.push(`  • ${d.name}: ${positions.length} positions (${d.mode})`);
      }
    } else {
      lines.push("");
      lines.push("No active deployments.");
    }
  } catch {
    // Ignore errors in deployment lookup
  }

  lines.push("");
  lines.push(`Time: ${time}`);

  return lines.join("\n");
}

async function handlePositions(): Promise<string> {
  try {
    const deployments = getActiveDeployments();
    if (deployments.length === 0) {
      return "📊 No active deployments.";
    }

    const lines = ["📊 <b>Open Positions</b>", ""];

    let totalPositions = 0;
    for (const d of deployments) {
      const positions = getDeploymentPositions(d.id);
      if (positions.length === 0) continue;

      totalPositions += positions.length;
      lines.push(`<b>${escapeHtml(d.name)}</b>`);
      for (const p of positions) {
        const pnlSign = (p.pnl || 0) >= 0 ? "+" : "";
        const pnlPctSign = (p.pnl_pct || 0) >= 0 ? "+" : "";
        lines.push(
          `  ${p.symbol}: ${p.quantity} @ ₹${fmtNum(p.entry_price)} | P&amp;L: ${pnlSign}₹${fmtNum(p.pnl || 0)} (${pnlPctSign}${(p.pnl_pct || 0).toFixed(1)}%)`
        );
      }
      lines.push("");
    }

    if (totalPositions === 0) {
      return "📊 No open positions across any deployment.";
    }

    return lines.join("\n");
  } catch (error: any) {
    return `📊 Error fetching positions: ${error.message}`;
  }
}

async function handlePnl(): Promise<string> {
  try {
    const deployments = getActiveDeployments();
    if (deployments.length === 0) {
      return "📊 No active deployments.";
    }

    const lines = ["📊 <b>Today's P&amp;L Summary</b>", ""];
    const todayStr = istNow().split(" ")[0];

    for (const d of deployments) {
      const positions = getDeploymentPositions(d.id);
      const trades = getDeploymentTrades(d.id);

      const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.pnl || 0), 0);
      const todayTrades = trades.filter((t: any) => t.exit_date && t.exit_date.startsWith(todayStr));
      const todayRealizedPnl = todayTrades.reduce((s: number, t: any) => s + t.pnl, 0);
      const totalPnl = unrealizedPnl + todayRealizedPnl;

      const totalSign = totalPnl >= 0 ? "+" : "";
      const unrealizedSign = unrealizedPnl >= 0 ? "+" : "";
      const realizedSign = todayRealizedPnl >= 0 ? "+" : "";

      lines.push(`<b>${escapeHtml(d.name)}</b>`);
      lines.push(`  Day P&amp;L: ${totalSign}₹${fmtNum(totalPnl)}`);
      lines.push(`  Unrealized: ${unrealizedSign}₹${fmtNum(unrealizedPnl)} (${positions.length} positions)`);
      lines.push(`  Realized: ${realizedSign}₹${fmtNum(todayRealizedPnl)} (${todayTrades.length} trades)`);
      lines.push("");
    }

    lines.push(`Time: ${istNow()}`);
    return lines.join("\n");
  } catch (error: any) {
    return `📊 Error fetching P&amp;L: ${error.message}`;
  }
}

function handleHelp(): string {
  return [
    "🤖 <b>Available Commands</b>",
    "",
    "/login — Get Kite login link",
    "/connect — Get Kite login link",
    "/status — System &amp; Kite connection status",
    "/positions — View open positions",
    "/pnl — Today's P&amp;L summary",
    "/help — Show this help message",
  ].join("\n");
}

// ─── Polling Loop ───

async function pollUpdates(): Promise<void> {
  if (!isPolling) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5&allowed_updates=["message"]`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[TelegramBot] Polling error (${response.status}): ${await response.text()}`);
      scheduleNextPoll();
      return;
    }

    const data = await response.json() as {
      ok: boolean;
      result: Array<{
        update_id: number;
        message?: {
          chat: { id: number };
          text?: string;
          from?: { first_name?: string };
        };
      }>;
    };

    if (!data.ok || !data.result) {
      scheduleNextPoll();
      return;
    }

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      if (!update.message || !update.message.text) continue;

      const chatId = String(update.message.chat.id);

      // Only respond to authorized chat ID
      if (chatId !== AUTHORIZED_CHAT_ID) {
        console.log(`[TelegramBot] Ignoring message from unauthorized chat: ${chatId}`);
        continue;
      }

      const text = update.message.text.trim().toLowerCase();
      const command = text.split(" ")[0]; // Handle commands with arguments

      let reply: string;

      try {
        switch (command) {
          case "/login":
          case "/connect":
            reply = await handleLogin();
            break;
          case "/status":
            reply = await handleStatus();
            break;
          case "/positions":
            reply = await handlePositions();
            break;
          case "/pnl":
            reply = await handlePnl();
            break;
          case "/help":
          case "/start":
            reply = handleHelp();
            break;
          default:
            reply = "Use /help to see available commands.";
            break;
        }
      } catch (error: any) {
        console.error(`[TelegramBot] Command handler error:`, error.message);
        reply = `⚠️ Error processing command: ${error.message}`;
      }

      await sendTelegramMessage(reply);
    }
  } catch (error: any) {
    console.error(`[TelegramBot] Poll error: ${error.message}`);
  }

  scheduleNextPoll();
}

function scheduleNextPoll(): void {
  if (isPolling) {
    setTimeout(pollUpdates, POLL_INTERVAL_MS);
  }
}

// ─── Public API ───

export function startTelegramBot(): void {
  if (isPolling) {
    console.log("[TelegramBot] Already running");
    return;
  }
  isPolling = true;
  console.log("[TelegramBot] Starting long polling...");
  // Start polling after a short delay to let server boot up
  setTimeout(pollUpdates, 2000);
}

export function stopTelegramBot(): void {
  isPolling = false;
  console.log("[TelegramBot] Stopped polling");
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
