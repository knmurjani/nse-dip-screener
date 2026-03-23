import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RefreshCw,
  TrendingDown,
  Target,
  Activity,
  BarChart3,
  Search,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Filter,
  Clock,
  Crosshair,
  Sun,
  Moon,
  Info,
} from "lucide-react";
import type { ScreenerStock, UniverseStock } from "@shared/schema";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";

interface ScreenerData {
  lastUpdated: string;
  signals: ScreenerStock[];
  universe: UniverseStock[];
  stats: {
    totalScanned: number;
    above200dma: number;
    dippedOver3pct: number;
    passedVolFilter: number;
    signalsGenerated: number;
  };
}

type SortField =
  | "setupScore"
  | "dropPct"
  | "atrPctClose"
  | "marketCap"
  | "limitPrice"
  | "close"
  | "symbol";
type SortDir = "asc" | "desc";
type UniverseSortField =
  | "symbol"
  | "close"
  | "dma200"
  | "atr5"
  | "atrPctClose"
  | "marketCap"
  | "changePct";

function formatCrore(val: number): string {
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L Cr`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}K Cr`;
  return `₹${val.toFixed(0)} Cr`;
}

function formatPrice(val: number): string {
  return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export default function Dashboard() {
  const [darkMode, setDarkMode] = useState(() => {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [search, setSearch] = useState("");
  const [universeSearch, setUniverseSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("setupScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [uSortField, setUSortField] = useState<UniverseSortField>("marketCap");
  const [uSortDir, setUSortDir] = useState<SortDir>("desc");
  const [activeTab, setActiveTab] = useState("signals");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  const { data, isLoading, isFetching } = useQuery<ScreenerData>({
    queryKey: ["/api/screener"],
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });

  const handleRefresh = async () => {
    await apiRequest("POST", "/api/screener/refresh");
    queryClient.invalidateQueries({ queryKey: ["/api/screener"] });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const handleUSort = (field: UniverseSortField) => {
    if (uSortField === field) {
      setUSortDir(uSortDir === "asc" ? "desc" : "asc");
    } else {
      setUSortField(field);
      setUSortDir("desc");
    }
  };

  const filteredSignals = (data?.signals ?? [])
    .filter(
      (s) =>
        s.symbol.toLowerCase().includes(search.toLowerCase()) ||
        s.name.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const mul = sortDir === "asc" ? 1 : -1;
      if (sortField === "symbol")
        return mul * a.symbol.localeCompare(b.symbol);
      return mul * ((a as any)[sortField] - (b as any)[sortField]);
    });

  const filteredUniverse = (data?.universe ?? [])
    .filter(
      (s) =>
        s.symbol.toLowerCase().includes(universeSearch.toLowerCase()) ||
        s.name.toLowerCase().includes(universeSearch.toLowerCase())
    )
    .sort((a, b) => {
      const mul = uSortDir === "asc" ? 1 : -1;
      if (uSortField === "symbol")
        return mul * a.symbol.localeCompare(b.symbol);
      return mul * ((a as any)[uSortField] - (b as any)[uSortField]);
    });

  const SortIcon = ({
    field,
    current,
    dir,
  }: {
    field: string;
    current: string;
    dir: string;
  }) => {
    if (field !== current)
      return <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />;
    return dir === "asc" ? (
      <ArrowUp className="w-3 h-3 ml-1 text-primary" />
    ) : (
      <ArrowDown className="w-3 h-3 ml-1 text-primary" />
    );
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg
              viewBox="0 0 32 32"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-primary"
              aria-label="Dip Screener logo"
            >
              <polyline points="4,22 10,16 16,20 22,8 28,14" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="22" cy="8" r="3" fill="currentColor" stroke="none" />
              <line x1="4" y1="28" x2="28" y2="28" strokeWidth="1.5" opacity="0.3" />
            </svg>
            <div>
              <h1 className="text-sm font-semibold tracking-tight leading-none">
                NSE Dip Screener
              </h1>
              <p className="text-[11px] text-muted-foreground leading-none mt-0.5">
                Mean-Reversion Strategy
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data?.lastUpdated && (
              <span className="text-[11px] text-muted-foreground hidden sm:inline tabular-nums">
                Updated {formatTime(data.lastUpdated)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isFetching}
              className="h-8 text-xs gap-1.5"
              data-testid="button-refresh"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDarkMode(!darkMode)}
              className="h-8 w-8 p-0"
              data-testid="button-theme-toggle"
            >
              {darkMode ? (
                <Sun className="w-4 h-4" />
              ) : (
                <Moon className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 space-y-5">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KPICard
            label="Universe"
            value={data?.stats.totalScanned ?? 0}
            icon={<BarChart3 className="w-4 h-4" />}
            sub="₹1K Cr+ market cap"
            loading={isLoading}
          />
          <KPICard
            label="Above 200 DMA"
            value={data?.stats.above200dma ?? 0}
            icon={<TrendingDown className="w-4 h-4" />}
            sub="Uptrend filter"
            loading={isLoading}
          />
          <KPICard
            label="Dipped > 3%"
            value={data?.stats.dippedOver3pct ?? 0}
            icon={<Activity className="w-4 h-4" />}
            sub="Signal day"
            loading={isLoading}
          />
          <KPICard
            label="Vol Filter Pass"
            value={data?.stats.passedVolFilter ?? 0}
            icon={<Filter className="w-4 h-4" />}
            sub="ATR% > 3"
            loading={isLoading}
          />
          <KPICard
            label="Signals"
            value={data?.stats.signalsGenerated ?? 0}
            icon={<Target className="w-4 h-4" />}
            sub="Actionable trades"
            loading={isLoading}
            highlight
          />
        </div>

        {/* Main Content */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full max-w-md grid-cols-3 h-9">
            <TabsTrigger value="signals" className="text-xs" data-testid="tab-signals">
              <Target className="w-3.5 h-3.5 mr-1.5" />
              Signals ({data?.signals.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="universe" className="text-xs" data-testid="tab-universe">
              <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
              Universe ({data?.universe.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="rules" className="text-xs" data-testid="tab-rules">
              <Info className="w-3.5 h-3.5 mr-1.5" />
              Strategy Rules
            </TabsTrigger>
          </TabsList>

          {/* SIGNALS TAB */}
          <TabsContent value="signals" className="mt-4">
            <Card>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">
                    Active Signals — Limit Buy Orders for Tomorrow
                  </CardTitle>
                  <div className="relative w-48">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Filter..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="h-8 text-xs pl-7"
                      data-testid="input-signal-search"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {isLoading ? (
                  <SignalsSkeleton />
                ) : filteredSignals.length === 0 ? (
                  <div className="py-16 text-center">
                    <Target className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">
                      {search
                        ? "No matching signals"
                        : "No dip signals today. Market may be calm or most stocks are in a downtrend."}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <SortableHeader
                            label="Stock"
                            field="symbol"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("symbol")}
                          />
                          <SortableHeader
                            label="Close"
                            field="close"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("close")}
                            align="right"
                          />
                          <SortableHeader
                            label="Drop %"
                            field="dropPct"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("dropPct")}
                            align="right"
                          />
                          <SortableHeader
                            label="200 DMA"
                            field="close"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => {}}
                            align="right"
                            noSort
                          />
                          <SortableHeader
                            label="ATR(5)"
                            field="atrPctClose"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("atrPctClose")}
                            align="right"
                          />
                          <SortableHeader
                            label="Limit Buy"
                            field="limitPrice"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("limitPrice")}
                            align="right"
                          />
                          <SortableHeader
                            label="Profit Target"
                            field="close"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => {}}
                            align="right"
                            noSort
                          />
                          <SortableHeader
                            label="Score"
                            field="setupScore"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("setupScore")}
                            align="right"
                          />
                          <SortableHeader
                            label="Mkt Cap"
                            field="marketCap"
                            current={sortField}
                            dir={sortDir}
                            onClick={() => handleSort("marketCap")}
                            align="right"
                          />
                          <TableHead className="text-[11px] text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1">
                              <Clock className="w-3 h-3" />
                              Exit By
                            </div>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredSignals.map((signal, idx) => (
                          <TableRow
                            key={signal.symbol}
                            className="group"
                            data-testid={`row-signal-${idx}`}
                          >
                            <TableCell className="py-2.5 pl-4">
                              <div>
                                <span className="text-xs font-semibold">
                                  {signal.symbol}
                                </span>
                                <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 max-w-[140px] truncate">
                                  {signal.name}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs py-2.5">
                              {formatPrice(signal.close)}
                            </TableCell>
                            <TableCell className="text-right py-2.5">
                              <Badge
                                variant="outline"
                                className="text-loss border-red-500/20 bg-loss text-[11px] tabular-nums font-medium"
                              >
                                -{signal.dropPct.toFixed(2)}%
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground py-2.5">
                              {formatPrice(signal.dma200)}
                            </TableCell>
                            <TableCell className="text-right py-2.5">
                              <Tooltip>
                                <TooltipTrigger>
                                  <span className="text-xs tabular-nums">
                                    {signal.atrPctClose.toFixed(1)}%
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  ATR(5) = {formatPrice(signal.atr5)}
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right py-2.5">
                              <span className="text-xs font-semibold text-primary tabular-nums">
                                {formatPrice(signal.limitPrice)}
                              </span>
                            </TableCell>
                            <TableCell className="text-right py-2.5">
                              <span className="text-xs tabular-nums text-gain">
                                {formatPrice(signal.profitTarget)}
                              </span>
                            </TableCell>
                            <TableCell className="text-right py-2.5">
                              <Tooltip>
                                <TooltipTrigger>
                                  <Badge
                                    variant="secondary"
                                    className="text-[11px] tabular-nums font-mono"
                                  >
                                    {(signal.setupScore * 100).toFixed(2)}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  ATR(5)/Close × 100 — higher = more volatile
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground py-2.5">
                              {formatCrore(signal.marketCap)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground py-2.5 pr-4">
                              {signal.timeExit}
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

          {/* UNIVERSE TAB */}
          <TabsContent value="universe" className="mt-4">
            <Card>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">
                    Full Universe — NSE Stocks (₹1,000 Cr+)
                  </CardTitle>
                  <div className="relative w-48">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Filter..."
                      value={universeSearch}
                      onChange={(e) => setUniverseSearch(e.target.value)}
                      className="h-8 text-xs pl-7"
                      data-testid="input-universe-search"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                {isLoading ? (
                  <SignalsSkeleton />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <SortableHeader
                            label="Stock"
                            field="symbol"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("symbol")}
                          />
                          <SortableHeader
                            label="Close"
                            field="close"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("close")}
                            align="right"
                          />
                          <SortableHeader
                            label="Change"
                            field="changePct"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("changePct")}
                            align="right"
                          />
                          <SortableHeader
                            label="200 DMA"
                            field="dma200"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("dma200")}
                            align="right"
                          />
                          <TableHead className="text-[11px] text-center whitespace-nowrap">
                            Trend
                          </TableHead>
                          <SortableHeader
                            label="ATR(5)"
                            field="atr5"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("atr5")}
                            align="right"
                          />
                          <SortableHeader
                            label="ATR%"
                            field="atrPctClose"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("atrPctClose")}
                            align="right"
                          />
                          <SortableHeader
                            label="Mkt Cap"
                            field="marketCap"
                            current={uSortField}
                            dir={uSortDir}
                            onClick={() => handleUSort("marketCap")}
                            align="right"
                          />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredUniverse.map((stock, idx) => (
                          <TableRow
                            key={stock.symbol}
                            data-testid={`row-universe-${idx}`}
                          >
                            <TableCell className="py-2 pl-4">
                              <div>
                                <span className="text-xs font-semibold">
                                  {stock.symbol}
                                </span>
                                <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 max-w-[140px] truncate">
                                  {stock.name}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs py-2">
                              {formatPrice(stock.close)}
                            </TableCell>
                            <TableCell className="text-right py-2">
                              <span
                                className={`text-xs tabular-nums font-medium ${
                                  stock.changePct >= 0
                                    ? "text-gain"
                                    : "text-loss"
                                }`}
                              >
                                {stock.changePct >= 0 ? "+" : ""}
                                {stock.changePct.toFixed(2)}%
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground py-2">
                              {formatPrice(stock.dma200)}
                            </TableCell>
                            <TableCell className="text-center py-2">
                              <Badge
                                variant={
                                  stock.aboveDma200 ? "default" : "secondary"
                                }
                                className={`text-[10px] ${
                                  stock.aboveDma200
                                    ? "bg-green-500/15 text-gain border-green-500/25"
                                    : "bg-red-500/10 text-loss border-red-500/20"
                                }`}
                              >
                                {stock.aboveDma200 ? "▲ Above" : "▼ Below"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs py-2">
                              {formatPrice(stock.atr5)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs py-2">
                              <span
                                className={
                                  stock.atrPctClose > 3
                                    ? "text-yellow-500 font-medium"
                                    : "text-muted-foreground"
                                }
                              >
                                {stock.atrPctClose.toFixed(1)}%
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground py-2 pr-4">
                              {formatCrore(stock.marketCap)}
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

          {/* RULES TAB */}
          <TabsContent value="rules" className="mt-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Crosshair className="w-4 h-4 text-primary" />
                    Entry Rules
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-3">
                  <RuleItem
                    step={1}
                    title="Universe"
                    desc="NSE stocks with market cap > ₹1,000 Crores"
                  />
                  <RuleItem
                    step={2}
                    title="Uptrend Filter"
                    desc="Close must be above the 200-day moving average"
                  />
                  <RuleItem
                    step={3}
                    title="Dip Trigger"
                    desc="Close drops > 3% compared to prior day's close (signal day)"
                  />
                  <RuleItem
                    step={4}
                    title="Volatility Filter"
                    desc="(100 × ATR(5) / Close) must be > 3 — ensures sufficient volatility"
                  />
                  <RuleItem
                    step={5}
                    title="Limit Order"
                    desc="Next day, place limit buy at Close − 0.9 × ATR(5) to buy even cheaper"
                  />
                  <RuleItem
                    step={6}
                    title="Stock Selection"
                    desc="If multiple signals, prefer highest ATR(5) / Close (setup score)"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" />
                    Exit Rules
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-3">
                  <RuleItem
                    step={1}
                    title="Time-Based Exit"
                    desc="Close any position held for more than 10 trading days"
                  />
                  <RuleItem
                    step={2}
                    title="Price Action Exit"
                    desc="Exit when stock closes above the previous day's high (rebound underway)"
                  />
                  <RuleItem
                    step={3}
                    title="Profit Target"
                    desc="Exit if price hits Entry + 0.5 × ATR(5) — triggered on days after entry"
                  />
                  <div className="pt-2 border-t border-border">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      Exit as soon as any single rule is triggered. The
                      time-based exit is the backstop — most trades should
                      exit via price action or profit target within a few days.
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Activity className="w-4 h-4 text-primary" />
                    Key Indicators Explained
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
                    <IndicatorItem
                      term="200-Day MA"
                      def="Average closing price over the last 200 trading days. Stocks above this are in an uptrend."
                    />
                    <IndicatorItem
                      term="ATR(5)"
                      def="Average True Range over 5 days — measures recent volatility. Higher = more daily price swings."
                    />
                    <IndicatorItem
                      term="ATR% of Close"
                      def="(100 × ATR(5) / Close). Normalised volatility. Must be > 3% to qualify."
                    />
                    <IndicatorItem
                      term="Setup Score"
                      def="ATR(5) / Close × 100. Ranks stocks by volatility — higher scores get priority."
                    />
                    <IndicatorItem
                      term="Limit Buy Price"
                      def="Close − 0.9 × ATR(5). Your limit order price for the next trading day."
                    />
                    <IndicatorItem
                      term="Profit Target"
                      def="Close + 0.5 × ATR(5). Take profit when price reaches this level."
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t border-border mt-8 py-4 text-center">
        <PerplexityAttribution />
      </footer>
    </div>
  );
}

// Sub-components

function KPICard({
  label,
  value,
  icon,
  sub,
  loading,
  highlight,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  sub: string;
  loading: boolean;
  highlight?: boolean;
}) {
  return (
    <Card
      className={highlight ? "border-primary/30 bg-primary/5" : ""}
    >
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] text-muted-foreground font-medium">
            {label}
          </span>
          <span className={highlight ? "text-primary" : "text-muted-foreground/60"}>
            {icon}
          </span>
        </div>
        {loading ? (
          <div className="h-7 w-12 bg-muted animate-pulse rounded" />
        ) : (
          <p
            className={`text-xl font-bold tabular-nums ${
              highlight ? "text-primary" : ""
            }`}
            data-testid={`text-kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {value}
          </p>
        )}
        <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  );
}

function SortableHeader({
  label,
  field,
  current,
  dir,
  onClick,
  align = "left",
  noSort,
}: {
  label: string;
  field: string;
  current: string;
  dir: string;
  onClick: () => void;
  align?: "left" | "right";
  noSort?: boolean;
}) {
  return (
    <TableHead
      className={`text-[11px] whitespace-nowrap ${
        align === "right" ? "text-right" : "text-left"
      } ${!noSort ? "cursor-pointer select-none hover:text-foreground" : ""} ${
        align === "left" ? "pl-4" : "pr-4"
      }`}
      onClick={noSort ? undefined : onClick}
    >
      <div
        className={`flex items-center ${
          align === "right" ? "justify-end" : "justify-start"
        }`}
      >
        {label}
        {!noSort && (
          <>
            {field === current ? (
              dir === "asc" ? (
                <ArrowUp className="w-3 h-3 ml-1 text-primary" />
              ) : (
                <ArrowDown className="w-3 h-3 ml-1 text-primary" />
              )
            ) : (
              <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />
            )}
          </>
        )}
      </div>
    </TableHead>
  );
}

function RuleItem({
  step,
  title,
  desc,
}: {
  step: number;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[11px] font-bold mt-0.5">
        {step}
      </div>
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
          {desc}
        </p>
      </div>
    </div>
  );
}

function IndicatorItem({ term, def }: { term: string; def: string }) {
  return (
    <div>
      <p className="text-xs font-semibold">{term}</p>
      <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
        {def}
      </p>
    </div>
  );
}

function SignalsSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex gap-4">
          <div className="h-4 w-20 bg-muted animate-pulse rounded" />
          <div className="h-4 w-16 bg-muted animate-pulse rounded" />
          <div className="h-4 w-14 bg-muted animate-pulse rounded" />
          <div className="h-4 w-16 bg-muted animate-pulse rounded" />
          <div className="h-4 w-12 bg-muted animate-pulse rounded" />
          <div className="h-4 w-16 bg-muted animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}
