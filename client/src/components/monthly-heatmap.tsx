import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarDays } from "lucide-react";

// ─── Types ───

interface Snapshot {
  date: string;
  // Backtest format
  portfolioValue?: number;
  niftyClose?: number;
  niftyPct?: number;
  equityPct?: number;
  // Deployment format
  portfolio_value?: number;
  nifty_close?: number | null;
  nifty_return_pct?: number | null;
  return_pct?: number;
}

export interface MonthlyHeatmapProps {
  snapshots: Snapshot[];
  initialCapital: number;
  title?: string;
  showBenchmark?: boolean;
  showExcess?: boolean;
}

interface MonthlyReturn {
  year: number;
  month: number; // 0-11
  returnPct: number;
}

interface MonthlyGrid {
  [year: number]: { [month: number]: number; annual: number };
}

// ─── Constants ───

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Calculation Helpers ───

function getPortfolioValue(s: Snapshot): number {
  return s.portfolioValue ?? s.portfolio_value ?? 0;
}

function getNiftyClose(s: Snapshot): number {
  return s.niftyClose ?? s.nifty_close ?? 0;
}

function computeMonthlyReturns(
  snapshots: Snapshot[],
  initialCapital: number,
  getValue: (s: Snapshot) => number,
  initialValue?: number,
): MonthlyReturn[] {
  if (snapshots.length === 0) return [];

  // Group snapshots by YYYY-MM, keeping last snapshot per month
  const byMonth = new Map<string, { year: number; month: number; value: number }>();
  for (const s of snapshots) {
    const d = new Date(s.date);
    const year = d.getFullYear();
    const month = d.getMonth();
    const key = `${year}-${month}`;
    const val = getValue(s);
    if (val > 0) {
      byMonth.set(key, { year, month, value: val });
    }
  }

  // Sort by date
  const sorted = Array.from(byMonth.values()).sort(
    (a, b) => a.year * 12 + a.month - (b.year * 12 + b.month),
  );

  const results: MonthlyReturn[] = [];
  let prevValue = initialValue ?? initialCapital;

  for (const entry of sorted) {
    if (prevValue > 0 && entry.value > 0) {
      const ret = ((entry.value / prevValue) - 1) * 100;
      results.push({ year: entry.year, month: entry.month, returnPct: ret });
    }
    prevValue = entry.value;
  }

  return results;
}

function buildGrid(returns: MonthlyReturn[]): MonthlyGrid {
  const grid: MonthlyGrid = {};
  for (const r of returns) {
    if (!grid[r.year]) {
      grid[r.year] = { annual: 0 } as any;
    }
    grid[r.year][r.month] = r.returnPct;
  }

  // Compute annual returns (compounded from monthly)
  for (const year of Object.keys(grid).map(Number)) {
    let compounded = 1;
    let hasData = false;
    for (let m = 0; m < 12; m++) {
      if (grid[year][m] !== undefined) {
        compounded *= 1 + grid[year][m] / 100;
        hasData = true;
      }
    }
    grid[year].annual = hasData ? (compounded - 1) * 100 : 0;
  }

  return grid;
}

function computeExcessGrid(strategyGrid: MonthlyGrid, benchmarkGrid: MonthlyGrid): MonthlyGrid {
  const grid: MonthlyGrid = {};
  const allYears = new Set([...Object.keys(strategyGrid).map(Number), ...Object.keys(benchmarkGrid).map(Number)]);

  for (const year of allYears) {
    grid[year] = { annual: 0 } as any;
    for (let m = 0; m < 12; m++) {
      const sv = strategyGrid[year]?.[m];
      const bv = benchmarkGrid[year]?.[m];
      if (sv !== undefined && bv !== undefined) {
        grid[year][m] = sv - bv;
      }
    }
    // Excess annual
    const sa = strategyGrid[year]?.annual;
    const ba = benchmarkGrid[year]?.annual;
    if (sa !== undefined && ba !== undefined) {
      grid[year].annual = sa - ba;
    }
  }

  return grid;
}

// ─── Heatmap Color ───

function heatmapBg(value: number | undefined): string {
  if (value === undefined) return "bg-muted/20";
  if (value > 5) return "bg-[rgba(34,197,94,0.30)]";
  if (value > 2) return "bg-[rgba(34,197,94,0.18)]";
  if (value > 0) return "bg-[rgba(34,197,94,0.08)]";
  if (value > -2) return "bg-[rgba(239,68,68,0.08)]";
  if (value > -5) return "bg-[rgba(239,68,68,0.18)]";
  return "bg-[rgba(239,68,68,0.30)]";
}

function textColor(value: number | undefined): string {
  if (value === undefined) return "text-muted-foreground/30";
  if (value > 0) return "text-[#22c55e]";
  if (value < 0) return "text-[#ef4444]";
  return "text-muted-foreground";
}

function fmtPct(value: number | undefined): string {
  if (value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

// ─── Stats Helpers ───

export interface MonthlyStats {
  winRate: number;
  bestMonth: { value: number; label: string };
  worstMonth: { value: number; label: string };
  totalMonths: number;
  positiveMonths: number;
}

export function computeMonthlyStats(returns: MonthlyReturn[]): MonthlyStats {
  if (returns.length === 0) {
    return {
      winRate: 0,
      bestMonth: { value: 0, label: "—" },
      worstMonth: { value: 0, label: "—" },
      totalMonths: 0,
      positiveMonths: 0,
    };
  }

  const positiveMonths = returns.filter(r => r.returnPct > 0).length;
  const winRate = (positiveMonths / returns.length) * 100;

  let best = returns[0];
  let worst = returns[0];
  for (const r of returns) {
    if (r.returnPct > best.returnPct) best = r;
    if (r.returnPct < worst.returnPct) worst = r;
  }

  return {
    winRate,
    bestMonth: { value: best.returnPct, label: `${MONTHS[best.month]} ${best.year}` },
    worstMonth: { value: worst.returnPct, label: `${MONTHS[worst.month]} ${worst.year}` },
    totalMonths: returns.length,
    positiveMonths,
  };
}

// ─── Exported computation function (used by backtest-tab for KPIs) ───

export function computeAllMonthlyData(snapshots: Snapshot[], initialCapital: number) {
  const strategyReturns = computeMonthlyReturns(snapshots, initialCapital, getPortfolioValue);
  const niftyFirstSnapshot = snapshots.find(s => getNiftyClose(s) > 0);
  const niftyInitial = niftyFirstSnapshot ? getNiftyClose(niftyFirstSnapshot) : 0;
  const benchmarkReturns = niftyInitial > 0
    ? computeMonthlyReturns(snapshots, initialCapital, getNiftyClose, niftyInitial)
    : [];

  return {
    strategyReturns,
    benchmarkReturns,
    strategyStats: computeMonthlyStats(strategyReturns),
    benchmarkStats: computeMonthlyStats(benchmarkReturns),
  };
}

// ─── Sub-components ───

function HeatmapTable({ grid, label }: { grid: MonthlyGrid; label: string }) {
  const years = Object.keys(grid).map(Number).sort();
  if (years.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] tabular-nums border-collapse">
          <thead>
            <tr>
              <th className="text-left text-[10px] text-muted-foreground font-medium px-1.5 py-1 w-12">Year</th>
              {MONTHS.map(m => (
                <th key={m} className="text-right text-[10px] text-muted-foreground font-medium px-1.5 py-1 w-[60px]">{m}</th>
              ))}
              <th className="text-right text-[10px] text-muted-foreground font-bold px-1.5 py-1 w-[70px] border-l border-border">Annual</th>
            </tr>
          </thead>
          <tbody>
            {years.map(year => (
              <tr key={year} className="border-t border-border/30">
                <td className="text-left text-[11px] font-semibold text-foreground px-1.5 py-1">{year}</td>
                {Array.from({ length: 12 }, (_, m) => {
                  const val = grid[year]?.[m];
                  return (
                    <td
                      key={m}
                      className={`text-right px-1.5 py-1 ${heatmapBg(val)} ${textColor(val)} rounded-sm`}
                    >
                      {fmtPct(val)}
                    </td>
                  );
                })}
                <td
                  className={`text-right px-1.5 py-1 font-bold border-l border-border ${heatmapBg(grid[year]?.annual)} ${textColor(grid[year]?.annual)}`}
                >
                  {fmtPct(grid[year]?.annual)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatsRow({ stats, label }: { stats: MonthlyStats; label: string }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{label} Win Rate:</span>
        <span className={`font-bold tabular-nums ${stats.winRate >= 50 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
          {stats.winRate.toFixed(1)}%
        </span>
        <span className="text-muted-foreground/60">({stats.positiveMonths}/{stats.totalMonths})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Best:</span>
        <span className="font-bold tabular-nums text-[#22c55e]">
          +{stats.bestMonth.value.toFixed(1)}%
        </span>
        <span className="text-muted-foreground/60">({stats.bestMonth.label})</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Worst:</span>
        <span className="font-bold tabular-nums text-[#ef4444]">
          {stats.worstMonth.value.toFixed(1)}%
        </span>
        <span className="text-muted-foreground/60">({stats.worstMonth.label})</span>
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function MonthlyHeatmap({
  snapshots,
  initialCapital,
  title = "Monthly Returns Heatmap",
  showBenchmark = true,
  showExcess = true,
}: MonthlyHeatmapProps) {
  const {
    strategyGrid,
    benchmarkGrid,
    excessGrid,
    strategyStats,
    benchmarkStats,
    hasBenchmark,
  } = useMemo(() => {
    const strategyReturns = computeMonthlyReturns(snapshots, initialCapital, getPortfolioValue);
    const sGrid = buildGrid(strategyReturns);
    const sStats = computeMonthlyStats(strategyReturns);

    // Benchmark: use niftyClose values
    const niftyFirstSnapshot = snapshots.find(s => getNiftyClose(s) > 0);
    const niftyInitial = niftyFirstSnapshot ? getNiftyClose(niftyFirstSnapshot) : 0;
    const benchReturns = niftyInitial > 0
      ? computeMonthlyReturns(snapshots, initialCapital, getNiftyClose, niftyInitial)
      : [];
    const bGrid = buildGrid(benchReturns);
    const bStats = computeMonthlyStats(benchReturns);

    const eGrid = benchReturns.length > 0 ? computeExcessGrid(sGrid, bGrid) : {};

    return {
      strategyGrid: sGrid,
      benchmarkGrid: bGrid,
      excessGrid: eGrid,
      strategyStats: sStats,
      benchmarkStats: bStats,
      hasBenchmark: benchReturns.length > 0,
    };
  }, [snapshots, initialCapital]);

  if (snapshots.length === 0) return null;

  const showBench = showBenchmark && hasBenchmark;
  const showExc = showExcess && hasBenchmark;

  return (
    <Card data-testid="monthly-heatmap">
      <CardHeader className="py-2 px-4">
        <CardTitle className="text-xs font-semibold flex items-center gap-2">
          <CalendarDays className="w-3.5 h-3.5 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-4">
        {/* Strategy Monthly Returns */}
        <div className="space-y-2">
          <HeatmapTable grid={strategyGrid} label="Strategy Monthly Returns" />
          <StatsRow stats={strategyStats} label="Monthly" />
        </div>

        {/* Nifty 50 Benchmark */}
        {showBench && (
          <div className="space-y-2 pt-2 border-t border-border">
            <HeatmapTable grid={benchmarkGrid} label="Nifty 50 Monthly Returns" />
            <StatsRow stats={benchmarkStats} label="Nifty" />
          </div>
        )}

        {/* Excess Returns */}
        {showExc && (
          <div className="space-y-2 pt-2 border-t border-border">
            <HeatmapTable grid={excessGrid} label="Excess Returns (Strategy − Nifty)" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
