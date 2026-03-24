import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Crosshair, Clock, Target, TrendingDown, ShieldCheck, ArrowUpDown, ArrowUp, ArrowDown, AlertCircle, CalendarClock,
} from "lucide-react";
import type { ScreenerStock } from "@shared/schema";

// ─── Types ───

interface ScreenerData {
  lastUpdated: string;
  signals: ScreenerStock[];
  universe: unknown[];
  stats: {
    totalScanned: number;
    above200dma: number;
    dippedOver3pct: number;
    passedVolFilter: number;
    signalsGenerated: number;
  };
}

// ─── Helpers ───

type SortField = "setupScore" | "dropPct" | "limitPrice" | "profitTarget" | "symbol";
type SortDir = "asc" | "desc";

function fmtPrice(v: number): string {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

// ─── Main Component ───

export default function PositionsTab() {
  const [sortField, setSortField] = useState<SortField>("setupScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading } = useQuery<ScreenerData>({
    queryKey: ["/api/screener"],
    staleTime: 3600000,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const signals = data?.signals ?? [];

  const sortedSignals = [...signals].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    return mul * ((a as any)[sortField] - (b as any)[sortField]);
  });

  return (
    <div className="space-y-4" data-testid="positions-tab">
      {/* ── Today's Signals ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold" data-testid="signals-title">
              Today's Signals ({signals.length})
            </h2>
          </div>
          {data?.lastUpdated && (
            <span className="text-[10px] text-muted-foreground" data-testid="last-updated">
              Updated: {formatTime(data.lastUpdated)}
            </span>
          )}
        </div>

        {/* Funnel stats */}
        {data?.stats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3" data-testid="funnel-stats">
            <FunnelStat label="Scanned" value={data.stats.totalScanned} testId="stat-scanned" />
            <FunnelStat label="Above 200 DMA" value={data.stats.above200dma} testId="stat-above-dma" />
            <FunnelStat label="Dipped ≥3%" value={data.stats.dippedOver3pct} testId="stat-dipped" />
            <FunnelStat label="Vol Filter" value={data.stats.passedVolFilter} testId="stat-vol" />
            <FunnelStat label="Signals" value={data.stats.signalsGenerated} highlight testId="stat-signals" />
          </div>
        )}

        <Card>
          <CardContent className="px-0 pb-0 pt-0">
            {isLoading ? (
              <div className="p-8 text-center text-sm text-muted-foreground">Loading signals...</div>
            ) : sortedSignals.length === 0 ? (
              <div className="p-8 text-center">
                <AlertCircle className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No signals today</p>
                <p className="text-[11px] text-muted-foreground mt-1">Signals appear when stocks dip ≥3% below previous close while above 200 DMA</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow className="hover:bg-transparent">
                      <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                      <TableHead className="text-[11px] text-right">Close ₹</TableHead>
                      <TableHead className="text-[11px] text-right">Drop %</TableHead>
                      <SortHead label="Limit Buy ₹" field="limitPrice" current={sortField} dir={sortDir} onClick={() => handleSort("limitPrice")} align="right" />
                      <SortHead label="Profit Target ₹" field="profitTarget" current={sortField} dir={sortDir} onClick={() => handleSort("profitTarget")} align="right" />
                      <TableHead className="text-[11px] text-right">Time Exit</TableHead>
                      <SortHead label="Score" field="setupScore" current={sortField} dir={sortDir} onClick={() => handleSort("setupScore")} align="right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedSignals.map((s, i) => (
                      <TableRow key={s.symbol} data-testid={`row-signal-${i}`}>
                        <TableCell className="py-2 pl-4">
                          <div>
                            <span className="text-xs font-semibold">{s.symbol}</span>
                            <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{s.name}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums py-2">
                          {fmtPrice(s.close)}
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className="text-xs tabular-nums text-loss font-medium">
                            -{Math.abs(s.dropPct).toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className="text-xs tabular-nums font-medium text-primary">
                            {fmtPrice(s.limitPrice)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right py-2">
                          <span className="text-xs tabular-nums text-gain font-medium">
                            {fmtPrice(s.profitTarget)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">
                          {s.timeExit}
                        </TableCell>
                        <TableCell className="text-right py-2 pr-4">
                          <Badge variant="outline" className="text-[11px] tabular-nums font-medium">
                            {(s.setupScore * 100).toFixed(0)}
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
      </div>

      {/* ── Strategy Rules Reminder ── */}
      <Card data-testid="strategy-rules">
        <CardHeader className="py-2 px-4">
          <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-primary" />
            Strategy Rules
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Entry Rules */}
            <div>
              <h4 className="text-[11px] font-semibold text-primary mb-1.5 flex items-center gap-1">
                <Target className="w-3 h-3" /> Entry
              </h4>
              <ul className="space-y-1" data-testid="entry-rules">
                <RuleItem text="Stock must be above 200 DMA (uptrend)" />
                <RuleItem text="Close drops ≥3% from previous close" />
                <RuleItem text="Sufficient volume / ATR filter" />
                <RuleItem text="Limit buy at close price (next day open)" />
                <RuleItem text="Equal-weight position sizing" />
              </ul>
            </div>

            {/* Exit Rules */}
            <div>
              <h4 className="text-[11px] font-semibold text-primary mb-1.5 flex items-center gap-1">
                <CalendarClock className="w-3 h-3" /> Exit (first trigger wins)
              </h4>
              <ul className="space-y-1" data-testid="exit-rules">
                <RuleItem icon={<Badge variant="outline" className="text-[9px] px-1 py-0 text-[#22c55e] border-green-500/20 bg-green-500/10">PT</Badge>}>
                  Profit target: entry + 1× ATR(5)
                </RuleItem>
                <RuleItem icon={<Badge variant="outline" className="text-[9px] px-1 py-0 text-blue-400 border-blue-500/20 bg-blue-500/10">PA</Badge>}>
                  Price action: close above previous day's high
                </RuleItem>
                <RuleItem icon={<Badge variant="outline" className="text-[9px] px-1 py-0 text-yellow-500 border-yellow-500/20 bg-yellow-500/10">TE</Badge>}>
                  Time exit: 10 trading days max hold
                </RuleItem>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Sub-components ───

function FunnelStat({ label, value, highlight, testId }: {
  label: string; value: number; highlight?: boolean; testId?: string;
}) {
  return (
    <div className={`p-2 rounded-lg text-center ${highlight ? "bg-primary/10 border border-primary/20" : "bg-muted/30"}`} data-testid={testId}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${highlight ? "text-primary" : ""}`}>{value}</p>
    </div>
  );
}

function RuleItem({ text, icon }: { text?: string; icon?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-relaxed">
      {icon || <span className="text-primary mt-0.5">•</span>}
      <span>{text || ""}</span>
    </li>
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
