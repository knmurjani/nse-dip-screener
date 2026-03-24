import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

interface BollingerSignal {
  symbol: string; name: string; close: number; prevClose: number; changePct: number;
  ma20: number; stdDev: number; upperBand2: number; lowerBand2: number; lowerBand3: number;
  zScore: number; belowMinus2: boolean; crossedAboveMinus2: boolean;
  distanceToMeanPct: number; stopLossPrice: number; targetPrice: number;
  setupScore: number; marketCap: number; status: string;
}

interface BollingerResult {
  signals: BollingerSignal[]; watchlist: BollingerSignal[]; universe: BollingerSignal[];
  stats: { totalScanned: number; belowMinus2: number; crossedAbove: number; signalsGenerated: number; };
}

function fmtPrice(v: number) { return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

type SortField = "symbol" | "close" | "changePct" | "ma20" | "zScore" | "lowerBand2" | "distanceToMeanPct" | "setupScore";
type SortDir = "asc" | "desc";
type StatusFilter = "all" | "signal" | "watchlist" | "neutral";

function zScoreColor(z: number): string {
  if (z <= -3) return "text-red-500 font-bold";
  if (z <= -2) return "text-red-400 font-semibold";
  if (z <= -1) return "text-yellow-500";
  if (z <= 1) return "text-muted-foreground";
  if (z <= 2) return "text-green-400";
  return "text-green-500 font-semibold";
}

function statusBadge(status: string) {
  switch (status) {
    case "signal": return <Badge variant="outline" className="text-[10px] text-gain border-green-500/20 bg-gain font-semibold">BUY</Badge>;
    case "watchlist": return <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-500/20 bg-yellow-500/10">WATCHING</Badge>;
    default: return <Badge variant="outline" className="text-[10px] text-muted-foreground border-border">—</Badge>;
  }
}

export default function BollingerUniverse() {
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("zScore");
  const [sortDir, setSortDir] = useState<SortDir>("asc"); // lowest z-score first
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { data, isLoading } = useQuery<BollingerResult>({
    queryKey: ["/api/bollinger/screener"],
    staleTime: 5 * 60 * 1000,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir(field === "zScore" ? "asc" : "desc"); }
  };

  const filtered = useMemo(() => {
    let items = data?.universe ?? [];
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(s => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
    }
    if (statusFilter === "signal") items = items.filter(s => s.status === "signal");
    else if (statusFilter === "watchlist") items = items.filter(s => s.status === "watchlist");
    else if (statusFilter === "neutral") items = items.filter(s => s.status === "neutral");

    return [...items].sort((a, b) => {
      const mul = sortDir === "asc" ? 1 : -1;
      if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
      return mul * ((a as any)[sortField] - (b as any)[sortField]);
    });
  }, [data, search, statusFilter, sortField, sortDir]);

  const signalCount = data?.universe.filter(s => s.status === "signal").length ?? 0;
  const watchlistCount = data?.universe.filter(s => s.status === "watchlist").length ?? 0;

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold">
            Bollinger Band Universe — Nifty 500
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
              <SelectTrigger className="w-32 h-8 text-xs" data-testid="select-bb-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All ({data?.universe.length ?? 0})</SelectItem>
                <SelectItem value="signal" className="text-xs">Buy Signals ({signalCount})</SelectItem>
                <SelectItem value="watchlist" className="text-xs">Watchlist ({watchlistCount})</SelectItem>
                <SelectItem value="neutral" className="text-xs">Neutral</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-44">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Filter..." value={search} onChange={e => setSearch(e.target.value)} className="h-8 text-xs pl-7" data-testid="input-bb-search" />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading Bollinger data...</div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow className="hover:bg-transparent">
                  <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                  <SortHead label="Close" field="close" current={sortField} dir={sortDir} onClick={() => handleSort("close")} align="right" />
                  <SortHead label="Change" field="changePct" current={sortField} dir={sortDir} onClick={() => handleSort("changePct")} align="right" />
                  <SortHead label="20-DMA" field="ma20" current={sortField} dir={sortDir} onClick={() => handleSort("ma20")} align="right" />
                  <SortHead label="Z-Score" field="zScore" current={sortField} dir={sortDir} onClick={() => handleSort("zScore")} align="right" />
                  <TableHead className="text-[11px] text-right">−2σ Band</TableHead>
                  <TableHead className="text-[11px] text-right">−3σ Stop</TableHead>
                  <SortHead label="Dist. to Mean" field="distanceToMeanPct" current={sortField} dir={sortDir} onClick={() => handleSort("distanceToMeanPct")} align="right" />
                  <TableHead className="text-[11px] text-right">Target (μ)</TableHead>
                  <SortHead label="Score" field="setupScore" current={sortField} dir={sortDir} onClick={() => handleSort("setupScore")} align="right" />
                  <TableHead className="text-[11px] text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s, i) => (
                  <TableRow
                    key={s.symbol}
                    className={s.status === "signal" ? "bg-green-500/5" : s.status === "watchlist" ? "bg-yellow-500/5" : ""}
                    data-testid={`row-bb-${i}`}
                  >
                    <TableCell className="py-2 pl-4">
                      <div>
                        <span className="text-xs font-semibold">{s.symbol}</span>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 max-w-[120px] truncate">{s.name}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(s.close)}</TableCell>
                    <TableCell className="text-right py-2">
                      <span className={`text-xs tabular-nums ${s.changePct >= 0 ? "text-gain" : "text-loss"}`}>
                        {s.changePct >= 0 ? "+" : ""}{s.changePct}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{fmtPrice(s.ma20)}</TableCell>
                    <TableCell className="text-right py-2">
                      <span className={`text-xs tabular-nums ${zScoreColor(s.zScore)}`}>
                        {s.zScore.toFixed(2)}σ
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-red-400/70 py-2">{fmtPrice(s.lowerBand2)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-red-500/50 py-2">{fmtPrice(s.lowerBand3)}</TableCell>
                    <TableCell className="text-right py-2">
                      <span className={`text-xs tabular-nums ${s.distanceToMeanPct > 0 ? "text-gain" : "text-muted-foreground"}`}>
                        {s.distanceToMeanPct > 0 ? "+" : ""}{s.distanceToMeanPct}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-primary py-2">{fmtPrice(s.targetPrice)}</TableCell>
                    <TableCell className="text-right py-2">
                      <span className="text-xs tabular-nums font-mono">{s.setupScore.toFixed(1)}</span>
                    </TableCell>
                    <TableCell className="text-center py-2">{statusBadge(s.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
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
    >
      <div className={`flex items-center ${align === "right" ? "justify-end" : ""}`}>
        {label}
        {field === current
          ? dir === "asc" ? <ArrowUp className="w-3 h-3 ml-1 text-primary" /> : <ArrowDown className="w-3 h-3 ml-1 text-primary" />
          : <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />}
      </div>
    </TableHead>
  );
}
