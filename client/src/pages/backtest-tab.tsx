import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import {
  RefreshCw, TrendingUp, Trophy, AlertTriangle, Target, BarChart3,
  ArrowUpDown, ArrowUp, ArrowDown, Activity, Percent, Zap, Info,
  Plus, Trash2, Loader2, ChevronDown, ChevronUp, Play, Crosshair, Clock,
  LineChart as LineChartIcon,
} from "lucide-react";
import { useStrategy } from "@/lib/strategy-context";
import BollingerTradeChart from "@/components/bollinger-trade-chart";

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
  id: number; name: string;
  trades: Trade[];
  dailySnapshots: DailySnapshot[];
  summary: BacktestSummary;
  period: { from: string; to: string };
}

interface BacktestRunSummary {
  id: number; name: string; created_at: string; period_from: string; period_to: string;
  capital: number; max_positions: number; universe_size: number; universe_label: string;
  total_trades: number; annualized_return_pct: number; total_return_pct: number;
  win_rate: number; sharpe_ratio: number; max_drawdown_pct: number; data_source: string;
  strategy_id?: string;
  params_json?: string;
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
  const { strategyId, strategyName } = useStrategy();
  const [sortField, setSortField] = useState<SortField>("entryDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [chartRow, setChartRow] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isDeleting, setIsDeleting] = useState<number | null>(null);
  const [showRunsList, setShowRunsList] = useState(false);

  // Form state — common
  const [formName, setFormName] = useState("");
  const [formFromDate, setFormFromDate] = useState(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().slice(0, 10);
  });
  const [formToDate, setFormToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [formCapital, setFormCapital] = useState("1000000");
  const [formMaxPositions, setFormMaxPositions] = useState("10");
  const [formMaxHoldDays, setFormMaxHoldDays] = useState("10");
  const [formAbsoluteStopPct, setFormAbsoluteStopPct] = useState("");
  const [formTrailingStopPct, setFormTrailingStopPct] = useState("");
  // Form state — Bollinger-specific
  const [formMaPeriod, setFormMaPeriod] = useState("20");
  const [formEntryBandSigma, setFormEntryBandSigma] = useState("2");
  const [formStopLossSigma, setFormStopLossSigma] = useState("3");
  // Form state — Bollinger MR-specific
  const [formTargetBandSigma, setFormTargetBandSigma] = useState("2");
  const [formAllowParallel, setFormAllowParallel] = useState(false);
  // Form state — Configurable conditions (dropdowns)
  const [formWatchlistCond, setFormWatchlistCond] = useState("below_-2s");
  const [formEntryCond, setFormEntryCond] = useState(
    strategyId === "bollinger_mr" ? "cross_above_mean" : "cross_above_-2s"
  );
  const [formExitTarget, setFormExitTarget] = useState(
    strategyId === "bollinger_mr" ? "reach_+2s" : "reach_mean"
  );
  const [formExitStopBand, setFormExitStopBand] = useState(
    strategyId === "bollinger_mr" ? "below_-2s" : "below_-3s"
  );

  const isBollinger = strategyId === "bollinger_bounce" || strategyId === "bollinger_mr";

  // Reset selection when strategy changes so we don't show stale data from another strategy
  useEffect(() => {
    setSelectedRunId("");
    setShowNewForm(false);
    setChartRow(null);
    setExpandedRow(null);
  }, [strategyId]);

  // Fetch runs list — filtered by strategy
  const { data: runs } = useQuery<BacktestRunSummary[]>({
    queryKey: [`/api/backtest/runs?strategyId=${strategyId}`],
    staleTime: 30000,
  });

  // Fetch selected run or latest for this strategy
  const latestRunId = (runs && runs.length > 0) ? String(runs[0].id) : "";
  const effectiveRunId = selectedRunId || latestRunId;

  const { data, isLoading } = useQuery<BacktestResult>({
    queryKey: [`/api/backtest?runId=${effectiveRunId}`],
    enabled: !!effectiveRunId,
    staleTime: 60000,
  });

  // Sync dropdown to loaded data
  const activeRunId = data?.id ? String(data.id) : effectiveRunId;
  const activeRun = (runs ?? []).find(r => String(r.id) === activeRunId);

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    queryClient.invalidateQueries({ queryKey: [`/api/backtest?runId=${runId}`] });
  };

  const [runError, setRunError] = useState<string | null>(null);

  const handleRunBacktest = async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const body: Record<string, unknown> = {
        name: formName || undefined,
        capital: Number(formCapital),
        maxPositions: Number(formMaxPositions),
        fromDate: formFromDate,
        toDate: formToDate,
        strategyId,
        maxHoldDays: Number(formMaxHoldDays),
        absoluteStopPct: formAbsoluteStopPct ? Number(formAbsoluteStopPct) : undefined,
        trailingStopPct: formTrailingStopPct ? Number(formTrailingStopPct) : undefined,
      };
      if (strategyId === "bollinger_bounce" || strategyId === "bollinger_mr") {
        body.maPeriod = Number(formMaPeriod);
        body.entryBandSigma = Number(formEntryBandSigma);
        body.stopLossSigma = Number(formStopLossSigma);
      }
      if (strategyId === "bollinger_mr") {
        body.targetBandSigma = Number(formTargetBandSigma);
        body.allowParallelPositions = formAllowParallel;
      }
      if (isBollinger) {
        body.watchlistCondition = formWatchlistCond;
        body.entryCondition = formEntryCond;
        body.exitTarget = formExitTarget;
        body.exitStopBand = formExitStopBand;
      }
      const res = await apiRequest("POST", "/api/backtest/run", body);
      const result: BacktestResult = await res.json();
      setSelectedRunId(String(result.id));
      setShowNewForm(false);
      setFormName("");
      queryClient.invalidateQueries({ queryKey: [`/api/backtest/runs?strategyId=${strategyId}`] });
      queryClient.setQueryData([`/api/backtest?runId=${result.id}`], result);
    } catch (err: any) {
      console.error("Backtest error:", err);
      setRunError(err.message || "Backtest failed. Check server logs.");
    } finally {
      setIsRunning(false);
    }
  };

  const handleDeleteRun = async (id: number) => {
    setIsDeleting(id);
    try {
      await apiRequest("DELETE", `/api/backtest/runs/${id}`);
      queryClient.invalidateQueries({ queryKey: [`/api/backtest/runs?strategyId=${strategyId}`] });
      if (String(id) === activeRunId) {
        setSelectedRunId("");
        queryClient.invalidateQueries({ queryKey: ["/api/backtest"] });
      }
    } finally {
      setIsDeleting(null);
    }
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
  const chartData = (data?.dailySnapshots ?? []).filter((_, i) => i % 5 === 0);
  const hasRuns = (runs ?? []).length > 0;

  return (
    <div className="space-y-4" data-testid="backtest-tab">
      {/* ── Run Manager ── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3" data-testid="run-manager">
        {/* Left: Run selector dropdown */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <BarChart3 className="w-4 h-4 text-primary shrink-0" />
          <Select value={activeRunId} onValueChange={handleSelectRun}>
            <SelectTrigger className="h-8 text-xs max-w-sm" data-testid="select-run">
              <SelectValue placeholder="Select a backtest run..." />
            </SelectTrigger>
            <SelectContent>
              {(runs ?? []).map(r => (
                <SelectItem key={r.id} value={String(r.id)} className="text-xs">
                  {r.name} | {r.period_from}→{r.period_to} | {r.annualized_return_pct >= 0 ? "+" : ""}{r.annualized_return_pct.toFixed(1)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Right: New Backtest + toggle runs list */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm" className="h-8 text-xs gap-1.5"
            onClick={() => setShowRunsList(!showRunsList)}
            data-testid="button-toggle-runs"
          >
            {showRunsList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Runs ({(runs ?? []).length})
          </Button>
          <Button
            variant={showNewForm ? "secondary" : "default"} size="sm" className="h-8 text-xs gap-1.5"
            onClick={() => setShowNewForm(!showNewForm)}
            data-testid="button-new-backtest"
          >
            <Plus className="w-3.5 h-3.5" />
            New Backtest
          </Button>
        </div>
      </div>

      {/* ── New Backtest Form ── */}
      {showNewForm && (
        <Card data-testid="new-backtest-form">
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold flex items-center gap-2">
              Configure New Backtest
              <Badge variant="outline" className="text-[10px]">{strategyName}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 space-y-3">
            {/* Row 1: Core params */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Name (optional)</label>
                <Input
                  value={formName} onChange={e => setFormName(e.target.value)}
                  placeholder="Auto-generated" className="h-8 text-xs"
                  data-testid="input-name"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">From Date</label>
                <Input
                  type="date" value={formFromDate} onChange={e => setFormFromDate(e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-from-date"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">To Date</label>
                <Input
                  type="date" value={formToDate} onChange={e => setFormToDate(e.target.value)}
                  className="h-8 text-xs"
                  data-testid="input-to-date"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Capital (₹)</label>
                <Input
                  type="number" value={formCapital} onChange={e => setFormCapital(e.target.value)}
                  className="h-8 text-xs tabular-nums"
                  data-testid="input-capital"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Max Positions</label>
                <Input
                  type="number" value={formMaxPositions} onChange={e => setFormMaxPositions(e.target.value)}
                  className="h-8 text-xs tabular-nums"
                  data-testid="input-max-positions"
                />
              </div>
            </div>
            {/* Row 2: Common risk params */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Max Hold Days</label>
                <Input
                  type="number" value={formMaxHoldDays} onChange={e => setFormMaxHoldDays(e.target.value)}
                  className="h-8 text-xs tabular-nums"
                  data-testid="input-max-hold-days"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Absolute Stop Loss %</label>
                <Input
                  type="number" value={formAbsoluteStopPct} onChange={e => setFormAbsoluteStopPct(e.target.value)}
                  placeholder="e.g., 5 for -5%" className="h-8 text-xs tabular-nums"
                  data-testid="input-absolute-stop"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Trailing Stop Loss %</label>
                <Input
                  type="number" value={formTrailingStopPct} onChange={e => setFormTrailingStopPct(e.target.value)}
                  placeholder="e.g., 3 for -3% from peak" className="h-8 text-xs tabular-nums"
                  data-testid="input-trailing-stop"
                />
              </div>
            </div>
            {/* Row 3: Bollinger params — MA + configurable conditions */}
            {isBollinger && (
              <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border">
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">MA Period</label>
                  <Input
                    type="number" value={formMaPeriod} onChange={e => setFormMaPeriod(e.target.value)}
                    className="h-8 text-xs tabular-nums" data-testid="input-ma-period"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Watchlist Condition</label>
                  <Select value={formWatchlistCond} onValueChange={setFormWatchlistCond}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-watchlist-cond">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="below_-1s" className="text-xs">Below −1σ</SelectItem>
                      <SelectItem value="below_-2s" className="text-xs">Below −2σ</SelectItem>
                      <SelectItem value="below_-3s" className="text-xs">Below −3σ</SelectItem>
                      <SelectItem value="below_mean" className="text-xs">Below Mean (20-DMA)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Entry Condition</label>
                  <Select value={formEntryCond} onValueChange={setFormEntryCond}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-entry-cond">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cross_above_-2s" className="text-xs">Cross above −2σ</SelectItem>
                      <SelectItem value="cross_above_-1s" className="text-xs">Cross above −1σ</SelectItem>
                      <SelectItem value="cross_above_mean" className="text-xs">Cross above Mean</SelectItem>
                      <SelectItem value="cross_above_+1s" className="text-xs">Cross above +1σ</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Exit — Profit Target</label>
                  <Select value={formExitTarget} onValueChange={setFormExitTarget}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-exit-target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reach_mean" className="text-xs">Reach Mean (20-DMA)</SelectItem>
                      <SelectItem value="reach_+1s" className="text-xs">Reach +1σ</SelectItem>
                      <SelectItem value="reach_+2s" className="text-xs">Reach +2σ</SelectItem>
                      <SelectItem value="reach_+3s" className="text-xs">Reach +3σ</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* Row 4: Exit stop + additional params */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Exit — Band Stop Loss</label>
                  <Select value={formExitStopBand} onValueChange={setFormExitStopBand}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-exit-stop">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="below_-2s" className="text-xs">Drop below −2σ</SelectItem>
                      <SelectItem value="below_-3s" className="text-xs">Drop below −3σ</SelectItem>
                      <SelectItem value="below_-4s" className="text-xs">Drop below −4σ</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {strategyId === "bollinger_mr" && (
                  <div className="flex items-center pt-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox" checked={formAllowParallel}
                        onChange={e => setFormAllowParallel(e.target.checked)}
                        className="h-4 w-4 rounded border-input accent-primary" data-testid="input-allow-parallel"
                      />
                      <span className="text-[10px] text-muted-foreground">Allow parallel positions</span>
                    </label>
                  </div>
                )}
              </div>
              </>
            )}
            {/* Actions */}
            <div className="flex items-center gap-3">
              <Button
                size="sm" className="h-8 text-xs gap-1.5"
                onClick={handleRunBacktest} disabled={isRunning}
                data-testid="button-run-backtest"
              >
                {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {isRunning ? "Running..." : "Run Backtest"}
              </Button>
              {isRunning && (
                <span className="text-[11px] text-muted-foreground">This may take 3–5 minutes...</span>
              )}
              <Button
                variant="ghost" size="sm" className="h-8 text-xs"
                onClick={() => { setShowNewForm(false); setRunError(null); }}
                data-testid="button-cancel-form"
              >
                Cancel
              </Button>
            </div>
            {runError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2" data-testid="run-error">
                <span className="font-semibold">Error:</span> {runError}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Saved Runs List ── */}
      {showRunsList && (
        <Card data-testid="runs-list">
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold">Saved Runs</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {!hasRuns ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No saved runs yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-[11px] pl-4">Name</TableHead>
                      <TableHead className="text-[11px]">Strategy</TableHead>
                      <TableHead className="text-[11px]">Run Date</TableHead>
                      <TableHead className="text-[11px]">Period</TableHead>
                      <TableHead className="text-[11px] text-right">Ann. Ret%</TableHead>
                      <TableHead className="text-[11px] text-right">Total Ret%</TableHead>
                      <TableHead className="text-[11px] text-right">Trades</TableHead>
                      <TableHead className="text-[11px] text-right">Win Rate</TableHead>
                      <TableHead className="text-[11px] text-right">Sharpe</TableHead>
                      <TableHead className="text-[11px] text-right">Max DD</TableHead>
                      <TableHead className="text-[11px] text-right pr-4">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runs ?? []).map((r, i) => (
                      <TableRow
                        key={r.id}
                        className={activeRunId === String(r.id) ? "bg-primary/5" : ""}
                        data-testid={`row-run-${i}`}
                      >
                        <TableCell className="py-2 pl-4">
                          <div>
                            <span className="text-xs font-semibold">{r.name}</span>
                            <p className="text-[10px] text-muted-foreground">
                              {fmtRs(r.capital)} · {r.max_positions} pos · {r.universe_label}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className="text-[10px]" data-testid={`strategy-badge-${i}`}>
                            {r.strategy_id === "bollinger_mr" ? "−2σ→+2σ" : r.strategy_id === "bollinger_bounce" ? "Bollinger" : "ATR Dip"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[11px] tabular-nums text-muted-foreground py-2">
                          {new Date(r.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                          <br />
                          <span className="text-[10px]">
                            {new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs tabular-nums py-2">
                          {r.period_from} → {r.period_to}
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className={`text-xs font-medium tabular-nums ${r.annualized_return_pct >= 0 ? "text-gain" : "text-loss"}`}>
                            {r.annualized_return_pct >= 0 ? "+" : ""}{r.annualized_return_pct.toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className={`text-xs tabular-nums ${r.total_return_pct >= 0 ? "text-gain" : "text-loss"}`}>
                            {r.total_return_pct >= 0 ? "+" : ""}{r.total_return_pct.toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{r.total_trades}</TableCell>
                        <TableCell className="text-right py-2">
                          <span className={`text-xs tabular-nums ${r.win_rate >= 50 ? "text-gain" : "text-loss"}`}>
                            {r.win_rate.toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">{r.sharpe_ratio.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-loss py-2">
                          -{r.max_drawdown_pct.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right py-2 pr-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="outline" size="sm" className="h-6 px-2 text-[10px]"
                              onClick={() => handleSelectRun(String(r.id))}
                              disabled={activeRunId === String(r.id)}
                              data-testid={`button-load-${r.id}`}
                            >
                              {activeRunId === String(r.id) ? "Active" : "Load"}
                            </Button>
                            <Button
                              variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-loss"
                              onClick={() => handleDeleteRun(r.id)}
                              disabled={isDeleting === r.id}
                              data-testid={`button-delete-${r.id}`}
                            >
                              {isDeleting === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Results Section ── */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : s ? (
        <>
          {/* Run header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold" data-testid="backtest-period">
                Backtest — {strategyName}
                <span className="font-normal text-muted-foreground"> · {data?.name}</span>
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {data?.period.from} → {data?.period.to}
                {` · ₹${(s.initialCapital / 100000).toFixed(0)}L capital · ${s.maxPositions} max positions · ${s.positionSizePct}% per trade`}
                {s.dataSource && ` · via ${s.dataSource}`}
              </p>
              {/* IST timestamp from the run */}
              {activeRun?.created_at && (
                <p className="text-[10px] text-muted-foreground/70 tabular-nums mt-0.5">
                  Run date: {activeRun.created_at}
                </p>
              )}
            </div>
            {/* Delete button */}
            {data?.id && (
              <Button
                variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-muted-foreground hover:text-loss shrink-0"
                onClick={() => data?.id && handleDeleteRun(data.id)}
                disabled={isDeleting === data?.id}
                data-testid="button-delete-active-run"
              >
                {isDeleting === data?.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
                Delete Run
              </Button>
            )}
          </div>

          {/* ── Summary Dashboard ── */}

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

          {/* ── Strategy Rules ── */}
          <StrategyRulesCard strategyId={strategyId} paramsJson={activeRun?.params_json} />

          {/* ── Charts ── */}
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

          {/* ── Trade Log ── */}
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
                      {(strategyId === "bollinger_bounce" || strategyId === "bollinger_mr") && (
                        <TableHead className="text-[11px] text-center w-10">Chart</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedTrades.map((t, i) => (
                      <>
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
                        {(strategyId === "bollinger_bounce" || strategyId === "bollinger_mr") && (
                          <TableCell className="text-center py-2">
                            <button
                              className={`p-1 rounded hover:bg-muted/50 transition-colors ${
                                chartRow === i ? "text-primary bg-primary/10" : "text-muted-foreground"
                              }`}
                              onClick={() => setChartRow(chartRow === i ? null : i)}
                              data-testid={`chart-toggle-${i}`}
                              title="Toggle Bollinger Band chart"
                            >
                              <LineChartIcon className="w-3.5 h-3.5" />
                            </button>
                          </TableCell>
                        )}
                      </TableRow>
                      {/* Expanded Bollinger chart row */}
                      {chartRow === i && (strategyId === "bollinger_bounce" || strategyId === "bollinger_mr") && (
                        <TableRow key={`chart-${t.id ?? i}`} data-testid={`chart-row-${i}`}>
                          <TableCell colSpan={11} className="p-0 bg-muted/10">
                            <BollingerTradeChart
                              symbol={t.symbol}
                              entryDate={t.entryDate}
                              exitDate={t.exitDate}
                              entryPrice={t.entryPrice}
                              exitPrice={t.exitPrice}
                              exitReason={t.exitReason}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                      </>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : !hasRuns ? (
        <div className="py-16 text-center" data-testid="empty-state">
          <BarChart3 className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No backtests yet.</p>
          <p className="text-[11px] text-muted-foreground mt-1">Click "New Backtest" to run your first simulation.</p>
        </div>
      ) : (
        <div className="py-16 text-center" data-testid="no-run-selected">
          <BarChart3 className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">Select a run from the dropdown to view results.</p>
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

function StrategyRulesCard({ strategyId, paramsJson }: { strategyId: string; paramsJson?: string }) {
  const [open, setOpen] = useState(false);

  // Try to use rules saved with this specific backtest run
  let savedEntry: string[] | null = null;
  let savedExit: { name: string; description: string }[] | null = null;
  let savedParams: Record<string, unknown> | null = null;
  if (paramsJson) {
    try {
      const p = JSON.parse(paramsJson);
      savedParams = p;
      if (p.entryRules && Array.isArray(p.entryRules)) savedEntry = p.entryRules;
      if (p.exitRules && Array.isArray(p.exitRules)) savedExit = p.exitRules;
    } catch {}
  }

  // Fallback to generic strategy rules if no saved rules
  const defaultRules = strategyId === "bollinger_mr" ? {
    entry: ["20-day MA + StdDev bands", "Watchlist: close drops below \u22122\u03c3", "Entry: close crosses above 20-DMA (mean)", "Entry price = 20-DMA at crossover", "Fixed sizing (no compounding)"],
    exit: [{ name: "+2\u03c3 Target", desc: "Close > +2\u03c3 band" }, { name: "\u22122\u03c3 Stop", desc: "Close < \u22122\u03c3 band" }],
  } : strategyId === "bollinger_bounce" ? {
    entry: ["20-day MA + StdDev bands", "Watchlist below \u22122\u03c3", "Buy on cross above \u22122\u03c3", "Rank by distance below mean"],
    exit: [{ name: "Mean Target", desc: "Price reaches 20-DMA" }, { name: "\u22123\u03c3 Stop", desc: "Price drops to \u22123\u03c3" }, { name: "Time Exit", desc: "10 days max" }],
  } : {
    entry: ["Above 200-DMA", "Drop > 3%", "ATR% > 3%", "Limit buy at Close \u2212 0.9\u00d7ATR", "Rank by ATR/Close"],
    exit: [{ name: "Profit Target", desc: "Entry + 0.5\u00d7ATR(5)" }, { name: "Price Action", desc: "Close > prev high" }, { name: "Time Exit", desc: "10 days max" }],
  };

  const entryRules = savedEntry || defaultRules.entry;
  const exitRules = savedExit
    ? savedExit.map(r => ({ name: r.name, desc: r.description }))
    : defaultRules.exit;

  // Extract key params to show
  const paramsList: string[] = [];
  if (savedParams) {
    if (savedParams.capitalRs) paramsList.push(`Capital: \u20b9${((savedParams.capitalRs as number) / 100000).toFixed(0)}L`);
    if (savedParams.maxPositions) paramsList.push(`Max Positions: ${savedParams.maxPositions}`);
    if (savedParams.maxHoldDays) paramsList.push(`Max Hold: ${savedParams.maxHoldDays}d`);
    if (savedParams.maPeriod) paramsList.push(`MA: ${savedParams.maPeriod}`);
    if (savedParams.entryBandSigma) paramsList.push(`Entry \u03c3: ${savedParams.entryBandSigma}`);
    if (savedParams.targetBandSigma) paramsList.push(`Target \u03c3: ${savedParams.targetBandSigma}`);
    if (savedParams.stopLossSigma) paramsList.push(`Stop \u03c3: ${savedParams.stopLossSigma}`);
    if (savedParams.absoluteStopPct) paramsList.push(`Abs Stop: ${savedParams.absoluteStopPct}%`);
    if (savedParams.trailingStopPct) paramsList.push(`Trail Stop: ${savedParams.trailingStopPct}%`);
    if (savedParams.allowParallelPositions) paramsList.push(`Parallel: Yes`);
  }

  return (
    <Card data-testid="strategy-rules-card">
      <CardHeader className="py-2 px-4 cursor-pointer" onClick={() => setOpen(!open)} data-testid="toggle-rules">
        <CardTitle className="text-xs font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-primary" />
            Entry & Exit Rules
            {paramsList.length > 0 && (
              <span className="font-normal text-[10px] text-muted-foreground">
                ({paramsList.join(" \u00b7 ")})
              </span>
            )}
          </span>
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="px-4 pb-3 pt-0">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <h4 className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
                <Crosshair className="w-3 h-3 text-primary" /> Entry Rules
              </h4>
              <ol className="space-y-1.5">
                {entryRules.map((rule, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[9px] font-bold mt-0.5">
                      {i + 1}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{rule}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h4 className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5 mb-2">
                <Clock className="w-3 h-3 text-primary" /> Exit Rules
              </h4>
              <div className="space-y-1.5">
                {exitRules.map((rule, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge variant="outline" className="text-[9px] px-1.5 shrink-0">{rule.name}</Badge>
                    <span className="text-[11px] text-muted-foreground">{rule.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
