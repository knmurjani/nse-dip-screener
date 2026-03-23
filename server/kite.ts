import { KiteConnect } from "kiteconnect";

// Environment variables (set these in .env or Railway/AWS)
const API_KEY = process.env.KITE_API_KEY || "qdjxlkbtg8gy0ec3";
const API_SECRET = process.env.KITE_API_SECRET || "6cphs32h6vyjp5q287u7tst2zsyr1hu1";

let kite = new KiteConnect({ api_key: API_KEY });
let accessToken: string | null = process.env.KITE_ACCESS_TOKEN || null;
let tokenExpiry: string | null = null; // YYYY-MM-DD of when token was set

export function getKite(): KiteConnect {
  return kite;
}

export function isAuthenticated(): boolean {
  if (!accessToken) return false;
  // Kite tokens expire at ~6 AM IST next day
  const today = new Date().toISOString().split("T")[0];
  if (tokenExpiry && tokenExpiry !== today) {
    console.log("[Kite] Token expired (from", tokenExpiry, ") — need fresh login");
    return false;
  }
  return true;
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
  console.log(`[Kite] Authenticated as ${session.user_name || session.user_id} — token valid for today`);
  return {
    access_token: session.access_token,
    user_name: session.user_name || session.user_id,
  };
}

export function setAccessToken(token: string) {
  accessToken = token;
  tokenExpiry = new Date().toISOString().split("T")[0];
  kite.setAccessToken(token);
  console.log("[Kite] Access token set manually");
}

export { API_KEY, API_SECRET };
