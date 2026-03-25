import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, ReferenceDot,
} from "recharts";
import { Loader2 } from "lucide-react";

interface ChartData {
  date: string;
  close: number;
  open: number;
  high: number;
  low: number;
  ma: number;
  upperBand: number;
  lowerBand: number;
  stopBand: number;
  dma?: number;
}

interface TradeChartResponse {
  data: ChartData[];
  entryDate: string;
  exitDate: string;
  symbol: string;
}

interface Props {
  symbol: string;       // e.g. "RELIANCE" (without .NS)
  entryDate: string;    // YYYY-MM-DD
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  strategyId?: string;  // "atr_dip_buyer" | "bollinger_bounce" etc.
  dmaLength?: number;   // for ATR charts (e.g. 200)
}

function formatChartDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

// Custom candlestick dot renderer for the close line
function CandleDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload || !cx || !cy) return null;
  const isUp = payload.close >= payload.open;
  const color = isUp ? "#22c55e" : "#ef4444";
  // Draw a small bar from low to high with body from open to close
  const scaleY = props.yAxis?.scale;
  if (!scaleY) return null;

  const highY = scaleY(payload.high);
  const lowY = scaleY(payload.low);
  const openY = scaleY(payload.open);
  const closeY = scaleY(payload.close);
  const bodyTop = Math.min(openY, closeY);
  const bodyBottom = Math.max(openY, closeY);
  const bodyHeight = Math.max(bodyBottom - bodyTop, 1);

  return (
    <g>
      {/* Wick */}
      <line x1={cx} y1={highY} x2={cx} y2={lowY} stroke={color} strokeWidth={1} />
      {/* Body */}
      <rect
        x={cx - 3} y={bodyTop} width={6} height={bodyHeight}
        fill={isUp ? color : color} stroke={color} strokeWidth={0.5}
        opacity={isUp ? 0.8 : 1}
      />
    </g>
  );
}

/* ── Custom SVG label for entry/exit markers ── */
function MarkerLabel({ viewBox, label, color }: { viewBox?: any; label: string; color: string }) {
  if (!viewBox) return null;
  const { x, y } = viewBox;
  return (
    <text
      x={x}
      y={y - 14}
      textAnchor="middle"
      fill={color}
      fontSize={9}
      fontWeight={700}
      style={{ textShadow: "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8)" }}
    >
      {label}
    </text>
  );
}

/* ── Upward triangle shape for entry ── */
function EntryTriangle(props: any) {
  const { cx, cy } = props;
  if (!cx || !cy) return null;
  const size = 7;
  const points = `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`;
  return (
    <polygon
      points={points}
      fill="#22c55e"
      stroke="#fff"
      strokeWidth={0.8}
      style={{ filter: "drop-shadow(0 0 3px rgba(34,197,94,0.6))" }}
    />
  );
}

/* ── Downward triangle shape for exit ── */
function ExitTriangle({ cx, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (!cx || !cy) return null;
  const size = 7;
  const points = `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
  return (
    <polygon
      points={points}
      fill={color}
      stroke="#fff"
      strokeWidth={0.8}
      style={{ filter: `drop-shadow(0 0 3px ${color}88)` }}
    />
  );
}

export default function BollingerTradeChart({ symbol, entryDate, exitDate, entryPrice, exitPrice, exitReason, strategyId, dmaLength }: Props) {
  const querySymbol = symbol.includes(".NS") ? symbol : `${symbol}.NS`;
  const isATR = strategyId === "atr_dip_buyer";
  const dmaParam = isATR ? (dmaLength || 200) : 0;

  const { data, isLoading, isError } = useQuery<TradeChartResponse>({
    queryKey: ["/api/trade-chart", symbol, entryDate, exitDate, dmaParam],
    queryFn: async () => {
      let url = `/api/trade-chart?symbol=${encodeURIComponent(querySymbol)}&entryDate=${entryDate}&exitDate=${exitDate}`;
      if (dmaParam > 0) url += `&dmaLength=${dmaParam}`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    staleTime: Infinity, // chart data won't change
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[200px] text-muted-foreground text-xs gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading chart for {symbol}...
      </div>
    );
  }

  if (isError || !data?.data || data.data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[140px] text-muted-foreground text-xs">
        No chart data available for {symbol}
      </div>
    );
  }

  const chartData = data.data;
  const hasDMA = chartData.some(d => d.dma !== undefined);

  // Find the closest date in chart data to entry/exit dates for marker placement
  const findClosestDate = (targetDate: string): string | null => {
    // Exact match first
    const exact = chartData.find(d => d.date === targetDate);
    if (exact) return exact.date;
    // Find closest date
    let closest: string | null = null;
    let minDiff = Infinity;
    for (const d of chartData) {
      const diff = Math.abs(new Date(d.date).getTime() - new Date(targetDate).getTime());
      if (diff < minDiff) {
        minDiff = diff;
        closest = d.date;
      }
    }
    return closest;
  };

  const entryChartDate = findClosestDate(entryDate);
  const exitChartDate = findClosestDate(exitDate);
  const isLoss = exitPrice < entryPrice;
  const exitColor = isLoss ? "#ef4444" : "#f59e0b";
  const exitLabel = isLoss ? `STOP ₹${exitPrice.toFixed(0)}` : `SELL ₹${exitPrice.toFixed(0)}`;
  const entryLabel = `BUY ₹${entryPrice.toFixed(0)}`;

  // Find min/max for better Y axis domain (include entry/exit prices)
  const allValues = chartData.flatMap(d => {
    const vals = [d.high, d.low];
    if (!isATR) { vals.push(d.upperBand, d.lowerBand, d.stopBand); }
    if (d.dma) vals.push(d.dma);
    return vals;
  });
  allValues.push(entryPrice, exitPrice);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const padding = (maxVal - minVal) * 0.08; // extra padding for marker labels

  return (
    <div className="px-2 py-3" data-testid={`trade-chart-${symbol}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mb-2 px-2">
        <span className="text-xs font-semibold">{symbol} {isATR ? "Price & DMA" : "Bollinger Bands"}</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-3 h-[2px] bg-[#ffffff] inline-block rounded" /> Close
          </span>
          {hasDMA && (
            <span className="flex items-center gap-1">
              <span className="w-3 h-[2px] bg-[#f59e0b] inline-block rounded" /> {dmaParam || 200}-DMA
            </span>
          )}
          {!isATR && (
            <>
              <span className="flex items-center gap-1">
                <span className="w-3 h-[2px] bg-[#60a5fa] inline-block rounded" /> 20-DMA
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-[1px] inline-block" style={{ borderTop: "1px dashed #22c55e" }} /> +2σ
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-[1px] inline-block" style={{ borderTop: "1px dashed #f87171" }} /> −2σ
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-[1px] inline-block" style={{ borderTop: "1px dashed #dc2626" }} /> −3σ
              </span>
            </>
          )}
          <span className="flex items-center gap-1">
            <span className="text-[#22c55e] text-[9px]">▲</span> Entry
          </span>
          <span className="flex items-center gap-1">
            <span style={{ color: exitColor }} className="text-[9px]">▼</span> Exit
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
          <defs>
            <linearGradient id={`bbFill-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#9ca3af" stopOpacity={0.08} />
              <stop offset="100%" stopColor="#9ca3af" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 12%, 18%)" />
          <XAxis
            dataKey="date" tick={{ fontSize: 9 }} tickFormatter={formatChartDate}
            stroke="hsl(215, 10%, 35%)" interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 9 }} stroke="hsl(215, 10%, 35%)"
            domain={[minVal - padding, maxVal + padding]}
            tickFormatter={(v) => `₹${v.toFixed(0)}`}
          />
          <RTooltip
            contentStyle={{
              background: "hsl(222, 18%, 12%)", border: "1px solid hsl(220, 12%, 22%)",
              borderRadius: "6px", fontSize: "10px", padding: "6px 10px",
            }}
            labelFormatter={formatChartDate}
            formatter={(value: number, name: string) => {
              const labels: Record<string, string> = {
                close: "Close", ma: "20-DMA", upperBand: "+2σ",
                lowerBand: "−2σ", stopBand: "−3σ Stop", high: "High", low: "Low",
                dma: `${dmaParam || 200}-DMA`,
              };
              return [`₹${value.toFixed(2)}`, labels[name] || name];
            }}
          />

          {/* Bollinger Band lines — only for non-ATR strategies */}
          {!isATR && (
            <>
              {/* Bollinger Band fill (upper band line with gradient) */}
              <Area
                type="monotone" dataKey="upperBand"
                stroke="transparent" fill={`url(#bbFill-${symbol})`}
                connectNulls isAnimationActive={false}
              />

              {/* Upper band (+2σ) */}
              <Line
                type="monotone" dataKey="upperBand"
                stroke="#22c55e" strokeWidth={1} strokeDasharray="4 2"
                dot={false} name="upperBand" isAnimationActive={false}
              />

              {/* Lower band (-2σ) */}
              <Line
                type="monotone" dataKey="lowerBand"
                stroke="#f87171" strokeWidth={1} strokeDasharray="4 2"
                dot={false} name="lowerBand" isAnimationActive={false}
              />

              {/* Stop band (-3σ) */}
              <Line
                type="monotone" dataKey="stopBand"
                stroke="#dc2626" strokeWidth={1} strokeDasharray="3 3"
                dot={false} name="stopBand" isAnimationActive={false}
              />

              {/* 20-DMA (mean) — blue */}
              <Line
                type="monotone" dataKey="ma"
                stroke="#60a5fa" strokeWidth={1.5}
                dot={false} name="ma" isAnimationActive={false}
              />
            </>
          )}

          {/* N-DMA line (for ATR trades) */}
          {hasDMA && (
            <Line
              type="monotone" dataKey="dma"
              stroke="#f59e0b" strokeWidth={2}
              dot={false} name="dma" isAnimationActive={false}
            />
          )}

          {/* Price line (close) — pure white */}
          <Line
            type="monotone" dataKey="close"
            stroke="#ffffff" strokeWidth={2}
            dot={false} name="close" isAnimationActive={false}
          />

          {/* High/Low in tooltip only */}
          <Line type="monotone" dataKey="high" stroke="transparent" dot={false} name="high" isAnimationActive={false} />
          <Line type="monotone" dataKey="low" stroke="transparent" dot={false} name="low" isAnimationActive={false} />

          {/* Entry marker — green upward triangle */}
          {entryChartDate && (
            <ReferenceDot
              x={entryChartDate}
              y={entryPrice}
              r={0}
              shape={<EntryTriangle />}
              isFront
              label={<MarkerLabel label={entryLabel} color="#22c55e" />}
            />
          )}

          {/* Exit marker — red/gold downward triangle */}
          {exitChartDate && (
            <ReferenceDot
              x={exitChartDate}
              y={exitPrice}
              r={0}
              shape={<ExitTriangle color={exitColor} />}
              isFront
              label={<MarkerLabel label={exitLabel} color={exitColor} />}
            />
          )}

        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
