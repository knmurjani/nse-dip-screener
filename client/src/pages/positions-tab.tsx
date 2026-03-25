import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import {
  Rocket, Briefcase, History, Plus, Minus, Settings, Pause, Play, Square,
  TrendingUp, TrendingDown, ArrowUpDown, ArrowUp, ArrowDown,
  Wallet, BarChart3, AlertTriangle, DollarSign, Percent,
  FileText, ChevronDown, ClipboardList, RotateCw,
} from "lucide-react";
import { useStrategy } from "@/lib/strategy-context";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───

interface Deployment {
  id: number;
  name: string;
  strategy_id: string;
  mode: string;
  status: string;
  created_at: string;
  initial_capital: number;
  current_capital: number;
  max_positions: number;
  max_hold_days: number;
  absolute_stop_pct: number | null;
  trailing_stop_pct: number | null;
  ma_period: number;
  entry_band_sigma: number;
  target_band_sigma: number;
  stop_loss_sigma: number;
  allow_parallel: number;
  total_trades: number;
  winning_trades: number;
  realized_pnl: number;
  unrealized_pnl: number;
  max_drawdown_pct: number;
  last_run_date: string | null;
  positions?: DeploymentPosition[];
  trades?: DeploymentTrade[];
  snapshots?: DeploymentSnapshot[];
  funds?: FundTransaction[];
  changelog?: ChangelogEntry[];
  orders?: OrderLog[];
}

interface DeploymentPosition {
  id: number;
  deployment_id: number;
  symbol: string;
  name: string;
  direction: string;
  signal_date: string;
  entry_date: string;
  entry_time: string;
  entry_price: number;
  quantity: number;
  entry_value: number;
  current_price: number | null;
  current_value: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  trading_days_held: number;
  peak_price: number | null;
  setup_score: number | null;
  last_updated: string | null;
}

interface DeploymentTrade {
  id: number;
  deployment_id: number;
  symbol: string;
  name: string;
  direction: string;
  signal_date: string;
  entry_date: string;
  entry_time: string;
  entry_price: number;
  quantity: number;
  entry_value: number;
  exit_date: string;
  exit_time: string;
  exit_price: number;
  exit_value: number;
  pnl: number;
  pnl_pct: number;
  days_held: number;
  exit_reason: string;
  exit_reason_detail: string | null;
  setup_score: number | null;
}

interface DeploymentSnapshot {
  id: number;
  deployment_id: number;
  date: string;
  portfolio_value: number;
  cash: number;
  invested_value: number;
  unrealized_pnl: number;
  realized_pnl: number;
  open_positions: number;
  return_pct: number;
  drawdown_pct: number;
  nifty_close: number | null;
  nifty_return_pct: number | null;
}

interface FundTransaction {
  id: number;
  deployment_id: number;
  date: string;
  type: string;
  amount: number;
  balance_after: number;
  note: string | null;
}

interface ChangelogEntry {
  id: number;
  deployment_id: number;
  date: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  note: string | null;
}

interface OrderLog {
  id: number;
  deployment_id: number;
  symbol: string;
  exchange: string;
  order_type: string;
  transaction_type: string;
  quantity: number;
  price: number | null;
  status: string;
  kite_order_id: string | null;
  fill_price: number | null;
  fill_quantity: number | null;
  strategy: string;
  signal_data: string | null;
  error_message: string | null;
  placed_at: string;
  updated_at: string;
}

// ─── Helpers ───

const STRATEGY_LABELS: Record<string, string> = {
  atr_dip_buyer: "ATR Dip Buyer",
  bollinger_bounce: "Bollinger Bounce",
  bollinger_mr: "Bollinger −2σ to +2σ",
};

function isBollingerStrategy(id: string) {
  return id === "bollinger_bounce" || id === "bollinger_mr";
}

function fmtRs(v: number): string {
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString("en-IN")}`;
}

function fmtPrice(v: number): string {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChartDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function exitLabel(r: string): string {
  const labels: Record<string, string> = {
    profit_target: "Profit Target",
    price_action_close_above_prev_high: "Price Action",
    time_exit_10_days: "Time Exit",
    sigma_stop: "σ Stop",
    sigma_target: "σ Target",
    mean_target: "Mean Target",
    absolute_stop: "Abs Stop",
    trailing_stop: "Trail Stop",
    deployment_stopped: "Deploy Stop",
  };
  return labels[r] || r.replace(/_/g, " ");
}

function exitBadgeClass(r: string): string {
  if (r.includes("target") || r.includes("profit")) return "text-[#22c55e] border-green-500/20 bg-green-500/10";
  if (r.includes("stop") || r.includes("loss")) return "text-loss border-red-500/20 bg-red-500/10";
  return "text-blue-400 border-blue-500/20 bg-blue-500/10";
}

function fundTypeBadge(t: string): { label: string; cls: string } {
  switch (t) {
    case "initial_deposit": return { label: "Initial", cls: "text-blue-400 border-blue-500/20 bg-blue-500/10" };
    case "add_funds": return { label: "Deposit", cls: "text-[#22c55e] border-green-500/20 bg-green-500/10" };
    case "withdraw": return { label: "Withdraw", cls: "text-loss border-red-500/20 bg-red-500/10" };
    case "realized_pnl": return { label: "P&L", cls: "text-yellow-500 border-yellow-500/20 bg-yellow-500/10" };
    default: return { label: t, cls: "" };
  }
}

// ─── Main Component ───

export default function PositionsTab() {
  const { strategyId } = useStrategy();
  const { toast } = useToast();
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<number | null>(null);
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showFundsModal, setShowFundsModal] = useState(false);
  const [fundsAction, setFundsAction] = useState<"add_funds" | "withdraw">("add_funds");
  const [subTab, setSubTab] = useState("positions");

  // Fetch all deployments
  const { data: allDeployments, isLoading: deploymentsLoading } = useQuery<Deployment[]>({
    queryKey: ["/api/deployments"],
    staleTime: 30000,
  });

  // Filter deployments by the selected strategy
  const deployments = allDeployments?.filter(d => d.strategy_id === strategyId) || [];

  // Reset selected deployment when strategy changes
  useEffect(() => {
    setSelectedDeploymentId(null);
  }, [strategyId]);

  // Auto-select first deployment
  useEffect(() => {
    if (deployments.length > 0 && !selectedDeploymentId) {
      setSelectedDeploymentId(deployments[0].id);
    }
  }, [deployments, selectedDeploymentId]);

  // Fetch detailed deployment data
  const { data: deployment, isLoading: deploymentLoading } = useQuery<Deployment>({
    queryKey: ["/api/deployments", selectedDeploymentId],
    enabled: !!selectedDeploymentId,
    staleTime: 15000,
  });

  const hasDeployments = deployments.length > 0;

  return (
    <div className="space-y-4" data-testid="positions-tab">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Rocket className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Deployments</h2>
        </div>
        <Button
          variant="outline" size="sm" onClick={() => setShowDeployForm(true)}
          className="h-8 text-xs gap-1.5"
          data-testid="button-deploy-strategy"
        >
          <Plus className="w-3.5 h-3.5" />
          Deploy Strategy
        </Button>
      </div>

      {deploymentsLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
        </div>
      ) : !hasDeployments ? (
        <EmptyState onDeploy={() => setShowDeployForm(true)} />
      ) : (
        <>
          {/* Deployment selector */}
          {deployments.length > 1 && (
            <Select
              value={String(selectedDeploymentId || "")}
              onValueChange={(v) => setSelectedDeploymentId(Number(v))}
            >
              <SelectTrigger className="h-9 text-xs" data-testid="select-deployment">
                <SelectValue placeholder="Select deployment" />
              </SelectTrigger>
              <SelectContent>
                {deployments.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.name} — {STRATEGY_LABELS[d.strategy_id] || d.strategy_id} ({d.mode})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {deploymentLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />)}
            </div>
          ) : deployment ? (
            <DeploymentDashboard
              deployment={deployment}
              onSettings={() => setShowSettingsModal(true)}
              onAddFunds={() => { setFundsAction("add_funds"); setShowFundsModal(true); }}
              onWithdraw={() => { setFundsAction("withdraw"); setShowFundsModal(true); }}
              subTab={subTab}
              setSubTab={setSubTab}
            />
          ) : null}
        </>
      )}

      {/* Deploy Form Modal */}
      <DeployFormModal
        open={showDeployForm}
        onClose={() => setShowDeployForm(false)}
        defaultStrategy={strategyId}
      />

      {/* Settings Modal */}
      {deployment && (
        <SettingsModal
          open={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          deployment={deployment}
        />
      )}

      {/* Funds Modal */}
      {deployment && (
        <FundsModal
          open={showFundsModal}
          onClose={() => setShowFundsModal(false)}
          deployment={deployment}
          action={fundsAction}
        />
      )}
    </div>
  );
}

// ─── Empty State ───

function EmptyState({ onDeploy }: { onDeploy: () => void }) {
  return (
    <div className="py-16 text-center" data-testid="empty-deployments">
      <Rocket className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
      <p className="text-sm font-medium text-foreground mb-1">No deployments yet</p>
      <p className="text-xs text-muted-foreground mb-4">Deploy a strategy to start paper or real-money trading</p>
      <Button onClick={onDeploy} className="gap-1.5" data-testid="button-deploy-empty">
        <Rocket className="w-4 h-4" />
        Deploy Strategy
      </Button>
    </div>
  );
}

// ─── Deploy Form Modal ───

function DeployFormModal({ open, onClose, defaultStrategy }: {
  open: boolean; onClose: () => void; defaultStrategy: string;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: "",
    strategyId: defaultStrategy,
    mode: "paper",
    capital: 1000000,
    maxPositions: 10,
    maxHoldDays: 0,
    absoluteStopPct: "",
    trailingStopPct: "",
    maPeriod: 20,
    entryBandSigma: 2,
    targetBandSigma: 2,
    stopLossSigma: 2,
    allowParallel: false,
  });

  useEffect(() => {
    setForm((f) => ({ ...f, strategyId: defaultStrategy }));
  }, [defaultStrategy]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        name: form.name || undefined,
        strategyId: form.strategyId,
        mode: form.mode,
        capital: form.capital,
        maxPositions: form.maxPositions,
        maxHoldDays: form.maxHoldDays,
        absoluteStopPct: form.absoluteStopPct ? Number(form.absoluteStopPct) : null,
        trailingStopPct: form.trailingStopPct ? Number(form.trailingStopPct) : null,
      };
      if (isBollingerStrategy(form.strategyId)) {
        body.maPeriod = form.maPeriod;
        body.entryBandSigma = form.entryBandSigma;
        body.targetBandSigma = form.targetBandSigma;
        body.stopLossSigma = form.stopLossSigma;
        body.allowParallel = form.allowParallel;
      }
      const res = await apiRequest("POST", "/api/deployments", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deployments"] });
      toast({ title: "Deployment created", description: "Your strategy has been deployed" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create deployment", description: err.message, variant: "destructive" });
    },
  });

  const isBollinger = isBollingerStrategy(form.strategyId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Deploy Strategy</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Configure and deploy a new trading strategy
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Strategy */}
          <div className="space-y-1.5">
            <Label className="text-xs">Strategy</Label>
            <Select value={form.strategyId} onValueChange={(v) => setForm({ ...form, strategyId: v })}>
              <SelectTrigger className="h-9 text-xs" data-testid="deploy-strategy-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="atr_dip_buyer">ATR Dip Buyer</SelectItem>
                <SelectItem value="bollinger_bounce">Bollinger Bounce</SelectItem>
                <SelectItem value="bollinger_mr">Bollinger −2σ to +2σ</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Mode */}
          <div className="space-y-1.5">
            <Label className="text-xs">Mode</Label>
            <div className="flex items-center gap-3">
              <Button
                variant={form.mode === "paper" ? "default" : "outline"} size="sm"
                className="h-8 text-xs flex-1"
                onClick={() => setForm({ ...form, mode: "paper" })}
                data-testid="deploy-mode-paper"
              >
                Paper Trade
              </Button>
              <Button
                variant={form.mode === "real" ? "default" : "outline"} size="sm"
                className="h-8 text-xs flex-1"
                onClick={() => setForm({ ...form, mode: "real" })}
                data-testid="deploy-mode-real"
              >
                Real Money
              </Button>
            </div>
            {form.mode === "real" && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20">
                <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-yellow-500">Real money mode — trades will use actual capital. Ensure you understand the risks.</p>
              </div>
            )}
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs">Name (optional)</Label>
            <Input
              placeholder="Auto-generated if empty"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-9 text-xs"
              data-testid="deploy-name"
            />
          </div>

          {/* Capital */}
          <div className="space-y-1.5">
            <Label className="text-xs">Capital (₹)</Label>
            <Input
              type="number" value={form.capital}
              onChange={(e) => setForm({ ...form, capital: Number(e.target.value) })}
              className="h-9 text-xs"
              data-testid="deploy-capital"
            />
          </div>

          {/* Row: Max Positions + Max Hold Days */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Max Positions</Label>
              <Input
                type="number" value={form.maxPositions}
                onChange={(e) => setForm({ ...form, maxPositions: Number(e.target.value) })}
                className="h-9 text-xs"
                data-testid="deploy-max-positions"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max Hold Days (0 = no limit)</Label>
              <Input
                type="number" value={form.maxHoldDays}
                onChange={(e) => setForm({ ...form, maxHoldDays: Number(e.target.value) })}
                className="h-9 text-xs"
                data-testid="deploy-max-hold-days"
              />
            </div>
          </div>

          {/* Row: Stop Losses */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Absolute Stop Loss %</Label>
              <Input
                type="number" placeholder="e.g. 5"
                value={form.absoluteStopPct}
                onChange={(e) => setForm({ ...form, absoluteStopPct: e.target.value })}
                className="h-9 text-xs"
                data-testid="deploy-absolute-stop"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Trailing Stop Loss %</Label>
              <Input
                type="number" placeholder="e.g. 3"
                value={form.trailingStopPct}
                onChange={(e) => setForm({ ...form, trailingStopPct: e.target.value })}
                className="h-9 text-xs"
                data-testid="deploy-trailing-stop"
              />
            </div>
          </div>

          {/* Bollinger-specific fields */}
          {isBollinger && (
            <div className="space-y-3 border-t pt-3">
              <p className="text-[11px] font-semibold text-muted-foreground">Bollinger Parameters</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">MA Period</Label>
                  <Input
                    type="number" value={form.maPeriod}
                    onChange={(e) => setForm({ ...form, maPeriod: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="deploy-ma-period"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Entry σ</Label>
                  <Input
                    type="number" step="0.5" value={form.entryBandSigma}
                    onChange={(e) => setForm({ ...form, entryBandSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="deploy-entry-sigma"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Target σ</Label>
                  <Input
                    type="number" step="0.5" value={form.targetBandSigma}
                    onChange={(e) => setForm({ ...form, targetBandSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="deploy-target-sigma"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Stop σ</Label>
                  <Input
                    type="number" step="0.5" value={form.stopLossSigma}
                    onChange={(e) => setForm({ ...form, stopLossSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="deploy-stop-sigma"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.allowParallel}
                  onCheckedChange={(c) => setForm({ ...form, allowParallel: c })}
                  data-testid="deploy-allow-parallel"
                />
                <Label className="text-xs">Allow parallel positions (same stock)</Label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button
            size="sm" onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            className="text-xs gap-1.5"
            data-testid="button-confirm-deploy"
          >
            {createMutation.isPending ? "Deploying..." : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Deployment Dashboard ───

function DeploymentDashboard({ deployment, onSettings, onAddFunds, onWithdraw, subTab, setSubTab }: {
  deployment: Deployment;
  onSettings: () => void;
  onAddFunds: () => void;
  onWithdraw: () => void;
  subTab: string;
  setSubTab: (t: string) => void;
}) {
  const { toast } = useToast();
  const d = deployment;
  const positions = d.positions || [];
  const trades = d.trades || [];
  const snapshots = d.snapshots || [];
  const funds = d.funds || [];
  const changelog = d.changelog || [];
  const orders = d.orders || [];

  const winRate = d.total_trades > 0 ? ((d.winning_trades / d.total_trades) * 100) : 0;
  const investedValue = positions.reduce((sum, p) => sum + (p.current_value || p.entry_value), 0);
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const portfolioValue = d.current_capital + investedValue;
  const returnPct = d.initial_capital > 0 ? ((portfolioValue - d.initial_capital) / d.initial_capital * 100) : 0;

  const pauseResumeMutation = useMutation({
    mutationFn: async () => {
      const endpoint = d.status === "active" ? "pause" : "resume";
      const res = await apiRequest("POST", `/api/deployments/${d.id}/${endpoint}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deployments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deployments", d.id] });
      toast({ title: d.status === "active" ? "Deployment paused" : "Deployment resumed" });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deployments/${d.id}/stop`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deployments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deployments", d.id] });
      toast({ title: "Deployment stopped", description: "All positions closed" });
    },
  });

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2" data-testid="deployment-header">
        <h3 className="text-sm font-semibold truncate max-w-[200px]" data-testid="text-deployment-name">{d.name}</h3>
        <Badge variant="outline" className="text-[10px]" data-testid="badge-strategy">
          {STRATEGY_LABELS[d.strategy_id] || d.strategy_id}
        </Badge>
        <Badge
          variant="outline"
          className={`text-[10px] ${d.mode === "real" ? "text-yellow-500 border-yellow-500/20 bg-yellow-500/10" : "text-blue-400 border-blue-500/20 bg-blue-500/10"}`}
          data-testid="badge-mode"
        >
          {d.mode === "real" ? "Real Money" : "Paper"}
        </Badge>
        <Badge
          variant="outline"
          className={`text-[10px] ${d.status === "active" ? "text-[#22c55e] border-green-500/20 bg-green-500/10" : d.status === "paused" ? "text-yellow-500 border-yellow-500/20 bg-yellow-500/10" : "text-muted-foreground border-muted-foreground/20 bg-muted/30"}`}
          data-testid="badge-status"
        >
          {d.status.charAt(0).toUpperCase() + d.status.slice(1)}
        </Badge>
        <span className="text-[10px] text-muted-foreground ml-auto">{d.created_at}</span>
      </div>

      {/* Action buttons */}
      {d.status !== "stopped" && (
        <div className="flex flex-wrap gap-2" data-testid="deployment-actions">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onAddFunds} data-testid="button-add-funds">
            <Plus className="w-3 h-3" /> Add Funds
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onWithdraw} data-testid="button-withdraw">
            <Minus className="w-3 h-3" /> Withdraw
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onSettings} data-testid="button-settings">
            <Settings className="w-3 h-3" /> Settings
          </Button>
          <Button
            variant="outline" size="sm" className="h-7 text-xs gap-1"
            onClick={() => pauseResumeMutation.mutate()}
            disabled={pauseResumeMutation.isPending}
            data-testid="button-pause-resume"
          >
            {d.status === "active" ? <><Pause className="w-3 h-3" /> Pause</> : <><Play className="w-3 h-3" /> Resume</>}
          </Button>
          <Button
            variant="outline" size="sm" className="h-7 text-xs gap-1 text-loss hover:text-loss"
            onClick={() => {
              if (window.confirm("Stop this deployment? All open positions will be closed.")) {
                stopMutation.mutate();
              }
            }}
            disabled={stopMutation.isPending}
            data-testid="button-stop"
          >
            <Square className="w-3 h-3" /> Stop
          </Button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" data-testid="kpi-row-1">
        <KpiCard label="Portfolio Value" value={fmtRs(portfolioValue)} testId="kpi-portfolio-value" />
        <KpiCard label="Cash" value={fmtRs(d.current_capital)} testId="kpi-cash" />
        <KpiCard label="Invested" value={fmtRs(investedValue)} testId="kpi-invested" />
        <KpiCard
          label="Unrealized P&L" value={`${totalUnrealizedPnl >= 0 ? "+" : ""}${fmtRs(totalUnrealizedPnl)}`}
          color={totalUnrealizedPnl >= 0 ? "text-gain" : "text-loss"} testId="kpi-unrealized"
        />
        <KpiCard
          label="Realized P&L" value={`${d.realized_pnl >= 0 ? "+" : ""}${fmtRs(d.realized_pnl)}`}
          color={d.realized_pnl >= 0 ? "text-gain" : "text-loss"} testId="kpi-realized"
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" data-testid="kpi-row-2">
        <KpiCard
          label="Return" value={`${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`}
          color={returnPct >= 0 ? "text-gain" : "text-loss"} testId="kpi-return"
        />
        <KpiCard label="Open Positions" value={`${positions.length} / ${d.max_positions}`} testId="kpi-open-positions" />
        <KpiCard label="Total Trades" value={String(d.total_trades)} testId="kpi-total-trades" />
        <KpiCard
          label="Win Rate" value={`${winRate.toFixed(1)}%`}
          color={winRate >= 50 ? "text-gain" : winRate > 0 ? "text-loss" : ""} testId="kpi-win-rate"
        />
        <KpiCard label="Max Drawdown" value={`-${(d.max_drawdown_pct || 0).toFixed(1)}%`} color="text-loss" testId="kpi-max-drawdown" />
      </div>

      {/* Equity Curve */}
      {snapshots.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold">Equity Curve</CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={snapshots}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 20%)" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={formatChartDate} stroke="hsl(215, 10%, 40%)" interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(215, 10%, 40%)" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                <RTooltip
                  contentStyle={{ background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 20%)", borderRadius: "6px", fontSize: "11px" }}
                  labelFormatter={formatChartDate}
                  formatter={(value: number, name: string) => {
                    if (name === "return_pct") return [`${value.toFixed(2)}%`, "Return"];
                    if (name === "nifty_return_pct") return [`${value?.toFixed(2) ?? "—"}%`, "Nifty 50"];
                    return [value, name];
                  }}
                />
                <Line type="monotone" dataKey="return_pct" stroke="#22c55e" strokeWidth={1.5} dot={false} name="return_pct" />
                <Line type="monotone" dataKey="nifty_return_pct" stroke="#6b7280" strokeWidth={1} strokeDasharray="4 3" dot={false} name="nifty_return_pct" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Sub-tabs */}
      <Tabs value={subTab} onValueChange={setSubTab} data-testid="deployment-tabs">
        <TabsList className="grid w-full max-w-2xl grid-cols-5 h-9">
          <TabsTrigger value="positions" className="text-xs" data-testid="tab-positions">
            <Briefcase className="w-3.5 h-3.5 mr-1" />
            Open ({positions.length})
          </TabsTrigger>
          <TabsTrigger value="trades" className="text-xs" data-testid="tab-trades">
            <History className="w-3.5 h-3.5 mr-1" />
            Closed ({trades.length})
          </TabsTrigger>
          <TabsTrigger value="orders" className="text-xs" data-testid="tab-orders">
            <ClipboardList className="w-3.5 h-3.5 mr-1" />
            Orders ({orders.length})
          </TabsTrigger>
          <TabsTrigger value="funds" className="text-xs" data-testid="tab-funds">
            <Wallet className="w-3.5 h-3.5 mr-1" />
            Funds ({funds.length})
          </TabsTrigger>
          <TabsTrigger value="log" className="text-xs" data-testid="tab-log">
            <FileText className="w-3.5 h-3.5 mr-1" />
            Log ({changelog.length})
          </TabsTrigger>
        </TabsList>

        {/* Open Positions */}
        <TabsContent value="positions" className="mt-3">
          <PositionsTable positions={positions} />
        </TabsContent>

        {/* Closed Trades */}
        <TabsContent value="trades" className="mt-3">
          <TradesTable trades={trades} />
        </TabsContent>

        {/* Orders Log */}
        <TabsContent value="orders" className="mt-3">
          <OrdersTable orders={orders} />
        </TabsContent>

        {/* Fund Statement */}
        <TabsContent value="funds" className="mt-3">
          <FundsTable funds={funds} />
        </TabsContent>

        {/* Settings Log */}
        <TabsContent value="log" className="mt-3">
          <ChangelogTable entries={changelog} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── KPI Card ───

function KpiCard({ label, value, sub, color, testId }: {
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

// ─── Positions Table ───

function PositionsTable({ positions }: { positions: DeploymentPosition[] }) {
  const [sortField, setSortField] = useState<string>("entry_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const sorted = [...positions].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (sortField === "entry_date") return mul * a.entry_date.localeCompare(b.entry_date);
    return mul * (((a as any)[sortField] ?? 0) - ((b as any)[sortField] ?? 0));
  });

  if (positions.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Briefcase className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No open positions</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent">
                <SortHead label="Entry Date" field="entry_date" current={sortField} dir={sortDir} onClick={() => handleSort("entry_date")} />
                <TableHead className="text-[11px]">Entry Time</TableHead>
                <TableHead className="text-[11px]">Dir</TableHead>
                <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                <TableHead className="text-[11px] text-right">Qty</TableHead>
                <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                <TableHead className="text-[11px] text-right">Entry Value</TableHead>
                <TableHead className="text-[11px] text-right">Current ₹</TableHead>
                <SortHead label="P&L" field="pnl" current={sortField} dir={sortDir} onClick={() => handleSort("pnl")} align="right" />
                <SortHead label="P&L %" field="pnl_pct" current={sortField} dir={sortDir} onClick={() => handleSort("pnl_pct")} align="right" />
                <SortHead label="Days" field="trading_days_held" current={sortField} dir={sortDir} onClick={() => handleSort("trading_days_held")} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((p, i) => {
                const pnl = p.pnl ?? 0;
                const pnlPct = p.pnl_pct ?? 0;
                return (
                  <TableRow key={p.id} data-testid={`row-position-${i}`}>
                    <TableCell className="text-xs tabular-nums py-2 pl-4">{p.entry_date}</TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground py-2">{p.entry_time.split(" ").pop()?.replace(" IST", "") || p.entry_time}</TableCell>
                    <TableCell className="py-2">
                      <Badge variant="outline" className="text-[10px]">{p.direction}</Badge>
                    </TableCell>
                    <TableCell className="py-2">
                      <div>
                        <span className="text-xs font-semibold">{p.symbol}</span>
                        <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{p.name}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">{p.quantity}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(p.entry_price)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">{fmtRs(p.entry_value)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">
                      {p.current_price != null ? fmtPrice(p.current_price) : "—"}
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
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2 pr-4">{p.trading_days_held}d</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Trades Table ───

function TradesTable({ trades }: { trades: DeploymentTrade[] }) {
  const [sortField, setSortField] = useState<string>("exit_date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const sorted = [...trades].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (sortField === "entry_date") return mul * a.entry_date.localeCompare(b.entry_date);
    if (sortField === "exit_date") return mul * a.exit_date.localeCompare(b.exit_date);
    if (sortField === "exit_reason") return mul * a.exit_reason.localeCompare(b.exit_reason);
    return mul * (((a as any)[sortField] ?? 0) - ((b as any)[sortField] ?? 0));
  });

  if (trades.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <History className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No closed trades yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent">
                <SortHead label="Entry Date" field="entry_date" current={sortField} dir={sortDir} onClick={() => handleSort("entry_date")} />
                <TableHead className="text-[11px]">Entry Time</TableHead>
                <TableHead className="text-[11px]">Dir</TableHead>
                <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                <TableHead className="text-[11px] text-right">Qty</TableHead>
                <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                <TableHead className="text-[11px] text-right">Entry Value</TableHead>
                <SortHead label="Exit Date" field="exit_date" current={sortField} dir={sortDir} onClick={() => handleSort("exit_date")} align="right" />
                <TableHead className="text-[11px] text-right">Exit Time</TableHead>
                <TableHead className="text-[11px] text-right">Exit ₹</TableHead>
                <TableHead className="text-[11px] text-right">Exit Value</TableHead>
                <SortHead label="P&L" field="pnl" current={sortField} dir={sortDir} onClick={() => handleSort("pnl")} align="right" />
                <SortHead label="P&L %" field="pnl_pct" current={sortField} dir={sortDir} onClick={() => handleSort("pnl_pct")} align="right" />
                <SortHead label="Days" field="days_held" current={sortField} dir={sortDir} onClick={() => handleSort("days_held")} align="right" />
                <SortHead label="Exit Reason" field="exit_reason" current={sortField} dir={sortDir} onClick={() => handleSort("exit_reason")} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((t, i) => (
                <TableRow key={t.id} data-testid={`row-trade-${i}`}>
                  <TableCell className="text-xs tabular-nums py-2 pl-4">{t.entry_date}</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground py-2">{t.entry_time.split(" ").pop()?.replace(" IST", "") || t.entry_time}</TableCell>
                  <TableCell className="py-2">
                    <Badge variant="outline" className="text-[10px]">{t.direction}</Badge>
                  </TableCell>
                  <TableCell className="py-2">
                    <div>
                      <span className="text-xs font-semibold">{t.symbol}</span>
                      <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{t.name}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{t.quantity}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.entry_price)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{fmtRs(t.entry_value)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{t.exit_date}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{t.exit_time.split(" ").pop()?.replace(" IST", "") || t.exit_time}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.exit_price)}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{fmtRs(t.exit_value)}</TableCell>
                  <TableCell className="text-right py-2">
                    <span className={`text-xs font-medium tabular-nums ${t.pnl >= 0 ? "text-gain" : "text-loss"}`}>
                      {t.pnl >= 0 ? "+" : ""}{fmtRs(t.pnl)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right py-2">
                    <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${t.pnl >= 0 ? "text-gain border-green-500/20 bg-green-500/10" : "text-loss border-red-500/20 bg-red-500/10"}`}>
                      {t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct.toFixed(2)}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{t.days_held}d</TableCell>
                  <TableCell className="text-right py-2 pr-4">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className={`text-[10px] cursor-help ${exitBadgeClass(t.exit_reason)}`}>
                          {exitLabel(t.exit_reason)}
                        </Badge>
                      </TooltipTrigger>
                      {t.exit_reason_detail && (
                        <TooltipContent side="left" className="max-w-[280px]">
                          <p className="text-[11px]">{t.exit_reason_detail}</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Orders Table ───

function orderStatusBadge(status: string): { cls: string } {
  switch (status) {
    case "COMPLETE": return { cls: "text-[#22c55e] border-green-500/20 bg-green-500/10" };
    case "PLACED":
    case "OPEN": return { cls: "text-blue-400 border-blue-500/20 bg-blue-500/10" };
    case "CANCELLED": return { cls: "text-yellow-500 border-yellow-500/20 bg-yellow-500/10" };
    case "REJECTED":
    case "FAILED": return { cls: "text-loss border-red-500/20 bg-red-500/10" };
    default: return { cls: "text-muted-foreground" };
  }
}

function OrdersTable({ orders }: { orders: OrderLog[] }) {
  const [sortField, setSortField] = useState<string>("placed_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const { toast } = useToast();

  const handleRetry = async (orderId: number) => {
    setRetryingId(orderId);
    try {
      const res = await apiRequest("POST", `/api/orders/${orderId}/retry`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Retry failed");
      }
      toast({ title: "Order retried", description: "Order has been re-submitted to Kite" });
      queryClient.invalidateQueries();
    } catch (err: any) {
      toast({ title: "Retry failed", description: err.message, variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
  };

  const handleSort = (field: string) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const sorted = [...orders].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (sortField === "placed_at") return mul * a.placed_at.localeCompare(b.placed_at);
    if (sortField === "status") return mul * a.status.localeCompare(b.status);
    if (sortField === "transaction_type") return mul * a.transaction_type.localeCompare(b.transaction_type);
    return mul * (((a as any)[sortField] ?? 0) - ((b as any)[sortField] ?? 0));
  });

  if (orders.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <ClipboardList className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No orders placed yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent">
                <SortHead label="Time" field="placed_at" current={sortField} dir={sortDir} onClick={() => handleSort("placed_at")} />
                <SortHead label="Symbol" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                <SortHead label="Side" field="transaction_type" current={sortField} dir={sortDir} onClick={() => handleSort("transaction_type")} />
                <TableHead className="text-[11px]">Type</TableHead>
                <TableHead className="text-[11px] text-right">Qty</TableHead>
                <TableHead className="text-[11px] text-right">Price</TableHead>
                <TableHead className="text-[11px] text-right">Fill Price</TableHead>
                <SortHead label="Status" field="status" current={sortField} dir={sortDir} onClick={() => handleSort("status")} align="right" />
                <TableHead className="text-[11px] text-right">Kite ID</TableHead>
                <TableHead className="text-[11px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((o, i) => (
                <TableRow key={o.id} data-testid={`row-order-${i}`}>
                  <TableCell className="text-xs tabular-nums py-2 pl-4">
                    {o.placed_at.replace(" IST", "")}
                  </TableCell>
                  <TableCell className="py-2">
                    <span className="text-xs font-semibold">{o.symbol}</span>
                  </TableCell>
                  <TableCell className="py-2">
                    <Badge variant="outline" className={`text-[10px] ${o.transaction_type === "BUY" ? "text-[#22c55e] border-green-500/20 bg-green-500/10" : "text-loss border-red-500/20 bg-red-500/10"}`}>
                      {o.transaction_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs py-2">{o.order_type}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">{o.quantity}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">
                    {o.price != null ? fmtPrice(o.price) : "MKT"}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums py-2">
                    {o.fill_price != null ? fmtPrice(o.fill_price) : "—"}
                  </TableCell>
                  <TableCell className="text-right py-2">
                    <Badge variant="outline" className={`text-[10px] ${orderStatusBadge(o.status).cls}`}>
                      {o.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">
                    {o.kite_order_id || "—"}
                  </TableCell>
                  <TableCell className="text-right py-2 pr-4">
                    {(o.status === "FAILED" || o.status === "REJECTED") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={retryingId === o.id}
                        onClick={() => handleRetry(o.id)}
                      >
                        <RotateCw className={`w-3 h-3 mr-1 ${retryingId === o.id ? "animate-spin" : ""}`} />
                        Retry
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Funds Table ───

function FundsTable({ funds }: { funds: FundTransaction[] }) {
  if (funds.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Wallet className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No fund transactions</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[11px] pl-4">Date</TableHead>
                <TableHead className="text-[11px]">Type</TableHead>
                <TableHead className="text-[11px] text-right">Amount</TableHead>
                <TableHead className="text-[11px] text-right">Balance After</TableHead>
                <TableHead className="text-[11px] pr-4">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {funds.map((f, i) => {
                const badge = fundTypeBadge(f.type);
                return (
                  <TableRow key={f.id} data-testid={`row-fund-${i}`}>
                    <TableCell className="text-xs tabular-nums py-2 pl-4">{f.date}</TableCell>
                    <TableCell className="py-2">
                      <Badge variant="outline" className={`text-[10px] ${badge.cls}`}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className={`text-right text-xs tabular-nums font-medium py-2 ${f.amount >= 0 ? "text-gain" : "text-loss"}`}>
                      {f.amount >= 0 ? "+" : ""}{fmtRs(f.amount)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">{fmtRs(f.balance_after)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground py-2 pr-4 max-w-[200px] truncate">{f.note || "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Changelog Table ───

function ChangelogTable({ entries }: { entries: ChangelogEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <FileText className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No settings changes recorded</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0 pt-0">
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-[11px] pl-4">Date</TableHead>
                <TableHead className="text-[11px]">Field</TableHead>
                <TableHead className="text-[11px] text-right">Old Value</TableHead>
                <TableHead className="text-[11px] text-right">New Value</TableHead>
                <TableHead className="text-[11px] pr-4">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e, i) => (
                <TableRow key={e.id} data-testid={`row-changelog-${i}`}>
                  <TableCell className="text-xs tabular-nums py-2 pl-4">{e.date}</TableCell>
                  <TableCell className="text-xs font-medium py-2">{e.field.replace(/_/g, " ")}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{e.old_value || "—"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums font-medium text-primary py-2">{e.new_value || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground py-2 pr-4 max-w-[200px] truncate">{e.note || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Settings Modal ───

function SettingsModal({ open, onClose, deployment }: {
  open: boolean; onClose: () => void; deployment: Deployment;
}) {
  const { toast } = useToast();
  const d = deployment;
  const isBollinger = isBollingerStrategy(d.strategy_id);

  const [form, setForm] = useState({
    maxPositions: d.max_positions,
    maxHoldDays: d.max_hold_days,
    absoluteStopPct: d.absolute_stop_pct != null ? String(d.absolute_stop_pct) : "",
    trailingStopPct: d.trailing_stop_pct != null ? String(d.trailing_stop_pct) : "",
    maPeriod: d.ma_period,
    entryBandSigma: d.entry_band_sigma,
    targetBandSigma: d.target_band_sigma,
    stopLossSigma: d.stop_loss_sigma,
    allowParallel: !!d.allow_parallel,
  });

  // Reset form when deployment changes
  useEffect(() => {
    setForm({
      maxPositions: d.max_positions,
      maxHoldDays: d.max_hold_days,
      absoluteStopPct: d.absolute_stop_pct != null ? String(d.absolute_stop_pct) : "",
      trailingStopPct: d.trailing_stop_pct != null ? String(d.trailing_stop_pct) : "",
      maPeriod: d.ma_period,
      entryBandSigma: d.entry_band_sigma,
      targetBandSigma: d.target_band_sigma,
      stopLossSigma: d.stop_loss_sigma,
      allowParallel: !!d.allow_parallel,
    });
  }, [d]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        maxPositions: form.maxPositions,
        maxHoldDays: form.maxHoldDays,
        absoluteStopPct: form.absoluteStopPct ? Number(form.absoluteStopPct) : null,
        trailingStopPct: form.trailingStopPct ? Number(form.trailingStopPct) : null,
      };
      if (isBollinger) {
        body.maPeriod = form.maPeriod;
        body.entryBandSigma = form.entryBandSigma;
        body.targetBandSigma = form.targetBandSigma;
        body.stopLossSigma = form.stopLossSigma;
        body.allowParallel = form.allowParallel;
      }
      const res = await apiRequest("PUT", `/api/deployments/${d.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deployments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deployments", d.id] });
      toast({ title: "Settings updated" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update settings", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Deployment Settings</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {d.name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Max Positions</Label>
              <Input
                type="number" value={form.maxPositions}
                onChange={(e) => setForm({ ...form, maxPositions: Number(e.target.value) })}
                className="h-9 text-xs" data-testid="settings-max-positions"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Max Hold Days</Label>
              <Input
                type="number" value={form.maxHoldDays}
                onChange={(e) => setForm({ ...form, maxHoldDays: Number(e.target.value) })}
                className="h-9 text-xs" data-testid="settings-max-hold-days"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Absolute Stop %</Label>
              <Input
                type="number" placeholder="e.g. 5"
                value={form.absoluteStopPct}
                onChange={(e) => setForm({ ...form, absoluteStopPct: e.target.value })}
                className="h-9 text-xs" data-testid="settings-absolute-stop"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Trailing Stop %</Label>
              <Input
                type="number" placeholder="e.g. 3"
                value={form.trailingStopPct}
                onChange={(e) => setForm({ ...form, trailingStopPct: e.target.value })}
                className="h-9 text-xs" data-testid="settings-trailing-stop"
              />
            </div>
          </div>

          {isBollinger && (
            <div className="space-y-3 border-t pt-3">
              <p className="text-[11px] font-semibold text-muted-foreground">Bollinger Parameters</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">MA Period</Label>
                  <Input
                    type="number" value={form.maPeriod}
                    onChange={(e) => setForm({ ...form, maPeriod: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="settings-ma-period"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Entry σ</Label>
                  <Input
                    type="number" step="0.5" value={form.entryBandSigma}
                    onChange={(e) => setForm({ ...form, entryBandSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="settings-entry-sigma"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Target σ</Label>
                  <Input
                    type="number" step="0.5" value={form.targetBandSigma}
                    onChange={(e) => setForm({ ...form, targetBandSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="settings-target-sigma"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Stop σ</Label>
                  <Input
                    type="number" step="0.5" value={form.stopLossSigma}
                    onChange={(e) => setForm({ ...form, stopLossSigma: Number(e.target.value) })}
                    className="h-9 text-xs" data-testid="settings-stop-sigma"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.allowParallel}
                  onCheckedChange={(c) => setForm({ ...form, allowParallel: c })}
                  data-testid="settings-allow-parallel"
                />
                <Label className="text-xs">Allow parallel positions</Label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button
            size="sm" onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
            className="text-xs"
            data-testid="button-save-settings"
          >
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Funds Modal ───

function FundsModal({ open, onClose, deployment, action }: {
  open: boolean; onClose: () => void; deployment: Deployment; action: "add_funds" | "withdraw";
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const fundsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deployments/${deployment.id}/funds`, {
        type: action,
        amount: Number(amount),
        note: note || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deployments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deployments", deployment.id] });
      toast({ title: action === "add_funds" ? "Funds added" : "Funds withdrawn" });
      setAmount("");
      setNote("");
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Transaction failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">
            {action === "add_funds" ? "Add Funds" : "Withdraw Funds"}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Current balance: {fmtRs(deployment.current_capital)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Amount (₹)</Label>
            <Input
              type="number" placeholder="e.g. 500000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-9 text-xs"
              data-testid="funds-amount"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Input
              placeholder="e.g. Added ₹5L"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="h-9 text-xs"
              data-testid="funds-note"
            />
          </div>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button
            size="sm"
            onClick={() => fundsMutation.mutate()}
            disabled={fundsMutation.isPending || !amount || Number(amount) <= 0}
            className="text-xs"
            data-testid="button-confirm-funds"
          >
            {fundsMutation.isPending ? "Processing..." : action === "add_funds" ? "Add Funds" : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SortHead ───

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
