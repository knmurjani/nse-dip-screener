import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, TrendingUp, TrendingDown, Trophy, AlertTriangle, Clock, Target, BarChart3, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

interface Trade {
  symbol: string; name: string; signalDate: string; entryDate: string; entryTime: string; entryPrice: number;
  exitDate: string; exitTime: string; exitPrice: number; exitReason: string; pnl: number; pnlPct: number;
  daysHeld: number; setupScore: number;
}

interface EquityPoint { date: string; equity: number; drawdownPct: number; }

interface BacktestData {
  trades: Trade[];
  summary: {
    initialCapital: number; finalEquity: number; totalReturn: number; totalReturnPct: number;
    totalTrades: number; winners: number; losers: number; winRate: number;
    avgWinPct: number; avgLossPct: number; avgTradePnl: number; avgTradePct: number;
    maxDrawdownPct: number; profitFactor: number; sharpeRatio: number;
    maxConsecutiveWins: number; maxConsecutiveLosses: number; avgDaysHeld: number;
    capitalPerTrade: number; maxPositions: number;
  };
  equityCurve: EquityPoint[];
  period: { from: string; to: string };
  dataSource: string;
}

type SortField = "entryDate" | "symbol" | "pnl" | "pnlPct" | "daysHeld" | "setupScore" | "exitReason";
type SortDir = "asc" | "desc";

function fmtRs(v: number): string {
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString("en-IN")}`;
}

function fmtPrice(v: number): string {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function exitLabel(r: string): string {
  switch (r) {
    case "profit_target": return "Profit Target";
    case "price_action": return "Price Action";
    case "time_exit": return "Time Exit";
    default: return r;
  }
}

function exitColor(r: string): string {
  switch (r) {
    case "profit_target": return "text-gain border-green-500/20 bg-gain";
    case "price_action": return "text-blue-400 border-blue-500/20 bg-blue-500/10";
    case "time_exit": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    default: return "";
  }
}

export default function BacktestTab() {
  const [sortField, setSortField] = useState<SortField>("entryDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading, isFetching } = useQuery<BacktestData>({
    queryKey: ["/api/backtest"],
    staleTime: 3600000,
  });

  const handleRefresh = async () => {
    await apiRequest("POST", "/api/backtest/refresh");
    queryClient.invalidateQueries({ queryKey: ["/api/backtest"] });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const sortedTrades = [...(data?.trades ?? [])].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (sortField === "entryDate") return mul * a.entryDate.localeCompare(b.entryDate);
    if (sortField === "exitReason") return mul * a.exitReason.localeCompare(b.exitReason);
    return mul * ((a as any)[sortField] - (b as any)[sortField]);
  });

  const s = data?.summary;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">
            Backtest: {data?.period.from} → {data?.period.to}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            ₹10L capital, 20 max positions, equal weight
            {data?.dataSource && ` · via ${data.dataSource}`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} className="h-8 text-xs gap-1.5" data-testid="button-backtest-refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Re-run
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : s ? (
        <>
          {/* KPI Row 1 — Returns */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Total Return" value={fmtRs(s.totalReturn)}
              sub={`${s.totalReturnPct >= 0 ? "+" : ""}${s.totalReturnPct}%`}
              subColor={s.totalReturnPct >= 0 ? "text-gain" : "text-loss"}
              icon={<TrendingUp className="w-4 h-4" />} />
            <MetricCard label="Final Equity" value={fmtRs(s.finalEquity)}
              sub={`from ${fmtRs(s.initialCapital)}`}
              icon={<BarChart3 className="w-4 h-4" />} />
            <MetricCard label="Win Rate" value={`${s.winRate}%`}
              sub={`${s.winners}W / ${s.losers}L of ${s.totalTrades}`}
              subColor={s.winRate >= 50 ? "text-gain" : "text-loss"}
              icon={<Trophy className="w-4 h-4" />} />
            <MetricCard label="Max Drawdown" value={`-${s.maxDrawdownPct}%`}
              sub="Peak to trough"
              subColor="text-loss"
              icon={<AlertTriangle className="w-4 h-4" />} />
          </div>

          {/* KPI Row 2 — Trade Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <SmallMetric label="Sharpe Ratio" value={s.sharpeRatio.toFixed(2)} good={s.sharpeRatio > 1} />
            <SmallMetric label="Profit Factor" value={s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)} good={s.profitFactor > 1.5} />
            <SmallMetric label="Avg Win" value={`+${s.avgWinPct}%`} good />
            <SmallMetric label="Avg Loss" value={`${s.avgLossPct}%`} good={false} />
            <SmallMetric label="Avg Days Held" value={s.avgDaysHeld.toFixed(1)} />
            <SmallMetric label="Avg Trade P&L" value={fmtRs(s.avgTradePnl)} good={s.avgTradePnl > 0} />
          </div>

          {/* Equity Curve (simple text-based since we don't have a chart library wired) */}
          {data?.equityCurve && data.equityCurve.length > 0 && (
            <Card>
              <CardHeader className="py-2 px-4">
                <CardTitle className="text-xs font-semibold">Equity Curve</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                <div className="flex items-end gap-[2px] h-24">
                  {data.equityCurve.map((p, i) => {
                    const min = Math.min(...data.equityCurve.map(e => e.equity));
                    const max = Math.max(...data.equityCurve.map(e => e.equity));
                    const range = max - min || 1;
                    const h = ((p.equity - min) / range) * 100;
                    const isGain = p.equity >= s.initialCapital;
                    return (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <div
                            className={`flex-1 rounded-t-sm min-w-[2px] transition-all ${isGain ? "bg-green-500/60 hover:bg-green-500" : "bg-red-500/60 hover:bg-red-500"}`}
                            style={{ height: `${Math.max(h, 2)}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs tabular-nums">{p.date}: {fmtRs(p.equity)}</p>
                          {p.drawdownPct > 0 && <p className="text-[10px] text-loss">DD: -{p.drawdownPct}%</p>}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-muted-foreground">{data.equityCurve[0]?.date}</span>
                  <span className="text-[10px] text-muted-foreground">{data.equityCurve[data.equityCurve.length - 1]?.date}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Exit Reason Breakdown */}
          <Card>
            <CardHeader className="py-2 px-4">
              <CardTitle className="text-xs font-semibold">Exit Breakdown</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              <div className="grid grid-cols-3 gap-3">
                {["profit_target", "price_action", "time_exit"].map(reason => {
                  const count = data!.trades.filter(t => t.exitReason === reason).length;
                  const pct = data!.trades.length > 0 ? Math.round((count / data!.trades.length) * 100) : 0;
                  const avgPnl = count > 0
                    ? data!.trades.filter(t => t.exitReason === reason).reduce((s, t) => s + t.pnlPct, 0) / count
                    : 0;
                  return (
                    <div key={reason} className="text-center p-2 rounded-lg bg-muted/50">
                      <p className="text-[10px] text-muted-foreground">{exitLabel(reason)}</p>
                      <p className="text-lg font-bold tabular-nums">{count}</p>
                      <p className="text-[10px] text-muted-foreground">{pct}% of trades</p>
                      <p className={`text-[11px] font-medium tabular-nums ${avgPnl >= 0 ? "text-gain" : "text-loss"}`}>
                        Avg: {avgPnl >= 0 ? "+" : ""}{avgPnl.toFixed(2)}%
                      </p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Trade Log */}
          <Card>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm font-semibold">
                Trade Log ({data?.trades.length} trades)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                      <SortHead label="Entry" field="entryDate" current={sortField} dir={sortDir} onClick={() => handleSort("entryDate")} align="right" />
                      <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                      <TableHead className="text-[11px] text-right">Exit</TableHead>
                      <TableHead className="text-[11px] text-right">Exit ₹</TableHead>
                      <SortHead label="P&L" field="pnl" current={sortField} dir={sortDir} onClick={() => handleSort("pnl")} align="right" />
                      <SortHead label="P&L %" field="pnlPct" current={sortField} dir={sortDir} onClick={() => handleSort("pnlPct")} align="right" />
                      <SortHead label="Days" field="daysHeld" current={sortField} dir={sortDir} onClick={() => handleSort("daysHeld")} align="right" />
                      <SortHead label="Exit Reason" field="exitReason" current={sortField} dir={sortDir} onClick={() => handleSort("exitReason")} align="right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedTrades.map((t, i) => (
                      <TableRow key={i} data-testid={`row-trade-${i}`}>
                        <TableCell className="py-2 pl-4">
                          <span className="text-xs font-semibold">{t.symbol}</span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <div className="text-xs tabular-nums">{t.entryDate}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">{t.entryTime?.replace(t.entryDate + " ", "")}</div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.entryPrice)}</TableCell>
                        <TableCell className="text-right py-2">
                          <div className="text-xs tabular-nums">{t.exitDate}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">{t.exitTime?.replace(t.exitDate + " ", "")}</div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.exitPrice)}</TableCell>
                        <TableCell className="text-right py-2">
                          <span className={`text-xs font-medium tabular-nums ${t.pnl >= 0 ? "text-gain" : "text-loss"}`}>
                            {t.pnl >= 0 ? "+" : ""}{fmtRs(t.pnl)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${t.pnl >= 0 ? "text-gain border-green-500/20 bg-gain" : "text-loss border-red-500/20 bg-loss"}`}>
                            {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct}%
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{t.daysHeld}</TableCell>
                        <TableCell className="text-right py-2 pr-4">
                          <Badge variant="outline" className={`text-[10px] ${exitColor(t.exitReason)}`}>
                            {exitLabel(t.exitReason)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <div className="py-16 text-center">
          <BarChart3 className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No backtest data. Click Re-run to start.</p>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───

function MetricCard({ label, value, sub, subColor, icon }: {
  label: string; value: string; sub: string; subColor?: string; icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
          <span className="text-muted-foreground/60">{icon}</span>
        </div>
        <p className="text-lg font-bold tabular-nums">{value}</p>
        <p className={`text-[11px] mt-0.5 tabular-nums font-medium ${subColor || "text-muted-foreground"}`}>{sub}</p>
      </CardContent>
    </Card>
  );
}

function SmallMetric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="p-2 rounded-lg bg-muted/30">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${good === true ? "text-gain" : good === false ? "text-loss" : ""}`}>{value}</p>
    </div>
  );
}

function SortHead({ label, field, current, dir, onClick, align = "left" }: {
  label: string; field: string; current: string; dir: string; onClick: () => void; align?: "left" | "right";
}) {
  return (
    <TableHead
      className={`text-[11px] whitespace-nowrap cursor-pointer select-none hover:text-foreground ${align === "right" ? "text-right" : "text-left pl-4"}`}
      onClick={onClick}
    >
      <div className={`flex items-center ${align === "right" ? "justify-end" : ""}`}>
        {label}
        {field === current ? (
          dir === "asc" ? <ArrowUp className="w-3 h-3 ml-1 text-primary" /> : <ArrowDown className="w-3 h-3 ml-1 text-primary" />
        ) : (
          <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />
        )}
      </div>
    </TableHead>
  );
}
