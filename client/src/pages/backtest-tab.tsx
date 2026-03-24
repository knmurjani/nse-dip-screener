import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import {
  RefreshCw, TrendingUp, TrendingDown, Trophy, AlertTriangle,
  Clock, Target, BarChart3, ArrowUpDown, ArrowUp, ArrowDown,
  Activity, Percent, Zap, Info,
} from "lucide-react";

// ─── Types ───

interface Trade {
  id: number; symbol: string; name: string; signalDate: string;
  entryDate: string; entryTime: string; entryPrice: number; shares: number; capitalAllocated: number;
  exitDate: string; exitTime: string; exitPrice: number;
  exitReason: "profit_target" | "price_action_close_above_prev_high" | "time_exit_10_days";
  exitReasonDetail: string;
  pnl: number; pnlPct: number; daysHeld: number; setupScore: number;
  atr5AtEntry: number; profitTargetPrice: number;
  portfolioValueAtEntry: number; portfolioValueAtExit: number;
}

interface DailySnapshot {
  date: string; portfolioValue: number; cash: number; investedValue: number;
  unrealizedPnl: number; realizedPnl: number; openPositions: number;
  equityPct: number; drawdownPct: number; niftyClose: number; niftyPct: number;
}

interface BacktestSummary {
  initialCapital: number; finalPortfolioValue: number; totalReturn: number; totalReturnPct: number;
  annualizedReturnPct: number; totalTrades: number; winningTrades: number; losingTrades: number;
  winningPct: number; highestWinPct: number; highestWinSymbol: string;
  highestLossPct: number; highestLossSymbol: string;
  avgWinPct: number; avgLossPct: number; avgWinToLossRatio: number;
  avgTradeDurationDays: number; sharpeRatio: number; maxDrawdownPct: number; maxDrawdownDate: string;
  profitFactor: number; maxConsecutiveWins: number; maxConsecutiveLosses: number;
  correlationToNifty: number; maxPositions: number; positionSizePct: number;
  capitalPerTrade: number; totalDays: number; dataSource: string;
}

interface BacktestResult {
  trades: Trade[];
  dailySnapshots: DailySnapshot[];
  summary: BacktestSummary;
  period: { from: string; to: string };
}

// ─── Helpers ───

type SortField = "entryDate" | "symbol" | "pnl" | "pnlPct" | "daysHeld" | "exitReason";
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
    case "price_action_close_above_prev_high": return "Price Action";
    case "time_exit_10_days": return "Time Exit";
    default: return r;
  }
}

function exitBadgeClass(r: string): string {
  switch (r) {
    case "profit_target": return "text-[#22c55e] border-green-500/20 bg-green-500/10";
    case "price_action_close_above_prev_high": return "text-blue-400 border-blue-500/20 bg-blue-500/10";
    case "time_exit_10_days": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    default: return "";
  }
}

function formatChartDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// ─── Main Component ───

export default function BacktestTab() {
  const [sortField, setSortField] = useState<SortField>("entryDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const { data, isLoading, isFetching } = useQuery<BacktestResult>({
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

  // Sample every 5th data point for chart performance
  const chartData = (data?.dailySnapshots ?? []).filter((_, i) => i % 5 === 0);

  return (
    <div className="space-y-4" data-testid="backtest-tab">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" data-testid="backtest-period">
            Backtest: {data?.period.from} → {data?.period.to}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {s ? `₹${(s.initialCapital / 100000).toFixed(0)}L capital · ${s.maxPositions} max positions · ${s.positionSizePct}% per trade` : "Loading..."}
            {s?.dataSource && ` · via ${s.dataSource}`}
          </p>
        </div>
        <Button
          variant="outline" size="sm" onClick={handleRefresh}
          disabled={isFetching} className="h-8 text-xs gap-1.5"
          data-testid="button-backtest-refresh"
        >
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
          {/* ── Section 1: Summary Dashboard ── */}

          {/* Row 1: 4 primary KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="kpi-row-1">
            <MetricCard
              label="Total Return" value={`${s.totalReturnPct >= 0 ? "+" : ""}${s.totalReturnPct.toFixed(1)}%`}
              sub={fmtRs(s.totalReturn)}
              subColor={s.totalReturnPct >= 0 ? "text-gain" : "text-loss"}
              icon={<TrendingUp className="w-4 h-4" />}
              testId="kpi-total-return"
            />
            <MetricCard
              label="Annualized Return" value={`${s.annualizedReturnPct >= 0 ? "+" : ""}${s.annualizedReturnPct.toFixed(1)}%`}
              sub={`${s.totalDays} days`}
              subColor={s.annualizedReturnPct >= 0 ? "text-gain" : "text-loss"}
              icon={<Activity className="w-4 h-4" />}
              testId="kpi-annualized-return"
            />
            <MetricCard
              label="Win Rate" value={`${s.winningPct.toFixed(1)}%`}
              sub={`${s.winningTrades}W / ${s.losingTrades}L of ${s.totalTrades}`}
              subColor={s.winningPct >= 50 ? "text-gain" : "text-loss"}
              icon={<Trophy className="w-4 h-4" />}
              testId="kpi-win-rate"
            />
            <MetricCard
              label="Total Trades" value={`${s.totalTrades}`}
              sub={`${fmtRs(s.initialCapital)} → ${fmtRs(s.finalPortfolioValue)}`}
              icon={<BarChart3 className="w-4 h-4" />}
              testId="kpi-total-trades"
            />
          </div>

          {/* Row 2: 4 risk/quality KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="kpi-row-2">
            <MetricCard
              label="Sharpe Ratio" value={s.sharpeRatio.toFixed(2)}
              sub={s.sharpeRatio > 1 ? "Good" : s.sharpeRatio > 0.5 ? "Fair" : "Poor"}
              subColor={s.sharpeRatio > 1 ? "text-gain" : s.sharpeRatio > 0.5 ? "text-yellow-500" : "text-loss"}
              icon={<Zap className="w-4 h-4" />}
              testId="kpi-sharpe"
            />
            <MetricCard
              label="Max Drawdown" value={`-${s.maxDrawdownPct.toFixed(1)}%`}
              sub={s.maxDrawdownDate}
              subColor="text-loss"
              icon={<AlertTriangle className="w-4 h-4" />}
              testId="kpi-max-drawdown"
            />
            <MetricCard
              label="Profit Factor" value={s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)}
              sub={s.profitFactor > 1.5 ? "Strong" : s.profitFactor > 1 ? "Positive" : "Negative"}
              subColor={s.profitFactor > 1.5 ? "text-gain" : s.profitFactor > 1 ? "text-yellow-500" : "text-loss"}
              icon={<Target className="w-4 h-4" />}
              testId="kpi-profit-factor"
            />
            <MetricCard
              label="Nifty Correlation" value={s.correlationToNifty.toFixed(2)}
              sub={Math.abs(s.correlationToNifty) > 0.7 ? "High" : Math.abs(s.correlationToNifty) > 0.4 ? "Moderate" : "Low"}
              icon={<Percent className="w-4 h-4" />}
              testId="kpi-correlation"
            />
          </div>

          {/* Row 3: 6 small metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="kpi-row-3">
            <SmallMetric
              label={`Best Win (${s.highestWinSymbol})`}
              value={`+${s.highestWinPct.toFixed(1)}%`} good
              testId="kpi-best-win"
            />
            <SmallMetric
              label={`Worst Loss (${s.highestLossSymbol})`}
              value={`${s.highestLossPct.toFixed(1)}%`} good={false}
              testId="kpi-worst-loss"
            />
            <SmallMetric
              label="Avg Win : Avg Loss"
              value={`${s.avgWinPct.toFixed(1)}% : ${Math.abs(s.avgLossPct).toFixed(1)}%`}
              sub={`Ratio: ${s.avgWinToLossRatio.toFixed(2)}`}
              good={s.avgWinToLossRatio > 1}
              testId="kpi-win-loss-ratio"
            />
            <SmallMetric
              label="Avg Trade Duration"
              value={`${s.avgTradeDurationDays.toFixed(1)} days`}
              testId="kpi-avg-duration"
            />
            <SmallMetric
              label="Max Consec Wins"
              value={`${s.maxConsecutiveWins}`} good
              testId="kpi-consec-wins"
            />
            <SmallMetric
              label="Max Consec Losses"
              value={`${s.maxConsecutiveLosses}`} good={false}
              testId="kpi-consec-losses"
            />
          </div>

          {/* ── Section 2: Charts ── */}

          {chartData.length > 0 && (
            <div className="space-y-4" data-testid="charts-section">
              {/* Equity Curve: Portfolio vs Nifty */}
              <Card>
                <CardHeader className="py-2 px-4">
                  <CardTitle className="text-xs font-semibold">Portfolio vs Nifty 50 (%)</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 20%)" />
                      <XAxis
                        dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatChartDate}
                        stroke="hsl(215, 10%, 40%)" interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 10%, 40%)" tickFormatter={(v) => `${v.toFixed(0)}%`} />
                      <RTooltip
                        contentStyle={{ background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 20%)", borderRadius: "6px", fontSize: "11px" }}
                        labelFormatter={formatChartDate}
                        formatter={(value: number, name: string) => [`${value.toFixed(2)}%`, name === "equityPct" ? "Portfolio" : "Nifty 50"]}
                      />
                      <Line type="monotone" dataKey="equityPct" stroke="#22c55e" strokeWidth={1.5} dot={false} name="equityPct" />
                      <Line type="monotone" dataKey="niftyPct" stroke="#6b7280" strokeWidth={1} strokeDasharray="4 3" dot={false} name="niftyPct" />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Portfolio Value */}
              <Card>
                <CardHeader className="py-2 px-4">
                  <CardTitle className="text-xs font-semibold">Portfolio Value (₹)</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="portfolioGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 20%)" />
                      <XAxis
                        dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatChartDate}
                        stroke="hsl(215, 10%, 40%)" interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 10%, 40%)" tickFormatter={(v) => fmtRs(v)} />
                      <RTooltip
                        contentStyle={{ background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 20%)", borderRadius: "6px", fontSize: "11px" }}
                        labelFormatter={formatChartDate}
                        formatter={(value: number) => [fmtRs(value), "Portfolio Value"]}
                      />
                      <Area type="monotone" dataKey="portfolioValue" stroke="#22c55e" strokeWidth={1.5} fill="url(#portfolioGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Drawdown */}
              <Card>
                <CardHeader className="py-2 px-4">
                  <CardTitle className="text-xs font-semibold">Drawdown (%)</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData.map(d => ({ ...d, drawdown: -Math.abs(d.drawdownPct) }))}>
                      <defs>
                        <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 20%)" />
                      <XAxis
                        dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatChartDate}
                        stroke="hsl(215, 10%, 40%)" interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 10%, 40%)" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                      <RTooltip
                        contentStyle={{ background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 20%)", borderRadius: "6px", fontSize: "11px" }}
                        labelFormatter={formatChartDate}
                        formatter={(value: number) => [`${value.toFixed(2)}%`, "Drawdown"]}
                      />
                      <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} fill="url(#drawdownGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── Section 3: Trade Log ── */}
          <Card>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm font-semibold" data-testid="trade-log-title">
                Trade Log ({data?.trades.length} trades)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-[11px] text-right w-10 pl-4">#</TableHead>
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
                      <TableRow key={t.id ?? i} data-testid={`row-trade-${i}`}>
                        <TableCell className="text-right text-[11px] text-muted-foreground tabular-nums py-2 pl-4">
                          {i + 1}
                        </TableCell>
                        <TableCell className="py-2">
                          <div>
                            <span className="text-xs font-semibold">{t.symbol}</span>
                            <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{t.name}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <div className="text-xs tabular-nums">{t.entryDate}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">{t.entryTime}</div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.entryPrice)}</TableCell>
                        <TableCell className="text-right py-2">
                          <div className="text-xs tabular-nums">{t.exitDate}</div>
                          <div className="text-[10px] text-muted-foreground tabular-nums">{t.exitTime}</div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.exitPrice)}</TableCell>
                        <TableCell className="text-right py-2">
                          <span className={`text-xs font-medium tabular-nums ${t.pnl >= 0 ? "text-gain" : "text-loss"}`}>
                            {t.pnl >= 0 ? "+" : ""}{fmtRs(t.pnl)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${t.pnl >= 0 ? "text-gain border-green-500/20 bg-green-500/10" : "text-loss border-red-500/20 bg-red-500/10"}`}>
                            {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">
                          {t.daysHeld}d
                        </TableCell>
                        <TableCell className="text-right py-2 pr-4">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                className="inline-flex items-center gap-1 cursor-pointer"
                                onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                                data-testid={`exit-reason-${i}`}
                              >
                                <Badge variant="outline" className={`text-[10px] ${exitBadgeClass(t.exitReason)}`}>
                                  {exitLabel(t.exitReason)}
                                </Badge>
                                <Info className="w-3 h-3 text-muted-foreground/50" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="max-w-[280px]">
                              <p className="text-[11px]">{t.exitReasonDetail}</p>
                            </TooltipContent>
                          </Tooltip>
                          {expandedRow === i && (
                            <p className="text-[10px] text-muted-foreground mt-1 text-left leading-snug" data-testid={`exit-detail-${i}`}>
                              {t.exitReasonDetail}
                            </p>
                          )}
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

function MetricCard({ label, value, sub, subColor, icon, testId }: {
  label: string; value: string; sub: string; subColor?: string; icon: React.ReactNode; testId?: string;
}) {
  return (
    <Card data-testid={testId}>
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

function SmallMetric({ label, value, sub, good, testId }: {
  label: string; value: string; sub?: string; good?: boolean; testId?: string;
}) {
  return (
    <div className="p-2 rounded-lg bg-muted/30" data-testid={testId}>
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${good === true ? "text-gain" : good === false ? "text-loss" : ""}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground tabular-nums">{sub}</p>}
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
      data-testid={`sort-${field}`}
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
