import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Loader2 } from "lucide-react";

interface BollingerChartData {
  date: string;
  close: number;
  open: number;
  high: number;
  low: number;
  ma: number;
  upperBand: number;
  lowerBand: number;
  stopBand: number;
}

interface TradeChartResponse {
  data: BollingerChartData[];
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

export default function BollingerTradeChart({ symbol, entryDate, exitDate, entryPrice, exitPrice, exitReason }: Props) {
  const querySymbol = symbol.includes(".NS") ? symbol : `${symbol}.NS`;

  const { data, isLoading, isError } = useQuery<TradeChartResponse>({
    queryKey: ["/api/trade-chart", symbol, entryDate, exitDate],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/trade-chart?symbol=${encodeURIComponent(querySymbol)}&entryDate=${entryDate}&exitDate=${exitDate}`);
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

  // Find min/max for better Y axis domain
  const allValues = chartData.flatMap(d => [d.high, d.low, d.upperBand, d.lowerBand, d.stopBand]);
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const padding = (maxVal - minVal) * 0.05;

  return (
    <div className="px-2 py-3" data-testid={`bollinger-chart-${symbol}`}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 mb-2 px-2">
        <span className="text-xs font-semibold">{symbol} Bollinger Bands</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-3 h-[2px] bg-[#e2e8f0] inline-block rounded" /> Close
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-[2px] bg-yellow-500 inline-block rounded" /> 20-DMA
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-[1px] bg-blue-400 inline-block" style={{ borderTop: "1px dashed #60a5fa" }} /> ±2σ
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-[1px] bg-red-500/50 inline-block" style={{ borderTop: "1px dashed #ef4444" }} /> −3σ
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-3 bg-[#22c55e] inline-block" style={{ borderRight: "2px dashed #22c55e" }} /> Entry
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-3 bg-orange-500 inline-block" style={{ borderRight: "2px dashed #f97316" }} /> Exit
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
          <defs>
            <linearGradient id={`bbFill-${symbol}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.08} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
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
              };
              return [`₹${value.toFixed(2)}`, labels[name] || name];
            }}
          />

          {/* Bollinger Band fill (upper band line with gradient) */}
          <Area
            type="monotone" dataKey="upperBand"
            stroke="transparent" fill={`url(#bbFill-${symbol})`}
            connectNulls isAnimationActive={false}
          />

          {/* Upper band (+2σ) */}
          <Line
            type="monotone" dataKey="upperBand"
            stroke="#60a5fa" strokeWidth={1} strokeDasharray="4 2"
            dot={false} name="upperBand" isAnimationActive={false}
          />

          {/* Lower band (-2σ) */}
          <Line
            type="monotone" dataKey="lowerBand"
            stroke="#60a5fa" strokeWidth={1} strokeDasharray="4 2"
            dot={false} name="lowerBand" isAnimationActive={false}
          />

          {/* Stop band (-3σ) */}
          <Line
            type="monotone" dataKey="stopBand"
            stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3"
            strokeOpacity={0.5} dot={false} name="stopBand" isAnimationActive={false}
          />

          {/* 20-DMA (mean) — golden line */}
          <Line
            type="monotone" dataKey="ma"
            stroke="#eab308" strokeWidth={2}
            dot={false} name="ma" isAnimationActive={false}
          />

          {/* Price line (close) — brighter for visibility */}
          <Line
            type="monotone" dataKey="close"
            stroke="#e2e8f0" strokeWidth={2}
            dot={false} name="close" isAnimationActive={false}
          />

          {/* High/Low in tooltip only */}
          <Line type="monotone" dataKey="high" stroke="transparent" dot={false} name="high" isAnimationActive={false} />
          <Line type="monotone" dataKey="low" stroke="transparent" dot={false} name="low" isAnimationActive={false} />

          {/* Trade holding period shading */}
          <ReferenceArea
            x1={entryDate} x2={exitDate}
            fill="#22c55e" fillOpacity={0.06}
            stroke="#22c55e" strokeOpacity={0.15}
          />

          {/* Entry vertical marker */}
          <ReferenceLine
            x={entryDate} stroke="#22c55e" strokeWidth={2} strokeDasharray="4 3"
            label={{ value: `▲ Entry ₹${entryPrice.toFixed(0)}`, position: "insideBottomRight", fontSize: 10, fill: "#22c55e", fontWeight: 700 }}
          />

          {/* Exit vertical marker */}
          <ReferenceLine
            x={exitDate} stroke="#f97316" strokeWidth={2} strokeDasharray="4 3"
            label={{ value: `▼ Exit ₹${exitPrice.toFixed(0)}`, position: "insideTopRight", fontSize: 10, fill: "#f97316", fontWeight: 700 }}
          />

          {/* Entry price horizontal line */}
          <ReferenceLine
            y={entryPrice} stroke="#22c55e" strokeWidth={1} strokeDasharray="2 4"
            strokeOpacity={0.4}
          />

          {/* Exit price horizontal line */}
          <ReferenceLine
            y={exitPrice} stroke="#f97316" strokeWidth={1} strokeDasharray="2 4"
            strokeOpacity={0.4}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
