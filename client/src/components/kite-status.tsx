import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, ExternalLink, Key, RefreshCw, Copy, ChevronDown, ChevronUp } from "lucide-react";

interface KiteStatus {
  connected: boolean;
  token: boolean;
  error: string;
  loginUrl: string;
}

export default function KiteStatusBanner() {
  const [expanded, setExpanded] = useState(false);
  const [requestToken, setRequestToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const { data: status } = useQuery<KiteStatus>({
    queryKey: ["/api/kite/status"],
    refetchInterval: 60000, // Check every minute
  });

  const handleSubmitToken = async () => {
    if (!requestToken.trim()) return;
    setSubmitting(true);
    setMessage("");
    try {
      const res = await apiRequest("POST", "/api/kite/auth", { request_token: requestToken.trim() });
      const data = await res.json();
      if (data.success) {
        setMessage(`Connected as ${data.user}`);
        setRequestToken("");
        setExpanded(false);
        // Refresh everything
        queryClient.invalidateQueries({ queryKey: ["/api/kite/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/screener"] });
      }
    } catch (e: any) {
      setMessage(`Failed: ${e.message}. Try generating a new token.`);
    }
    setSubmitting(false);
  };

  // Don't show banner if connected
  if (status?.connected) {
    return (
      <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          <span className="text-xs text-green-400 font-medium">Kite Connect active — live data from Zerodha</span>
        </div>
        <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/20">Connected</Badge>
      </div>
    );
  }

  return (
    <Card className="border-yellow-500/30 bg-yellow-500/5">
      <CardContent className="p-3">
        {/* Collapsed view */}
        <div
          className="flex items-center justify-between cursor-pointer"
          onClick={() => setExpanded(!expanded)}
          data-testid="kite-banner-toggle"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500" />
            <div>
              <span className="text-xs font-medium text-yellow-400">Kite Connect offline</span>
              <span className="text-[11px] text-muted-foreground ml-2">
                {status?.error || "Token expired — login to refresh"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/20">
              Using Yahoo Finance
            </Badge>
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </div>
        </div>

        {/* Expanded: Login instructions */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-yellow-500/20 space-y-3">
            <div className="space-y-2">
              <p className="text-xs font-semibold">Reconnect Kite in 3 steps:</p>

              <div className="flex items-start gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">1</span>
                <div className="text-[11px] text-muted-foreground">
                  <a
                    href={status?.loginUrl || "https://kite.zerodha.com/connect/login?v=3&api_key=qdjxlkbtg8gy0ec3"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1 font-medium"
                    data-testid="kite-login-link"
                  >
                    Open Kite Login <ExternalLink className="w-3 h-3" />
                  </a>
                  {" "}— log in with your Zerodha credentials + 2FA
                </div>
              </div>

              <div className="flex items-start gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">2</span>
                <div className="text-[11px] text-muted-foreground">
                  After login, you'll be redirected. Copy the <code className="bg-muted px-1 py-0.5 rounded text-[10px]">request_token</code> from the URL:
                  <div className="mt-1 bg-muted/50 rounded px-2 py-1 text-[10px] font-mono break-all">
                    http://127.0.0.1/...?request_token=<span className="text-primary font-bold">COPY_THIS_PART</span>&action=login
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">3</span>
                <div className="text-[11px] text-muted-foreground w-full">
                  Paste it here:
                  <div className="flex gap-2 mt-1">
                    <Input
                      placeholder="Paste request_token here..."
                      value={requestToken}
                      onChange={(e) => setRequestToken(e.target.value)}
                      className="h-8 text-xs font-mono flex-1"
                      data-testid="input-request-token"
                      onKeyDown={(e) => e.key === "Enter" && handleSubmitToken()}
                    />
                    <Button
                      size="sm"
                      onClick={handleSubmitToken}
                      disabled={submitting || !requestToken.trim()}
                      className="h-8 text-xs gap-1"
                      data-testid="button-connect-kite"
                    >
                      {submitting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
                      Connect
                    </Button>
                  </div>
                </div>
              </div>

              {message && (
                <p className={`text-[11px] font-medium ${message.includes("Connected") ? "text-green-400" : "text-red-400"}`}>
                  {message}
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
