import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState, useEffect, useMemo } from "react";
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
import MonthlyHeatmap, { computeAllMonthlyData } from "@/components/monthly-heatmap";

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
  const [formMaxHoldDays, setFormMaxHoldDays] = useState("");
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
  const [formEntryCond, setFormEntryCond] = useState("cross_above_-2s");
  const [formExitTarget, setFormExitTarget] = useState("reach_mean");
  const [formExitStopBand, setFormExitStopBand] = useState("below_-3s");
  // Form state — ATR Dip Buyer-specific
  const [formDmaLength, setFormDmaLength] = useState("200");
  const [formDipThreshold, setFormDipThreshold] = useState("3");
  const [formAtrFilter, setFormAtrFilter] = useState("3");
  const [formLimitMult, setFormLimitMult] = useState("0.9");
  const [formProfitMult, setFormProfitMult] = useState("0.5");
  const [formPriceAction, setFormPriceAction] = useState(true);

  const isBollinger = strategyId === "bollinger_bounce";
  const isATR = strategyId === "atr_dip_buyer";

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
        maxHoldDays: formMaxHoldDays ? Number(formMaxHoldDays) : 0,
        absoluteStopPct: formAbsoluteStopPct ? Number(formAbsoluteStopPct) : undefined,
        trailingStopPct: formTrailingStopPct ? Number(formTrailingStopPct) : undefined,
      };
      if (isBollinger) {
        body.maPeriod = Number(formMaPeriod);
        body.entryBandSigma = Number(formEntryBandSigma);
        body.stopLossSigma = Number(formStopLossSigma);
        body.targetBandSigma = Number(formTargetBandSigma);
        body.allowParallelPositions = formAllowParallel;
      }
      if (isBollinger) {
        body.watchlistCondition = formWatchlistCond;
        body.entryCondition = formEntryCond;
        body.exitTarget = formExitTarget;
        body.exitStopBand = formExitStopBand;
      }
      if (isATR) {
        body.dmaLength = Number(formDmaLength);
        body.dipThresholdPct = Number(formDipThreshold);
        body.atrFilterThreshold = Number(formAtrFilter);
        body.limitOrderMultiple = Number(formLimitMult);
        body.profitTargetMultiple = Number(formProfitMult);
        body.priceActionExit = formPriceAction;
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

  // Monthly returns data for heatmap & KPIs
  const monthlyData = useMemo(() => {
    if (!data?.dailySnapshots || !s) return null;
    return computeAllMonthlyData(data.dailySnapshots, s.initialCapital);
  }, [data?.dailySnapshots, s]);

  // Nifty benchmark summary stats
  const niftySummary = useMemo(() => {
    if (!data?.dailySnapshots || data.dailySnapshots.length < 2) return null;
    const snaps = data.dailySnapshots;
    const firstNifty = snaps.find(d => d.niftyClose > 0);
    const lastNifty = [...snaps].reverse().find(d => d.niftyClose > 0);
    if (!firstNifty || !lastNifty || firstNifty.niftyClose <= 0) return null;
    const totalReturnPct = ((lastNifty.niftyClose - firstNifty.niftyClose) / firstNifty.niftyClose) * 100;
    const days = Math.max(1, (new Date(lastNifty.date).getTime() - new Date(firstNifty.date).getTime()) / (1000 * 60 * 60 * 24));
    const years = days / 365.25;
    const annualizedPct = years > 0 ? (Math.pow(1 + totalReturnPct / 100, 1 / years) - 1) * 100 : totalReturnPct;
    // Max drawdown for Nifty
    let peak = firstNifty.niftyClose;
    let maxDD = 0;
    for (const d of snaps) {
      if (d.niftyClose > peak) peak = d.niftyClose;
      const dd = peak > 0 ? ((peak - d.niftyClose) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    return { totalReturnPct, annualizedPct, maxDrawdownPct: maxDD };
  }, [data?.dailySnapshots]);

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
                  placeholder="No limit" className="h-8 text-xs tabular-nums"
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
                {strategyId === "bollinger_bounce" && (
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
            {/* Row 3b: ATR Dip Buyer params */}
            {isATR && (
              <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-2 border-t border-border">
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">DMA Length</label>
                  <Select value={formDmaLength} onValueChange={setFormDmaLength}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-dma-length">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="50" className="text-xs">50</SelectItem>
                      <SelectItem value="100" className="text-xs">100</SelectItem>
                      <SelectItem value="200" className="text-xs">200</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Dip Threshold</label>
                  <Select value={formDipThreshold} onValueChange={setFormDipThreshold}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-dip-threshold">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2" className="text-xs">2%</SelectItem>
                      <SelectItem value="3" className="text-xs">3%</SelectItem>
                      <SelectItem value="5" className="text-xs">5%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">ATR Filter</label>
                  <Select value={formAtrFilter} onValueChange={setFormAtrFilter}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-atr-filter">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2" className="text-xs">2</SelectItem>
                      <SelectItem value="3" className="text-xs">3</SelectItem>
                      <SelectItem value="4" className="text-xs">4</SelectItem>
                      <SelectItem value="5" className="text-xs">5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Limit Order ×ATR</label>
                  <Select value={formLimitMult} onValueChange={setFormLimitMult}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-limit-mult">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0.5" className="text-xs">0.5</SelectItem>
                      <SelectItem value="0.7" className="text-xs">0.7</SelectItem>
                      <SelectItem value="0.9" className="text-xs">0.9</SelectItem>
                      <SelectItem value="1.0" className="text-xs">1.0</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Profit Target ×ATR</label>
                  <Select value={formProfitMult} onValueChange={setFormProfitMult}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-profit-mult">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0.3" className="text-xs">0.3</SelectItem>
                      <SelectItem value="0.5" className="text-xs">0.5</SelectItem>
                      <SelectItem value="0.7" className="text-xs">0.7</SelectItem>
                      <SelectItem value="1.0" className="text-xs">1.0</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center pt-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox" checked={formPriceAction}
                      onChange={e => setFormPriceAction(e.target.checked)}
                      className="h-4 w-4 rounded border-input accent-primary" data-testid="input-price-action"
                    />
                    <span className="text-[10px] text-muted-foreground">Price Action Exit</span>
                  </label>
                </div>
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
                            {r.strategy_id === "bollinger_bounce" || r.strategy_id === "bollinger_mr" ? "Bollinger" : "ATR Dip"}
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
              sub={niftySummary ? `${fmtRs(s.totalReturn)} (Nifty: ${niftySummary.totalReturnPct >= 0 ? "+" : ""}${niftySummary.totalReturnPct.toFixed(1)}%)` : fmtRs(s.totalReturn)}
              subColor={s.totalReturnPct >= 0 ? "text-gain" : "text-loss"}
              icon={<TrendingUp className="w-4 h-4" />}
              testId="kpi-total-return"
            />
            <MetricCard
              label="Annualized Return" value={`${s.annualizedReturnPct >= 0 ? "+" : ""}${s.annualizedReturnPct.toFixed(1)}%`}
              sub={niftySummary ? `${s.totalDays}d (Nifty: ${niftySummary.annualizedPct >= 0 ? "+" : ""}${niftySummary.annualizedPct.toFixed(1)}%)` : `${s.totalDays} days`}
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
              sub={niftySummary ? `${s.maxDrawdownDate} (Nifty: -${niftySummary.maxDrawdownPct.toFixed(1)}%)` : s.maxDrawdownDate}
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

          {/* Row 3: Monthly stats */}
          {monthlyData && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3" data-testid="kpi-row-monthly">
              <SmallMetric
                label="Monthly Win Rate"
                value={`${monthlyData.strategyStats.winRate.toFixed(1)}%`}
                sub={`${monthlyData.strategyStats.positiveMonths}/${monthlyData.strategyStats.totalMonths} months`}
                good={monthlyData.strategyStats.winRate >= 50}
                testId="kpi-monthly-win-rate"
              />
              <SmallMetric
                label={`Best Month (${monthlyData.strategyStats.bestMonth.label})`}
                value={`+${monthlyData.strategyStats.bestMonth.value.toFixed(1)}%`}
                good
                testId="kpi-best-month"
              />
              <SmallMetric
                label={`Worst Month (${monthlyData.strategyStats.worstMonth.label})`}
                value={`${monthlyData.strategyStats.worstMonth.value.toFixed(1)}%`}
                good={false}
                testId="kpi-worst-month"
              />
            </div>
          )}

          {/* Row 4: 6 small metrics */}
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

          {/* ── Monthly Returns Heatmap ── */}
          {data?.dailySnapshots && s && (
            <MonthlyHeatmap
              snapshots={data.dailySnapshots}
              initialCapital={s.initialCapital}
            />
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
                      <TableHead className="text-[11px] text-center w-10">Chart</TableHead>
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
                        <TableCell className="text-center py-2">
                          <button
                            className={`p-1 rounded hover:bg-muted/50 transition-colors ${
                              chartRow === i ? "text-primary bg-primary/10" : "text-muted-foreground"
                            }`}
                            onClick={() => setChartRow(chartRow === i ? null : i)}
                            data-testid={`chart-toggle-${i}`}
                            title="Toggle trade chart"
                          >
                            <LineChartIcon className="w-3.5 h-3.5" />
                          </button>
                        </TableCell>
                      </TableRow>
                      {/* Expanded trade chart row */}
                      {chartRow === i && (
                        <TableRow key={`chart-${t.id ?? i}`} data-testid={`chart-row-${i}`}>
                          <TableCell colSpan={12} className="p-0 bg-muted/10">
                            <BollingerTradeChart
                              symbol={t.symbol}
                              entryDate={t.entryDate}
                              exitDate={t.exitDate}
                              entryPrice={t.entryPrice}
                              exitPrice={t.exitPrice}
                              exitReason={t.exitReason}
                              strategyId={strategyId}
                              dmaLength={activeRun?.params_json ? (() => { try { const p = JSON.parse(activeRun.params_json!); return p.dmaLength; } catch { return undefined; } })() : undefined}
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

function RuleRow({ label, value }: { label: string; value: string | number }) {
  const isNA = value === "N/A" || value === "\u2014";
  return (
    <div className="flex items-baseline justify-between py-1 gap-4">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <span className={`text-[11px] tabular-nums text-right ${isNA ? "text-muted-foreground/40 italic" : "font-medium"}`}>
        {String(value)}
      </span>
    </div>
  );
}

function StrategyRulesCard({ strategyId, paramsJson }: { strategyId: string; paramsJson?: string }) {
  const [open, setOpen] = useState(false);

  // Parse the saved params
  let savedParams: Record<string, unknown> | null = null;
  let tpl: Record<string, any> | null = null;
  if (paramsJson) {
    try {
      const p = JSON.parse(paramsJson);
      savedParams = p;
      if (p.rulesTemplate) tpl = p.rulesTemplate;
    } catch {}
  }

  // Build compact summary for the collapsed header
  const summaryParts: string[] = [];
  if (tpl) {
    summaryParts.push(tpl.strategy || strategyId);
    if (tpl.parameters?.capital) summaryParts.push(String(tpl.parameters.capital));
    if (tpl.parameters?.maxPositions) summaryParts.push(`${tpl.parameters.maxPositions} pos`);
  } else if (savedParams) {
    if (savedParams.capitalRs) summaryParts.push(`\u20b9${((savedParams.capitalRs as number) / 100000).toFixed(0)}L`);
    if (savedParams.maxPositions) summaryParts.push(`${savedParams.maxPositions} pos`);
  }

  return (
    <Card data-testid="strategy-rules-card">
      <CardHeader className="py-2 px-4 cursor-pointer" onClick={() => setOpen(!open)} data-testid="toggle-rules">
        <CardTitle className="text-xs font-semibold flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-primary" />
            Backtest Configuration
            {summaryParts.length > 0 && (
              <span className="font-normal text-[10px] text-muted-foreground">
                ({summaryParts.join(" \u00b7 ")})
              </span>
            )}
          </span>
          {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="px-4 pb-3 pt-0">
          {tpl ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
              {/* PARAMETERS */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 mb-1.5 border-b border-border pb-1">
                  Parameters
                </h4>
                <RuleRow label="MA Period" value={tpl.parameters?.maPeriod ?? "N/A"} />
                <RuleRow label="Capital" value={tpl.parameters?.capital ?? "N/A"} />
                <RuleRow label="Max Positions" value={tpl.parameters?.maxPositions ?? "N/A"} />
                <RuleRow label="Position Sizing" value={tpl.parameters?.positionSizing ?? "N/A"} />
                <RuleRow label="Allow Parallel" value={tpl.parameters?.allowParallel ?? "No"} />
              </div>
              {/* ENTRY RULES */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 mb-1.5 border-b border-border pb-1 flex items-center gap-1">
                  <Crosshair className="w-3 h-3 text-primary" /> Entry Rules
                </h4>
                <RuleRow label="Watchlist Trigger" value={tpl.entry?.watchlistTrigger ?? "N/A"} />
                <RuleRow label="Entry Condition" value={tpl.entry?.entryCondition ?? "N/A"} />
                <RuleRow label="Entry Price" value={tpl.entry?.entryPrice ?? "N/A"} />
                <RuleRow label="DMA Length" value={tpl.entry?.dmaLength ?? "N/A"} />
                <RuleRow label="Dip Threshold" value={tpl.entry?.dipThreshold ?? "N/A"} />
                <RuleRow label="ATR Filter" value={tpl.entry?.atrFilterThreshold ?? "N/A"} />
                <RuleRow label="Limit Order" value={tpl.entry?.limitOrderMultiple != null && tpl.entry?.limitOrderMultiple !== "N/A" ? `${tpl.entry.limitOrderMultiple}\u00d7ATR` : "N/A"} />
              </div>
              {/* EXIT RULES */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 mb-1.5 border-b border-border pb-1 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-primary" /> Exit Rules
                </h4>
                <RuleRow label="Profit Target" value={tpl.exit?.profitTarget ?? "N/A"} />
                <RuleRow label="Band Stop Loss" value={tpl.exit?.bandStopLoss ?? "N/A"} />
                <RuleRow label="Absolute Stop" value={tpl.exit?.absoluteStopLoss ?? "N/A"} />
                <RuleRow label="Trailing Stop" value={tpl.exit?.trailingStopLoss ?? "N/A"} />
                <RuleRow label="Price Action Exit" value={tpl.exit?.priceActionExit ?? "N/A"} />
                <RuleRow label="Max Hold Days" value={tpl.exit?.maxHoldDays ?? "No limit"} />
              </div>
              {/* DATA */}
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 mb-1.5 border-b border-border pb-1">
                  Data
                </h4>
                <RuleRow label="Universe" value={tpl.data?.universe ?? "N/A"} />
                <RuleRow label="Data Source" value={tpl.data?.dataSource ?? "N/A"} />
                {tpl.period && (
                  <RuleRow label="Period" value={`${tpl.period.from} \u2192 ${tpl.period.to}`} />
                )}
              </div>
            </div>
          ) : (
            /* Fallback for older runs without rulesTemplate */
            <div className="text-[11px] text-muted-foreground">
              <p>No detailed configuration template available for this run.</p>
              {savedParams && (
                <pre className="mt-2 text-[10px] bg-muted/30 rounded p-2 overflow-x-auto max-h-40">
                  {JSON.stringify(savedParams, null, 2)}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
