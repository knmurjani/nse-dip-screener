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
      <div className="flex items-center gap-4 mb-2 px-2">
        <span className="text-[11px] font-semibold">{symbol} Bollinger Bands</span>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-0.5 bg-yellow-500 inline-block rounded" /> 20-DMA
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-0.5 bg-blue-400 inline-block rounded" /> ±2σ
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-0.5 bg-red-500/60 inline-block rounded" style={{ borderBottom: "1px dashed" }} /> −3σ Stop
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-[#22c55e] inline-block rounded-full" /> Entry
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 bg-orange-400 inline-block rounded-full" /> Exit
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
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

          {/* Bollinger Band fill (upper to lower) */}
          <Area
            type="monotone" dataKey="upperBand"
            stroke="transparent" fill={`url(#bbFill-${symbol})`}
            connectNulls
          />

          {/* Upper band */}
          <Line
            type="monotone" dataKey="upperBand"
            stroke="#60a5fa" strokeWidth={1} strokeDasharray="4 2"
            dot={false} name="upperBand"
          />

          {/* Lower band (-2σ) */}
          <Line
            type="monotone" dataKey="lowerBand"
            stroke="#60a5fa" strokeWidth={1} strokeDasharray="4 2"
            dot={false} name="lowerBand"
          />

          {/* Stop band (-3σ) */}
          <Line
            type="monotone" dataKey="stopBand"
            stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3"
            strokeOpacity={0.6} dot={false} name="stopBand"
          />

          {/* 20-DMA (mean) */}
          <Line
            type="monotone" dataKey="ma"
            stroke="#eab308" strokeWidth={1.5}
            dot={false} name="ma"
          />

          {/* Price line (close) */}
          <Line
            type="monotone" dataKey="close"
            stroke="hsl(210, 14%, 70%)" strokeWidth={1.5}
            dot={false} name="close"
          />

          {/* High/Low wicks as thin lines */}
          <Line type="monotone" dataKey="high" stroke="transparent" dot={false} name="high" />
          <Line type="monotone" dataKey="low" stroke="transparent" dot={false} name="low" />

          {/* Entry marker */}
          <ReferenceLine
            x={entryDate} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="3 3"
            label={{ value: `▲ Entry ₹${entryPrice.toFixed(0)}`, position: "insideBottomLeft", fontSize: 9, fill: "#22c55e", fontWeight: 600 }}
          />

          {/* Exit marker */}
          <ReferenceLine
            x={exitDate} stroke="#f97316" strokeWidth={1.5} strokeDasharray="3 3"
            label={{ value: `▼ Exit ₹${exitPrice.toFixed(0)}`, position: "insideTopLeft", fontSize: 9, fill: "#f97316", fontWeight: 600 }}
          />

          {/* Trade holding period shading */}
          <ReferenceArea
            x1={entryDate} x2={exitDate}
            fill="#22c55e" fillOpacity={0.04}
            stroke="transparent"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
