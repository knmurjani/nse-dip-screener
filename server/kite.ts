import { KiteConnect } from "kiteconnect";
import { sendTelegramMessage } from "./telegram";
import { istNow, getConfig, setConfig } from "./storage";

// Environment variables (set these in .env or Railway/AWS)
const API_KEY = process.env.KITE_API_KEY || "qdjxlkbtg8gy0ec3";
const API_SECRET = process.env.KITE_API_SECRET || "6cphs32h6vyjp5q287u7tst2zsyr1hu1";

let kite = new KiteConnect({ api_key: API_KEY });
let tokenExpiry: string | null = null; // YYYY-MM-DD of when token was set

// ─── Token Persistence: load from env → DB → null ───
function loadPersistedToken(): string | null {
  // 1. Try SQLite first (has the freshest token from login, survives deploys)
  try {
    const saved = getConfig("kite_access_token");
    const savedDate = getConfig("kite_token_date");
    if (saved && savedDate) {
      // Kite tokens expire daily — only use if saved today (IST)
      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
      if (savedDate === todayIST) {
        console.log("[Kite] Restored access token from database (saved today)");
        return saved;
      } else {
        console.log(`[Kite] Saved token is from ${savedDate}, today is ${todayIST} — expired, ignoring`);
      }
    }
  } catch (e) {
    console.error("[Kite] Failed to load persisted token:", e);
  }
  // 2. Fall back to environment variable
  if (process.env.KITE_ACCESS_TOKEN) {
    console.log("[Kite] Using access token from environment variable (may be stale)");
    return process.env.KITE_ACCESS_TOKEN;
  }
  return null;
}

function persistToken(token: string): void {
  try {
    const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
    setConfig("kite_access_token", token);
    setConfig("kite_token_date", todayIST);
    console.log("[Kite] Access token persisted to database");
  } catch (e) {
    console.error("[Kite] Failed to persist token:", e);
  }
}

let accessToken: string | null = loadPersistedToken();

// Apply persisted token to Kite instance on startup
if (accessToken) {
  kite.setAccessToken(accessToken);
  console.log("[Kite] Token applied to Kite instance on startup");
}

// ─── Global API Rate Limiter (1 call per second) ───

let lastKiteCallTime = 0;
const MIN_CALL_INTERVAL_MS = 1000; // 1 second between calls

export async function kiteThrottle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastKiteCallTime;
  if (elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastKiteCallTime = Date.now();
}

/**
 * Execute a Kite API call with automatic throttling (1 req/sec).
 * Usage: const result = await throttledKite(kite => kite.getQuote(["NSE:RELIANCE"]));
 */
export async function throttledKite<T>(fn: (kite: KiteConnect) => Promise<T>): Promise<T> {
  await kiteThrottle();
  return fn(kite);
}

export function getKite(): KiteConnect {
  return kite;
}

let kiteApiWorking = true;
let lastKiteError = "";

const KITE_LOGIN_URL = "https://kite.zerodha.com/connect/login?v=3&api_key=" + API_KEY;

export function markKiteFailed(reason?: string) {
  kiteApiWorking = false;
  lastKiteError = reason || "API call failed";
  console.log("[Kite] Marked unavailable:", lastKiteError);

  // Send Telegram alert with re-login link
  try {
    const time = istNow();
    sendTelegramMessage(
      [
        "⚠️ <b>Kite Token Failed Mid-Session</b>",
        "",
        `Error: ${lastKiteError}`,
        `Time: ${time}`,
        "",
        "Click to re-authenticate:",
        `<a href="${KITE_LOGIN_URL}">Login to Zerodha</a>`,
      ].join("\n")
    ).catch(() => { /* never throw from markKiteFailed */ });
  } catch {
    // Telegram errors must never crash the server
  }
}

export function isAuthenticated(): boolean {
  if (!accessToken) return false;
  if (!kiteApiWorking) return false;
  return true;
}

export function getKiteStatus(): { connected: boolean; token: boolean; error: string } {
  return {
    connected: kiteApiWorking && !!accessToken,
    token: !!accessToken,
    error: !accessToken ? "No access token set" : !kiteApiWorking ? lastKiteError : "",
  };
}

export function getLoginURL(): string {
  return kite.getLoginURL();
}

export async function generateSession(requestToken: string): Promise<{
  access_token: string;
  user_name: string;
}> {
  const session = await kite.generateSession(requestToken, API_SECRET);
  accessToken = session.access_token;
  tokenExpiry = new Date().toISOString().split("T")[0];
  kite.setAccessToken(accessToken!);
  kiteApiWorking = true; // Reset on new session
  lastKiteError = "";
  persistToken(accessToken!); // Save to DB so it survives deploys
  console.log(`[Kite] Authenticated as ${session.user_name || session.user_id} — token valid for today`);
  return {
    access_token: session.access_token,
    user_name: session.user_name || session.user_id,
  };
}

export function setAccessToken(token: string) {
  accessToken = token;
  tokenExpiry = new Date().toISOString().split("T")[0];
  kiteApiWorking = true; // Reset — assume new token works
  lastKiteError = "";
  kite.setAccessToken(token);
  persistToken(token); // Save to DB so it survives deploys
  console.log("[Kite] Access token set — connection restored");
}

export { API_KEY, API_SECRET };
