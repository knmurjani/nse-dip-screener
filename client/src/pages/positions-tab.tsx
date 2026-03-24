import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import {
  RefreshCw, Briefcase, History, Clock, Target, TrendingUp, TrendingDown,
  AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown, Info, Wallet, BarChart3,
  PlayCircle, Crosshair,
} from "lucide-react";

// ─── Types ───

interface PortfolioSummary {
  initialCapital: number; cash: number; investedValue: number;
  unrealizedPnl: number; realizedPnl: number;
  totalPortfolioValue: number; portfolioReturnPct: number;
  drawdownPct: number; maxDrawdownPct: number;
  totalTrades: number; winningTrades: number; losingTrades: number;
  winRate: number; avgWinPct: number; avgLossPct: number;
  highestWinPct: number; highestWinSymbol: string;
  highestLossPct: number; highestLossSymbol: string;
  avgDaysHeld: number; maxPositions: number; openPositions: number;
}

interface OpenPosition {
  id: number; symbol: string; name: string; signalDate: string; entryDate: string;
  entryPrice: number; shares: number; capitalAllocated: number;
  profitTarget: number; setupScore: number; tradingDaysHeld: number;
  currentPrice: number | null; currentValue: number | null;
  unrealizedPnl: number | null; unrealizedPnlPct: number | null;
}

interface ClosedTrade {
  id: number; symbol: string; name: string; signalDate: string;
  entryDate: string; entryPrice: number; shares: number; capitalAllocated: number;
  exitDate: string; exitPrice: number; exitReason: string; exitReasonDetail: string;
  pnl: number; pnlPct: number; daysHeld: number; setupScore: number;
}

interface PendingSignal {
  id: number; date: string; symbol: string; name: string;
  limitPrice: number; profitTarget: number; setupScore: number; status: string;
}

interface DailySnapshot {
  date: string; cash: number; investedValue: number; unrealizedPnl: number;
  realizedPnl: number; totalPortfolioValue: number; portfolioReturnPct: number;
  drawdownPct: number; openPositionCount: number; niftyClose: number | null; niftyReturnPct: number | null;
}

interface PortfolioData {
  summary: PortfolioSummary;
  positions: OpenPosition[];
  closedTrades: ClosedTrade[];
  pendingSignals: PendingSignal[];
  dailySnapshots: DailySnapshot[];
}

// ─── Helpers ───

type PositionSortField = "symbol" | "entryDate" | "unrealizedPnl" | "unrealizedPnlPct" | "tradingDaysHeld";
type TradeSortField = "symbol" | "entryDate" | "exitDate" | "pnl" | "pnlPct" | "daysHeld" | "exitReason";
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

function statusBadgeClass(s: string): string {
  switch (s) {
    case "pending": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    case "filled": return "text-[#22c55e] border-green-500/20 bg-green-500/10";
    case "expired": return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
    case "skipped": return "text-muted-foreground border-muted-foreground/20 bg-muted/30";
    default: return "";
  }
}

function formatChartDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// ─── Main Component ───

export default function PositionsTab() {
  const [subTab, setSubTab] = useState("positions");
  const [posSortField, setPosSortField] = useState<PositionSortField>("entryDate");
  const [posSortDir, setPosSortDir] = useState<SortDir>("desc");
  const [tradeSortField, setTradeSortField] = useState<TradeSortField>("exitDate");
  const [tradeSortDir, setTradeSortDir] = useState<SortDir>("desc");

  const { data, isLoading, isFetching } = useQuery<PortfolioData>({
    queryKey: ["/api/live/portfolio"],
    staleTime: 60000,
  });

  const handleRunCycle = async () => {
    await apiRequest("POST", "/api/live/run");
    queryClient.invalidateQueries({ queryKey: ["/api/live/portfolio"] });
  };

  const handlePosSort = (field: PositionSortField) => {
    if (posSortField === field) setPosSortDir(posSortDir === "asc" ? "desc" : "asc");
    else { setPosSortField(field); setPosSortDir("desc"); }
  };

  const handleTradeSort = (field: TradeSortField) => {
    if (tradeSortField === field) setTradeSortDir(tradeSortDir === "asc" ? "desc" : "asc");
    else { setTradeSortField(field); setTradeSortDir("desc"); }
  };

  const s = data?.summary;

  const sortedPositions = [...(data?.positions ?? [])].sort((a, b) => {
    const mul = posSortDir === "asc" ? 1 : -1;
    if (posSortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (posSortField === "entryDate") return mul * a.entryDate.localeCompare(b.entryDate);
    return mul * (((a as any)[posSortField] ?? 0) - ((b as any)[posSortField] ?? 0));
  });

  const sortedTrades = [...(data?.closedTrades ?? [])].sort((a, b) => {
    const mul = tradeSortDir === "asc" ? 1 : -1;
    if (tradeSortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (tradeSortField === "entryDate") return mul * a.entryDate.localeCompare(b.entryDate);
    if (tradeSortField === "exitDate") return mul * a.exitDate.localeCompare(b.exitDate);
    if (tradeSortField === "exitReason") return mul * a.exitReason.localeCompare(b.exitReason);
    return mul * ((a as any)[tradeSortField] - (b as any)[tradeSortField]);
  });

  const chartData = (data?.dailySnapshots ?? []).filter((_, i) => i % 5 === 0);

  return (
    <div className="space-y-4" data-testid="positions-tab">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Live Portfolio</h2>
        </div>
        <Button
          variant="outline" size="sm" onClick={handleRunCycle}
          disabled={isFetching} className="h-8 text-xs gap-1.5"
          data-testid="button-run-cycle"
        >
          <PlayCircle className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Run Daily Cycle
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : s ? (
        <>
          {/* ── Section 1: Portfolio Summary Strip ── */}

          {/* Row 1: Values */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="summary-row-1">
            <SummaryCell
              label="Portfolio Value" value={fmtRs(s.totalPortfolioValue)}
              testId="metric-portfolio-value"
            />
            <SummaryCell
              label="Cash" value={fmtRs(s.cash)}
              testId="metric-cash"
            />
            <SummaryCell
              label="Invested" value={fmtRs(s.investedValue)}
              testId="metric-invested"
            />
            <SummaryCell
              label="Unrealized P&L" value={`${s.unrealizedPnl >= 0 ? "+" : ""}${fmtRs(s.unrealizedPnl)}`}
              color={s.unrealizedPnl >= 0 ? "text-gain" : "text-loss"}
              testId="metric-unrealized"
            />
            <SummaryCell
              label="Realized P&L" value={`${s.realizedPnl >= 0 ? "+" : ""}${fmtRs(s.realizedPnl)}`}
              color={s.realizedPnl >= 0 ? "text-gain" : "text-loss"}
              testId="metric-realized"
            />
            <SummaryCell
              label="Return" value={`${s.portfolioReturnPct >= 0 ? "+" : ""}${s.portfolioReturnPct.toFixed(2)}%`}
              color={s.portfolioReturnPct >= 0 ? "text-gain" : "text-loss"}
              testId="metric-return"
            />
          </div>

          {/* Row 2: Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="summary-row-2">
            <SummaryCell
              label="Open Positions" value={`${s.openPositions} / ${s.maxPositions}`}
              testId="metric-open-positions"
            />
            <SummaryCell
              label="Closed Trades" value={`${s.totalTrades}`}
              sub={`${s.winningTrades}W / ${s.losingTrades}L`}
              testId="metric-closed-trades"
            />
            <SummaryCell
              label="Win Rate" value={`${s.winRate.toFixed(1)}%`}
              color={s.winRate >= 50 ? "text-gain" : "text-loss"}
              testId="metric-win-rate"
            />
            <SummaryCell
              label="Max Drawdown" value={`-${s.maxDrawdownPct.toFixed(1)}%`}
              color="text-loss"
              testId="metric-max-drawdown"
            />
            <SummaryCell
              label="Avg Win" value={`+${s.avgWinPct.toFixed(1)}%`}
              color="text-gain"
              testId="metric-avg-win"
            />
            <SummaryCell
              label="Avg Loss" value={`${s.avgLossPct.toFixed(1)}%`}
              color="text-loss"
              testId="metric-avg-loss"
            />
          </div>

          {/* ── Section 2: Sub-tabs ── */}
          <Tabs value={subTab} onValueChange={setSubTab} data-testid="portfolio-tabs">
            <TabsList className="grid w-full max-w-md grid-cols-3 h-9">
              <TabsTrigger value="positions" className="text-xs" data-testid="tab-positions">
                <Briefcase className="w-3.5 h-3.5 mr-1.5" />
                Open ({data?.positions.length ?? 0})
              </TabsTrigger>
              <TabsTrigger value="closed" className="text-xs" data-testid="tab-closed">
                <History className="w-3.5 h-3.5 mr-1.5" />
                Closed ({data?.closedTrades.length ?? 0})
              </TabsTrigger>
              <TabsTrigger value="pending" className="text-xs" data-testid="tab-pending">
                <Crosshair className="w-3.5 h-3.5 mr-1.5" />
                Pending ({data?.pendingSignals.length ?? 0})
              </TabsTrigger>
            </TabsList>

            {/* Open Positions */}
            <TabsContent value="positions" className="mt-3">
              <Card>
                <CardContent className="px-0 pb-0 pt-0">
                  {sortedPositions.length === 0 ? (
                    <div className="p-8 text-center">
                      <Briefcase className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                      <p className="text-sm text-muted-foreground">No open positions</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-card z-10">
                          <TableRow className="hover:bg-transparent">
                            <SortHead label="Stock" field="symbol" current={posSortField} dir={posSortDir} onClick={() => handlePosSort("symbol")} />
                            <SortHead label="Entry" field="entryDate" current={posSortField} dir={posSortDir} onClick={() => handlePosSort("entryDate")} align="right" />
                            <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                            <TableHead className="text-[11px] text-right">Shares</TableHead>
                            <TableHead className="text-[11px] text-right">Current ₹</TableHead>
                            <TableHead className="text-[11px] text-right">Value</TableHead>
                            <SortHead label="Unreal P&L" field="unrealizedPnl" current={posSortField} dir={posSortDir} onClick={() => handlePosSort("unrealizedPnl")} align="right" />
                            <SortHead label="P&L %" field="unrealizedPnlPct" current={posSortField} dir={posSortDir} onClick={() => handlePosSort("unrealizedPnlPct")} align="right" />
                            <SortHead label="Days" field="tradingDaysHeld" current={posSortField} dir={posSortDir} onClick={() => handlePosSort("tradingDaysHeld")} align="right" />
                            <TableHead className="text-[11px] text-right">Target ₹</TableHead>
                            <TableHead className="text-[11px] text-right pr-4">Score</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sortedPositions.map((p, i) => {
                            const pnl = p.unrealizedPnl ?? 0;
                            const pnlPct = p.unrealizedPnlPct ?? 0;
                            return (
                              <TableRow key={p.id} data-testid={`row-position-${i}`}>
                                <TableCell className="py-2 pl-4">
                                  <div>
                                    <span className="text-xs font-semibold">{p.symbol}</span>
                                    <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{p.name}</p>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">{p.entryDate}</TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(p.entryPrice)}</TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">{p.shares}</TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">
                                  {p.currentPrice != null ? fmtPrice(p.currentPrice) : "—"}
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">
                                  {p.currentValue != null ? fmtRs(p.currentValue) : "—"}
                                </TableCell>
                                <TableCell className="text-right py-2">
                                  <span className={`text-xs font-medium tabular-nums ${pnl >= 0 ? "text-gain" : "text-loss"}`}>
                                    {pnl >= 0 ? "+" : ""}{fmtRs(pnl)}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right py-2">
                                  <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${pnlPct >= 0 ? "text-gain border-green-500/20 bg-green-500/10" : "text-loss border-red-500/20 bg-red-500/10"}`}>
                                    {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">
                                  {p.tradingDaysHeld}d
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums py-2">
                                  <span className="text-gain">{fmtPrice(p.profitTarget)}</span>
                                </TableCell>
                                <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2 pr-4">
                                  {(p.setupScore * 100).toFixed(0)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Closed Trades */}
            <TabsContent value="closed" className="mt-3">
              <Card>
                <CardContent className="px-0 pb-0 pt-0">
                  {sortedTrades.length === 0 ? (
                    <div className="p-8 text-center">
                      <History className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                      <p className="text-sm text-muted-foreground">No closed trades yet</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-card z-10">
                          <TableRow className="hover:bg-transparent">
                            <SortHead label="Stock" field="symbol" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("symbol")} />
                            <SortHead label="Entry" field="entryDate" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("entryDate")} align="right" />
                            <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                            <SortHead label="Exit" field="exitDate" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("exitDate")} align="right" />
                            <TableHead className="text-[11px] text-right">Exit ₹</TableHead>
                            <SortHead label="P&L" field="pnl" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("pnl")} align="right" />
                            <SortHead label="P&L %" field="pnlPct" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("pnlPct")} align="right" />
                            <SortHead label="Days" field="daysHeld" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("daysHeld")} align="right" />
                            <SortHead label="Exit Reason" field="exitReason" current={tradeSortField} dir={tradeSortDir} onClick={() => handleTradeSort("exitReason")} align="right" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sortedTrades.map((t, i) => (
                            <TableRow key={t.id} data-testid={`row-trade-${i}`}>
                              <TableCell className="py-2 pl-4">
                                <div>
                                  <span className="text-xs font-semibold">{t.symbol}</span>
                                  <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{t.name}</p>
                                </div>
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums py-2">{t.entryDate}</TableCell>
                              <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.entryPrice)}</TableCell>
                              <TableCell className="text-right text-xs tabular-nums py-2">{t.exitDate}</TableCell>
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
                              <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{t.daysHeld}d</TableCell>
                              <TableCell className="text-right py-2 pr-4">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex items-center gap-1 cursor-help" data-testid={`exit-reason-${i}`}>
                                      <Badge variant="outline" className={`text-[10px] ${exitBadgeClass(t.exitReason)}`}>
                                        {exitLabel(t.exitReason)}
                                      </Badge>
                                      <Info className="w-3 h-3 text-muted-foreground/50" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="left" className="max-w-[280px]">
                                    <p className="text-[11px]">{t.exitReasonDetail}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Pending Signals */}
            <TabsContent value="pending" className="mt-3">
              <Card>
                <CardContent className="px-0 pb-0 pt-0">
                  {(data?.pendingSignals ?? []).length === 0 ? (
                    <div className="p-8 text-center">
                      <Crosshair className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                      <p className="text-sm text-muted-foreground">No pending signals</p>
                      <p className="text-[11px] text-muted-foreground mt-1">Signals appear after the daily screener runs</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                      <Table>
                        <TableHeader className="sticky top-0 bg-card z-10">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="text-[11px] pl-4">Date</TableHead>
                            <TableHead className="text-[11px]">Stock</TableHead>
                            <TableHead className="text-[11px] text-right">Limit ₹</TableHead>
                            <TableHead className="text-[11px] text-right">Target ₹</TableHead>
                            <TableHead className="text-[11px] text-right">Score</TableHead>
                            <TableHead className="text-[11px] text-right pr-4">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data!.pendingSignals.map((sig, i) => (
                            <TableRow key={sig.id} data-testid={`row-pending-${i}`}>
                              <TableCell className="text-xs tabular-nums py-2 pl-4">{sig.date}</TableCell>
                              <TableCell className="py-2">
                                <div>
                                  <span className="text-xs font-semibold">{sig.symbol}</span>
                                  <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{sig.name}</p>
                                </div>
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums font-medium text-primary py-2">
                                {fmtPrice(sig.limitPrice)}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums text-gain font-medium py-2">
                                {fmtPrice(sig.profitTarget)}
                              </TableCell>
                              <TableCell className="text-right text-xs tabular-nums py-2">
                                {(sig.setupScore * 100).toFixed(0)}
                              </TableCell>
                              <TableCell className="text-right py-2 pr-4">
                                <Badge variant="outline" className={`text-[10px] capitalize ${statusBadgeClass(sig.status)}`} data-testid={`status-${i}`}>
                                  {sig.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* ── Section 3: Portfolio Equity Chart ── */}
          {chartData.length > 0 && (
            <div className="space-y-4" data-testid="charts-section">
              <Card>
                <CardHeader className="py-2 px-4">
                  <CardTitle className="text-xs font-semibold">Portfolio Return (%)</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 20%)" />
                      <XAxis
                        dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatChartDate}
                        stroke="hsl(215, 10%, 40%)" interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 10%, 40%)" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                      <RTooltip
                        contentStyle={{ background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 20%)", borderRadius: "6px", fontSize: "11px" }}
                        labelFormatter={formatChartDate}
                        formatter={(value: number, name: string) => {
                          if (name === "portfolioReturnPct") return [`${value.toFixed(2)}%`, "Portfolio"];
                          if (name === "niftyReturnPct") return [`${value?.toFixed(2) ?? "—"}%`, "Nifty 50"];
                          return [value, name];
                        }}
                      />
                      <Line type="monotone" dataKey="portfolioReturnPct" stroke="#22c55e" strokeWidth={1.5} dot={false} name="portfolioReturnPct" />
                      <Line type="monotone" dataKey="niftyReturnPct" stroke="#6b7280" strokeWidth={1} strokeDasharray="4 3" dot={false} name="niftyReturnPct" />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-2 px-4">
                  <CardTitle className="text-xs font-semibold">Drawdown (%)</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-3">
                  <ResponsiveContainer width="100%" height={150}>
                    <AreaChart data={chartData.map(d => ({ ...d, drawdown: -Math.abs(d.drawdownPct) }))}>
                      <defs>
                        <linearGradient id="liveDrawdownGradient" x1="0" y1="0" x2="0" y2="1">
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
                      <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} fill="url(#liveDrawdownGradient)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      ) : (
        <div className="py-16 text-center">
          <Wallet className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No portfolio data. Click "Run Daily Cycle" to start.</p>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───

function SummaryCell({ label, value, sub, color, testId }: {
  label: string; value: string; sub?: string; color?: string; testId?: string;
}) {
  return (
    <div className="p-2 rounded-lg bg-muted/30 text-center" data-testid={testId}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${color || ""}`}>{value}</p>
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
