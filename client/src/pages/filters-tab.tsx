import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, CheckCircle2, XCircle, Filter, Calendar, BarChart3 } from "lucide-react";

interface StockDayFilter {
  symbol: string; name: string; date: string; close: number; prevClose: number; changePct: number;
  dma200: number; aboveDma200: boolean; dropPct: number; dippedOver3: boolean;
  atr5: number; atrPctClose: number; passedVolFilter: boolean;
  limitPrice: number; nextDayLow: number | null; limitWouldFill: boolean;
  setupScore: number; profitTarget: number; passedAll: boolean; failReason: string;
}

interface FilterData {
  dates: string[]; stocks: string[]; data: StockDayFilter[];
  summary: { totalStockDays: number; passedDma200: number; passedDip: number; passedVol: number; passedAll: number; limitFilled: number; };
  dataSource: string;
}

function fmtPrice(v: number) { return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function PassFail({ pass }: { pass: boolean }) {
  return pass
    ? <CheckCircle2 className="w-4 h-4 text-green-500 inline" />
    : <XCircle className="w-4 h-4 text-red-400 inline" />;
}

export default function FiltersTab() {
  const [subTab, setSubTab] = useState("daily");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedStock, setSelectedStock] = useState<string>("");
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "passed" | "failed">("all");

  const { data, isLoading } = useQuery<FilterData>({
    queryKey: ["/api/filters"],
    staleTime: 3600000,
  });

  // Set defaults when data loads
  useMemo(() => {
    if (data && !selectedDate && data.dates.length > 0) {
      setSelectedDate(data.dates[data.dates.length - 1]);
    }
    if (data && !selectedStock && data.stocks.length > 0) {
      setSelectedStock(data.stocks[0]);
    }
  }, [data]);

  // Daily view: filter by selected date
  const dailyData = useMemo(() => {
    if (!data || !selectedDate) return [];
    let filtered = data.data.filter(d => d.date === selectedDate);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(d => d.symbol.toLowerCase().includes(q) || d.name.toLowerCase().includes(q));
    }
    if (filterMode === "passed") filtered = filtered.filter(d => d.passedAll);
    if (filterMode === "failed") filtered = filtered.filter(d => !d.passedAll);
    return filtered.sort((a, b) => b.setupScore - a.setupScore);
  }, [data, selectedDate, search, filterMode]);

  // Stock view: filter by selected stock
  const stockData = useMemo(() => {
    if (!data || !selectedStock) return [];
    return data.data.filter(d => d.symbol === selectedStock).sort((a, b) => b.date.localeCompare(a.date));
  }, [data, selectedStock]);

  const passedToday = dailyData.filter(d => d.passedAll).length;
  const signalsToday = dailyData.filter(d => d.aboveDma200 && d.dippedOver3 && d.passedVolFilter).length;

  return (
    <div className="space-y-4">
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList className="grid w-full max-w-sm grid-cols-2 h-9">
          <TabsTrigger value="daily" className="text-xs">
            <Calendar className="w-3.5 h-3.5 mr-1.5" />
            Daily View
          </TabsTrigger>
          <TabsTrigger value="stock" className="text-xs">
            <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
            Stock Drill-Down
          </TabsTrigger>
        </TabsList>

        {/* ═══ DAILY VIEW ═══ */}
        <TabsContent value="daily" className="mt-4 space-y-3">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedDate} onValueChange={setSelectedDate}>
              <SelectTrigger className="w-40 h-8 text-xs" data-testid="select-date">
                <SelectValue placeholder="Select date" />
              </SelectTrigger>
              <SelectContent>
                {(data?.dates ?? []).slice().reverse().map(d => (
                  <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filterMode} onValueChange={(v: any) => setFilterMode(v)}>
              <SelectTrigger className="w-32 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All stocks</SelectItem>
                <SelectItem value="passed" className="text-xs">Passed only</SelectItem>
                <SelectItem value="failed" className="text-xs">Failed only</SelectItem>
              </SelectContent>
            </Select>

            <div className="relative flex-1 min-w-[150px] max-w-[200px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="h-8 text-xs pl-7" />
            </div>

            <span className="text-[11px] text-muted-foreground ml-auto">
              {dailyData.length} stocks · {signalsToday} signals · {passedToday} would fill
            </span>
          </div>

          {/* Funnel Summary */}
          {data && (
            <div className="grid grid-cols-5 gap-2">
              {[
                { label: "Universe", val: dailyData.length, color: "" },
                { label: "Above 200-DMA", val: dailyData.filter(d => d.aboveDma200).length, color: "" },
                { label: "Dip > 3%", val: dailyData.filter(d => d.aboveDma200 && d.dippedOver3).length, color: "" },
                { label: "ATR% > 3", val: signalsToday, color: "" },
                { label: "Limit Fill", val: passedToday, color: "text-primary font-bold" },
              ].map((s, i) => (
                <div key={i} className="text-center p-1.5 rounded bg-muted/40">
                  <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  <p className={`text-sm font-bold tabular-nums ${s.color}`}>{s.val}</p>
                </div>
              ))}
            </div>
          )}

          {/* Table */}
          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {isLoading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading filter data (this takes ~30 seconds on first load)...</div>
              ) : (
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-[11px] pl-3 sticky left-0 bg-card z-20">Stock</TableHead>
                        <TableHead className="text-[11px] text-right">Close</TableHead>
                        <TableHead className="text-[11px] text-right">Change</TableHead>
                        <TableHead className="text-[11px] text-center">200-DMA</TableHead>
                        <TableHead className="text-[11px] text-center">Dip &gt;3%</TableHead>
                        <TableHead className="text-[11px] text-center">ATR% &gt;3</TableHead>
                        <TableHead className="text-[11px] text-right">ATR(5)</TableHead>
                        <TableHead className="text-[11px] text-right">ATR%</TableHead>
                        <TableHead className="text-[11px] text-right">Limit ₹</TableHead>
                        <TableHead className="text-[11px] text-right">Next Low</TableHead>
                        <TableHead className="text-[11px] text-center">Fill?</TableHead>
                        <TableHead className="text-[11px] text-right">Score</TableHead>
                        <TableHead className="text-[11px] pr-3">Fail Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dailyData.map((d, i) => (
                        <TableRow key={i} className={d.passedAll ? "bg-green-500/5" : ""} data-testid={`row-filter-${i}`}>
                          <TableCell className="py-1.5 pl-3 sticky left-0 bg-inherit z-10">
                            <span className="text-xs font-semibold">{d.symbol}</span>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-1.5">{fmtPrice(d.close)}</TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className={`text-xs tabular-nums ${d.changePct >= 0 ? "text-gain" : "text-loss"}`}>
                              {d.changePct >= 0 ? "+" : ""}{d.changePct}%
                            </span>
                          </TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.aboveDma200} /></TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.dippedOver3} /></TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.passedVolFilter} /></TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-1.5">{fmtPrice(d.atr5)}</TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className={`text-xs tabular-nums ${d.atrPctClose > 3 ? "text-yellow-500 font-medium" : "text-muted-foreground"}`}>
                              {d.atrPctClose}%
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-primary py-1.5">{fmtPrice(d.limitPrice)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-1.5">
                            {d.nextDayLow !== null ? fmtPrice(d.nextDayLow) : "—"}
                          </TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.limitWouldFill} /></TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className="text-xs tabular-nums font-mono">{(d.setupScore * 100).toFixed(2)}</span>
                          </TableCell>
                          <TableCell className="pr-3 py-1.5">
                            <span className={`text-[10px] ${d.passedAll ? "text-gain font-medium" : "text-muted-foreground"}`}>
                              {d.passedAll ? "✓ SIGNAL" : d.failReason}
                            </span>
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

        {/* ═══ STOCK DRILL-DOWN ═══ */}
        <TabsContent value="stock" className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Select value={selectedStock} onValueChange={setSelectedStock}>
              <SelectTrigger className="w-52 h-8 text-xs" data-testid="select-stock">
                <SelectValue placeholder="Select stock" />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {(data?.stocks ?? []).map(s => (
                  <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              {stockData.length} trading days · {stockData.filter(d => d.passedAll).length} signal days
            </span>
          </div>

          <Card>
            <CardContent className="px-0 pb-0 pt-0">
              {isLoading ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
              ) : (
                <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-[11px] pl-3">Date</TableHead>
                        <TableHead className="text-[11px] text-right">Close</TableHead>
                        <TableHead className="text-[11px] text-right">Change</TableHead>
                        <TableHead className="text-[11px] text-right">200-DMA</TableHead>
                        <TableHead className="text-[11px] text-center">Above?</TableHead>
                        <TableHead className="text-[11px] text-right">Drop%</TableHead>
                        <TableHead className="text-[11px] text-center">Dip?</TableHead>
                        <TableHead className="text-[11px] text-right">ATR%</TableHead>
                        <TableHead className="text-[11px] text-center">Vol?</TableHead>
                        <TableHead className="text-[11px] text-right">Limit ₹</TableHead>
                        <TableHead className="text-[11px] text-right">Next Low</TableHead>
                        <TableHead className="text-[11px] text-center">Fill?</TableHead>
                        <TableHead className="text-[11px] pr-3">Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stockData.map((d, i) => (
                        <TableRow key={i} className={d.passedAll ? "bg-green-500/5" : ""}>
                          <TableCell className="py-1.5 pl-3 text-xs tabular-nums font-medium">{d.date}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums py-1.5">{fmtPrice(d.close)}</TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className={`text-xs tabular-nums ${d.changePct >= 0 ? "text-gain" : "text-loss"}`}>
                              {d.changePct >= 0 ? "+" : ""}{d.changePct}%
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-1.5">{fmtPrice(d.dma200)}</TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.aboveDma200} /></TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className={`text-xs tabular-nums ${d.dropPct >= 3 ? "text-loss font-medium" : "text-muted-foreground"}`}>
                              {d.dropPct > 0 ? `-${d.dropPct}%` : `+${Math.abs(d.dropPct)}%`}
                            </span>
                          </TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.dippedOver3} /></TableCell>
                          <TableCell className="text-right py-1.5">
                            <span className={`text-xs tabular-nums ${d.atrPctClose > 3 ? "text-yellow-500" : "text-muted-foreground"}`}>
                              {d.atrPctClose}%
                            </span>
                          </TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.passedVolFilter} /></TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-primary py-1.5">{fmtPrice(d.limitPrice)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums text-muted-foreground py-1.5">
                            {d.nextDayLow !== null ? fmtPrice(d.nextDayLow) : "—"}
                          </TableCell>
                          <TableCell className="text-center py-1.5"><PassFail pass={d.limitWouldFill} /></TableCell>
                          <TableCell className="pr-3 py-1.5">
                            <span className={`text-[10px] ${d.passedAll ? "text-gain font-semibold" : "text-muted-foreground"}`}>
                              {d.passedAll ? "✓ SIGNAL" : d.failReason}
                            </span>
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
