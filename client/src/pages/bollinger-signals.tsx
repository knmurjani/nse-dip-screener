import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TrendingDown, Activity, Target, ArrowUpDown, ArrowUp, ArrowDown, AlertCircle, Crosshair, Eye,
} from "lucide-react";

// ─── Types ───

interface BollingerSignal {
  symbol: string; name: string; close: number; prevClose: number; changePct: number;
  ma20: number; stdDev: number; upperBand2: number; lowerBand2: number; lowerBand3: number;
  zScore: number; belowMinus2: boolean; crossedAboveMinus2: boolean;
  distanceToMeanPct: number; stopLossPrice: number; targetPrice: number;
  setupScore: number; marketCap: number; status: string;
}

interface BollingerResult {
  lastUpdated: string;
  signals: BollingerSignal[];
  watchlist: BollingerSignal[];
  universe: BollingerSignal[];
  stats: {
    totalScanned: number;
    belowMinus2: number;
    crossedAbove: number;
    signalsGenerated: number;
  };
  dataSource: string;
}

// ─── Helpers ───

type SortField = "symbol" | "zScore" | "distanceToMeanPct" | "setupScore" | "close" | "changePct" | "marketCap";
type SortDir = "asc" | "desc";

function fmtPrice(v: number): string {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCrore(val: number): string {
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L Cr`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K Cr`;
  return `₹${val.toFixed(0)} Cr`;
}

function zScoreColor(z: number): string {
  if (z < -2) return "text-loss";
  if (z < -1) return "text-yellow-500";
  return "text-gain";
}

function zScoreBadgeClass(z: number): string {
  if (z < -2) return "text-loss border-red-500/20 bg-red-500/10";
  if (z < -1) return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
  return "text-gain border-green-500/20 bg-green-500/10";
}

function statusBadge(s: string): { label: string; cls: string } {
  switch (s) {
    case "BUY": return { label: "BUY", cls: "text-[#22c55e] border-green-500/20 bg-green-500/10" };
    case "WATCHING": return { label: "WATCHING", cls: "text-yellow-500 border-yellow-500/20 bg-yellow-500/10" };
    default: return { label: "NEUTRAL", cls: "text-muted-foreground border-muted-foreground/20 bg-muted/30" };
  }
}

// ─── Component ───

export default function BollingerSignals() {
  const [subTab, setSubTab] = useState("signals");
  const [sortField, setSortField] = useState<SortField>("setupScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading } = useQuery<BollingerResult>({
    queryKey: ["/api/bollinger/screener"],
    staleTime: 5 * 60 * 1000,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const sortList = (list: BollingerSignal[]) =>
    [...list].sort((a, b) => {
      const mul = sortDir === "asc" ? 1 : -1;
      if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
      return mul * ((a as any)[sortField] - (b as any)[sortField]);
    });

  const signals = sortList(data?.signals ?? []);
  const watchlist = sortList(data?.watchlist ?? []);
  const stats = data?.stats;

  return (
    <div className="space-y-4" data-testid="bollinger-signals">
      {/* KPI Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="bollinger-stats">
          <StatCard
            label="Scanned" value={stats.totalScanned}
            icon={<Activity className="w-4 h-4" />}
            sub="Bollinger universe"
            testId="stat-scanned"
          />
          <StatCard
            label="Below −2σ" value={stats.belowMinus2}
            icon={<Eye className="w-4 h-4" />}
            sub="Watchlist"
            testId="stat-below-2"
          />
          <StatCard
            label="Crossed Above −2σ" value={stats.crossedAbove}
            icon={<Target className="w-4 h-4" />}
            sub="Buy signals"
            highlight
            testId="stat-signals"
          />
        </div>
      )}

      {/* Sub-tabs */}
      <Tabs value={subTab} onValueChange={setSubTab} data-testid="bollinger-tabs">
        <TabsList className="grid w-full max-w-sm grid-cols-2 h-9">
          <TabsTrigger value="signals" className="text-xs" data-testid="tab-bb-signals">
            <Crosshair className="w-3.5 h-3.5 mr-1.5" />
            Signals ({data?.signals.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="watchlist" className="text-xs" data-testid="tab-bb-watchlist">
            <Eye className="w-3.5 h-3.5 mr-1.5" />
            Watchlist ({data?.watchlist.length ?? 0})
          </TabsTrigger>
        </TabsList>

        {/* Signals tab */}
        <TabsContent value="signals" className="mt-3">
          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {isLoading ? (
                <LoadingSkeleton />
              ) : signals.length === 0 ? (
                <EmptyState message="No Bollinger bounce signals today" detail="Signals appear when stocks cross back above the −2σ band" />
              ) : (
                <BollingerTable rows={signals} sortField={sortField} sortDir={sortDir} onSort={handleSort} testPrefix="signal" />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Watchlist tab */}
        <TabsContent value="watchlist" className="mt-3">
          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {isLoading ? (
                <LoadingSkeleton />
              ) : watchlist.length === 0 ? (
                <EmptyState message="No stocks below −2σ right now" detail="Stocks appear here when they dip below the lower Bollinger Band (−2σ)" />
              ) : (
                <BollingerTable rows={watchlist} sortField={sortField} sortDir={sortDir} onSort={handleSort} testPrefix="watch" />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Sub-components ───

function BollingerTable({ rows, sortField, sortDir, onSort, testPrefix }: {
  rows: BollingerSignal[]; sortField: string; sortDir: string;
  onSort: (f: SortField) => void; testPrefix: string;
}) {
  return (
    <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-card z-10">
          <TableRow className="hover:bg-transparent">
            <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => onSort("symbol")} />
            <SortHead label="Close" field="close" current={sortField} dir={sortDir} onClick={() => onSort("close")} align="right" />
            <SortHead label="Chg%" field="changePct" current={sortField} dir={sortDir} onClick={() => onSort("changePct")} align="right" />
            <SortHead label="Z-Score" field="zScore" current={sortField} dir={sortDir} onClick={() => onSort("zScore")} align="right" />
            <TableHead className="text-[11px] text-right">20-MA</TableHead>
            <TableHead className="text-[11px] text-right">−2σ Band</TableHead>
            <TableHead className="text-[11px] text-right">Target (μ)</TableHead>
            <TableHead className="text-[11px] text-right">Stop (−3σ)</TableHead>
            <SortHead label="Dist Mean%" field="distanceToMeanPct" current={sortField} dir={sortDir} onClick={() => onSort("distanceToMeanPct")} align="right" />
            <SortHead label="Score" field="setupScore" current={sortField} dir={sortDir} onClick={() => onSort("setupScore")} align="right" />
            <TableHead className="text-[11px] text-right pr-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s, i) => {
            const sb = statusBadge(s.status);
            return (
              <TableRow key={s.symbol} data-testid={`row-${testPrefix}-${i}`}>
                <TableCell className="py-2 pl-4">
                  <div>
                    <span className="text-xs font-semibold">{s.symbol}</span>
                    <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{s.name}</p>
                  </div>
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(s.close)}</TableCell>
                <TableCell className="text-right py-2">
                  <span className={`text-xs tabular-nums font-medium ${s.changePct >= 0 ? "text-gain" : "text-loss"}`}>
                    {s.changePct >= 0 ? "+" : ""}{s.changePct.toFixed(2)}%
                  </span>
                </TableCell>
                <TableCell className="text-right py-2">
                  <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${zScoreBadgeClass(s.zScore)}`}>
                    {s.zScore.toFixed(2)}σ
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{fmtPrice(s.ma20)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{fmtPrice(s.lowerBand2)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums text-gain py-2">{fmtPrice(s.targetPrice)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums text-loss py-2">{fmtPrice(s.stopLossPrice)}</TableCell>
                <TableCell className="text-right py-2">
                  <span className={`text-xs tabular-nums font-medium ${s.distanceToMeanPct > 0 ? "text-gain" : "text-loss"}`}>
                    {s.distanceToMeanPct.toFixed(1)}%
                  </span>
                </TableCell>
                <TableCell className="text-right py-2">
                  <Badge variant="secondary" className="text-[11px] tabular-nums font-mono">
                    {(s.setupScore * 100).toFixed(0)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right py-2 pr-4">
                  <Badge variant="outline" className={`text-[10px] ${sb.cls}`} data-testid={`status-${testPrefix}-${i}`}>
                    {sb.label}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function StatCard({ label, value, icon, sub, highlight, testId }: {
  label: string; value: number; icon: React.ReactNode; sub: string; highlight?: boolean; testId?: string;
}) {
  return (
    <Card className={highlight ? "border-primary/30 bg-primary/5" : ""} data-testid={testId}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
          <span className={highlight ? "text-primary" : "text-muted-foreground/60"}>{icon}</span>
        </div>
        <p className={`text-xl font-bold tabular-nums ${highlight ? "text-primary" : ""}`}>{value}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  );
}

function SortHead({ label, field, current, dir, onClick, align = "left" }: {
  label: string; field: string; current: string; dir: string; onClick: () => void; align?: "left" | "right";
}) {
  return (
    <TableHead
      className={`text-[11px] whitespace-nowrap cursor-pointer select-none hover:text-foreground ${align === "right" ? "text-right" : "text-left pl-4"}`}
      onClick={onClick}
      data-testid={`sort-bb-${field}`}
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

function EmptyState({ message, detail }: { message: string; detail: string }) {
  return (
    <div className="p-8 text-center">
      <AlertCircle className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <p className="text-[11px] text-muted-foreground mt-1">{detail}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="flex gap-4">
          <div className="h-4 w-20 bg-muted animate-pulse rounded" />
          <div className="h-4 w-16 bg-muted animate-pulse rounded" />
          <div className="h-4 w-14 bg-muted animate-pulse rounded" />
          <div className="h-4 w-16 bg-muted animate-pulse rounded" />
          <div className="h-4 w-12 bg-muted animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}
