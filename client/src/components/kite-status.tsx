import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, CheckCircle2, ExternalLink, Key, RefreshCw,
  Wifi, WifiOff, Info, ArrowRight, Unplug, Shield, Clock, Zap
} from "lucide-react";

interface KiteStatus {
  connected: boolean;
  token: boolean;
  error: string;
  loginUrl: string;
}

// ─── Small banner for dashboard header ───

export default function KiteStatusBanner() {
  const { data: status } = useQuery<KiteStatus>({
    queryKey: ["/api/kite/status"],
    refetchInterval: 60000,
  });

  if (status?.connected) {
    return (
      <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-green-500" />
          <span className="text-xs text-green-400 font-medium">Kite Connect active — live data from Zerodha</span>
        </div>
        <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/20">Connected</Badge>
      </div>
    );
  }

  return (
    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <WifiOff className="w-4 h-4 text-yellow-500" />
        <span className="text-xs text-yellow-400 font-medium">
          Kite offline — using Yahoo Finance fallback
        </span>
        <span className="text-[11px] text-muted-foreground hidden sm:inline">
          Go to Zerodha tab to connect
        </span>
      </div>
      <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/20">Disconnected</Badge>
    </div>
  );
}

// ─── Full Zerodha tab ───

export function ZerodhaTab() {
  const [requestToken, setRequestToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const { data: status, isLoading } = useQuery<KiteStatus>({
    queryKey: ["/api/kite/status"],
    refetchInterval: 10000,
  });

  const handleConnect = async () => {
    if (!requestToken.trim()) return;
    setSubmitting(true);
    setMessage("");
    try {
      const res = await apiRequest("POST", "/api/kite/auth", { request_token: requestToken.trim() });
      const data = await res.json();
      if (data.success) {
        setMessage(`Connected as ${data.user}`);
        setRequestToken("");
        queryClient.invalidateQueries({ queryKey: ["/api/kite/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/screener"] });
      }
    } catch (e: any) {
      setMessage(`Failed: ${e.message}`);
    }
    setSubmitting(false);
  };

  const handleDisconnect = async () => {
    try {
      await apiRequest("POST", "/api/kite/token", { access_token: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/kite/status"] });
      setMessage("Disconnected from Kite");
    } catch {}
  };

  const isConnected = status?.connected;

  return (
    <div className="space-y-4">
      {/* Connection Status Card */}
      <Card className={isConnected ? "border-green-500/30" : "border-yellow-500/30"}>
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isConnected ? "bg-green-500/15" : "bg-yellow-500/15"}`}>
                {isConnected
                  ? <Wifi className="w-6 h-6 text-green-500" />
                  : <WifiOff className="w-6 h-6 text-yellow-500" />}
              </div>
              <div>
                <h3 className="text-sm font-semibold">
                  {isConnected ? "Kite Connect Active" : "Kite Connect Offline"}
                </h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {isConnected
                    ? "Live market data streaming from Zerodha"
                    : status?.error || "Token expired or not set — using Yahoo Finance as fallback"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={`text-xs px-3 py-1 ${isConnected ? "text-green-500 border-green-500/30 bg-green-500/10" : "text-yellow-500 border-yellow-500/30 bg-yellow-500/10"}`}
              >
                {isConnected ? "Connected" : "Disconnected"}
              </Badge>
              {isConnected && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  className="h-8 text-xs gap-1 text-muted-foreground"
                  data-testid="button-disconnect-kite"
                >
                  <Unplug className="w-3 h-3" />
                  Disconnect
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Connect Section */}
      {!isConnected && (
        <Card>
          <CardHeader className="py-3 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Key className="w-4 h-4 text-primary" />
              Connect to Zerodha Kite
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 space-y-4">
            {/* Step 1 */}
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">1</div>
              <div className="flex-1">
                <p className="text-xs font-semibold">Open Kite Login</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
                  Log in with your Zerodha credentials and complete 2FA (TOTP/PIN).
                </p>
                <a
                  href={status?.loginUrl || "https://kite.zerodha.com/connect/login?v=3&api_key=qdjxlkbtg8gy0ec3"}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="kite-login-link"
                >
                  <Button variant="default" size="sm" className="h-8 text-xs gap-1.5">
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open Zerodha Login
                    <ArrowRight className="w-3 h-3" />
                  </Button>
                </a>
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">2</div>
              <div className="flex-1">
                <p className="text-xs font-semibold">Copy the Request Token</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
                  After login, you'll be redirected to a URL. The page may not load — that's fine. 
                  Copy the <code className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono">request_token</code> value from the URL bar:
                </p>
                <div className="bg-muted/50 rounded-lg px-3 py-2 text-[11px] font-mono break-all leading-relaxed">
                  <span className="text-muted-foreground">http://127.0.0.1/...?request_token=</span>
                  <span className="text-primary font-bold">xYz123AbC456...</span>
                  <span className="text-muted-foreground">&action=login&status=success</span>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">3</div>
              <div className="flex-1">
                <p className="text-xs font-semibold">Paste & Connect</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">
                  Paste the request token below. The app will exchange it for an access token automatically.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Paste request_token here..."
                    value={requestToken}
                    onChange={(e) => setRequestToken(e.target.value)}
                    className="h-9 text-xs font-mono flex-1"
                    data-testid="input-request-token"
                    onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                  />
                  <Button
                    onClick={handleConnect}
                    disabled={submitting || !requestToken.trim()}
                    className="h-9 text-xs gap-1.5 px-4"
                    data-testid="button-connect-kite"
                  >
                    {submitting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    Connect
                  </Button>
                </div>
                {message && (
                  <p className={`text-xs font-medium mt-2 ${message.includes("Connected") ? "text-green-400" : "text-red-400"}`}>
                    {message}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Info Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="py-3 px-5">
            <CardTitle className="text-xs font-semibold flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" />
              Why Kite Connect?
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4 space-y-2">
            <InfoRow icon={<Zap className="w-3.5 h-3.5 text-green-400" />} text="Real-time prices directly from NSE via Zerodha" />
            <InfoRow icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-400" />} text="More accurate historical data for 200-DMA and ATR calculations" />
            <InfoRow icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-400" />} text="Faster scans — Kite API is optimised for bulk quotes" />
            <InfoRow icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-400" />} text="Supports all 9,000+ NSE equities" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="py-3 px-5">
            <CardTitle className="text-xs font-semibold flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              Token & Schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4 space-y-2">
            <InfoRow icon={<Shield className="w-3.5 h-3.5 text-yellow-400" />} text="Kite tokens expire daily at ~6 AM IST (SEBI requirement)" />
            <InfoRow icon={<Clock className="w-3.5 h-3.5 text-blue-400" />} text="Reconnect each morning — takes 10 seconds" />
            <InfoRow icon={<Info className="w-3.5 h-3.5 text-muted-foreground" />} text="Without Kite, the app uses Yahoo Finance as a fallback" />
            <InfoRow icon={<Zap className="w-3.5 h-3.5 text-green-400" />} text="Screener auto-runs at 3:15 PM and 9:15 AM IST" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InfoRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5">{icon}</span>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{text}</p>
    </div>
  );
}
