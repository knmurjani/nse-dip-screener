import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Briefcase, History, TrendingUp, TrendingDown, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

interface Trade {
  symbol: string; name: string; signalDate: string; entryDate: string; entryPrice: number;
  exitDate: string; exitPrice: number; exitReason: string; pnl: number; pnlPct: number;
  daysHeld: number; setupScore: number;
}

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
  equityCurve: { date: string; equity: number; drawdownPct: number; }[];
  period: { from: string; to: string };
  dataSource: string;
}

function fmtRs(v: number): string {
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(2)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toLocaleString("en-IN")}`;
}

function fmtPrice(v: number) {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function exitLabel(r: string): string {
  switch (r) { case "profit_target": return "Profit Target"; case "price_action": return "Price Action"; case "time_exit": return "Time Exit"; default: return r; }
}

function exitColor(r: string): string {
  switch (r) {
    case "profit_target": return "text-gain border-green-500/20 bg-gain";
    case "price_action": return "text-blue-400 border-blue-500/20 bg-blue-500/10";
    case "time_exit": return "text-yellow-500 border-yellow-500/20 bg-yellow-500/10";
    default: return "";
  }
}

type SortField = "entryDate" | "exitDate" | "symbol" | "pnl" | "pnlPct" | "daysHeld";
type SortDir = "asc" | "desc";

export default function PositionsTab() {
  const [subTab, setSubTab] = useState("closed");
  const [sortField, setSortField] = useState<SortField>("exitDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading } = useQuery<BacktestData>({
    queryKey: ["/api/backtest"],
    staleTime: 3600000,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  // Determine "open" positions — trades from the last signal cycle that haven't exited yet
  // Since the backtest force-closes at the end, we simulate open = last 10 days of entries
  const today = new Date().toISOString().split("T")[0];
  const tenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().split("T")[0];

  const openPositions = (data?.trades ?? []).filter(
    t => t.entryDate >= tenDaysAgo && t.exitDate >= today
  );

  const closedPositions = [...(data?.trades ?? [])].sort((a, b) => {
    const mul = sortDir === "asc" ? 1 : -1;
    if (sortField === "symbol") return mul * a.symbol.localeCompare(b.symbol);
    if (sortField === "entryDate") return mul * a.entryDate.localeCompare(b.entryDate);
    if (sortField === "exitDate") return mul * a.exitDate.localeCompare(b.exitDate);
    return mul * ((a as any)[sortField] - (b as any)[sortField]);
  });

  const s = data?.summary;
  const totalPnl = closedPositions.reduce((sum, t) => sum + t.pnl, 0);
  const winCount = closedPositions.filter(t => t.pnl > 0).length;
  const lossCount = closedPositions.filter(t => t.pnl <= 0).length;

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Capital</p>
            <p className="text-sm font-bold tabular-nums">{fmtRs(s.initialCapital)}</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Per Trade</p>
            <p className="text-sm font-bold tabular-nums">{fmtRs(s.capitalPerTrade)}</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Total P&L</p>
            <p className={`text-sm font-bold tabular-nums ${totalPnl >= 0 ? "text-gain" : "text-loss"}`}>{totalPnl >= 0 ? "+" : ""}{fmtRs(totalPnl)}</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Win / Loss</p>
            <p className="text-sm font-bold tabular-nums">{winCount}W / {lossCount}L</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Win Rate</p>
            <p className={`text-sm font-bold tabular-nums ${s.winRate >= 50 ? "text-gain" : "text-loss"}`}>{s.winRate}%</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/30 text-center">
            <p className="text-[10px] text-muted-foreground">Final Equity</p>
            <p className="text-sm font-bold tabular-nums">{fmtRs(s.finalEquity)}</p>
          </div>
        </div>
      )}

      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList className="grid w-full max-w-sm grid-cols-2 h-9">
          <TabsTrigger value="closed" className="text-xs">
            <History className="w-3.5 h-3.5 mr-1.5" />
            Closed ({closedPositions.length})
          </TabsTrigger>
          <TabsTrigger value="open" className="text-xs">
            <Briefcase className="w-3.5 h-3.5 mr-1.5" />
            Recent / Open ({openPositions.length})
          </TabsTrigger>
        </TabsList>

        {/* Closed Positions */}
        <TabsContent value="closed" className="mt-3">
          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading trade history...</div>
              ) : closedPositions.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">No closed trades yet. Run backtest first.</div>
              ) : (
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow className="hover:bg-transparent">
                        <SortHead label="Stock" field="symbol" current={sortField} dir={sortDir} onClick={() => handleSort("symbol")} />
                        <SortHead label="Entry Date" field="entryDate" current={sortField} dir={sortDir} onClick={() => handleSort("entryDate")} align="right" />
                        <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                        <SortHead label="Exit Date" field="exitDate" current={sortField} dir={sortDir} onClick={() => handleSort("exitDate")} align="right" />
                        <TableHead className="text-[11px] text-right">Exit ₹</TableHead>
                        <SortHead label="P&L" field="pnl" current={sortField} dir={sortDir} onClick={() => handleSort("pnl")} align="right" />
                        <SortHead label="P&L %" field="pnlPct" current={sortField} dir={sortDir} onClick={() => handleSort("pnlPct")} align="right" />
                        <SortHead label="Days" field="daysHeld" current={sortField} dir={sortDir} onClick={() => handleSort("daysHeld")} align="right" />
                        <TableHead className="text-[11px] text-right pr-4">Exit Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {closedPositions.map((t, i) => (
                        <TableRow key={i} data-testid={`row-closed-${i}`}>
                          <TableCell className="py-2 pl-4">
                            <div>
                              <span className="text-xs font-semibold">{t.symbol}</span>
                              <p className="text-[10px] text-muted-foreground">{t.name}</p>
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
                            <Badge variant="outline" className={`text-[11px] tabular-nums font-medium ${t.pnl >= 0 ? "text-gain border-green-500/20 bg-gain" : "text-loss border-red-500/20 bg-loss"}`}>
                              {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct}%
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-2">{t.daysHeld}d</TableCell>
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
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Open / Recent Positions */}
        <TabsContent value="open" className="mt-3">
          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {openPositions.length === 0 ? (
                <div className="p-8 text-center">
                  <Briefcase className="w-8 h-8 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No open positions right now</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Positions appear here when signals are generated and limit orders fill</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-[11px] pl-4">Stock</TableHead>
                        <TableHead className="text-[11px] text-right">Signal Date</TableHead>
                        <TableHead className="text-[11px] text-right">Entry Date</TableHead>
                        <TableHead className="text-[11px] text-right">Entry ₹</TableHead>
                        <TableHead className="text-[11px] text-right">Days Held</TableHead>
                        <TableHead className="text-[11px] text-right">Score</TableHead>
                        <TableHead className="text-[11px] text-right pr-4">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openPositions.map((t, i) => (
                        <TableRow key={i}>
                          <TableCell className="py-2 pl-4">
                            <span className="text-xs font-semibold">{t.symbol}</span>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-2">{t.signalDate}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-2">{t.entryDate}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-2">{fmtPrice(t.entryPrice)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-2">{t.daysHeld}d</TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-2">{(t.setupScore * 100).toFixed(2)}</TableCell>
                          <TableCell className="text-right py-2 pr-4">
                            <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-500/20 bg-blue-500/10">
                              Active
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
    </div>
  );
}

function SortHead({ label, field, current, dir, onClick, align = "left" }: {
  label: string; field: string; current: string; dir: string; onClick: () => void; align?: "left" | "right";
}) {
  return (
    <TableHead className={`text-[11px] whitespace-nowrap cursor-pointer select-none hover:text-foreground ${align === "right" ? "text-right" : "text-left pl-4"}`} onClick={onClick}>
      <div className={`flex items-center ${align === "right" ? "justify-end" : ""}`}>
        {label}
        {field === current ? (dir === "asc" ? <ArrowUp className="w-3 h-3 ml-1 text-primary" /> : <ArrowDown className="w-3 h-3 ml-1 text-primary" />) : <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />}
      </div>
    </TableHead>
  );
}
