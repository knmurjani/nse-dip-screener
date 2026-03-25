/**
 * Strategy Registry — defines all available strategies.
 * Each strategy has its own signal generation logic, entry/exit rules,
 * but shares the same infrastructure (data fetching, portfolio tracking, backtest engine).
 */

export interface StrategyDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  entryRules: string[];
  exitRules: { name: string; description: string }[];
  parameters: Record<string, number>;
}

export const STRATEGIES: Record<string, StrategyDefinition> = {
  atr_dip_buyer: {
    id: "atr_dip_buyer",
    name: "ATR Dip Buyer",
    shortName: "ATR Dip",
    description: "Buy dips in uptrending stocks using ATR-based volatility filters and limit orders. Mean-reversion strategy targeting short-term oversold conditions.",
    entryRules: [
      "Stock must be above 200-day moving average (uptrend filter)",
      "Close drops > 3% from prior day's close (dip trigger)",
      "Volatility filter: (100 × ATR(5) / Close) > 3%",
      "Next day: limit buy at Close − 0.9 × ATR(5)",
      "Rank by setup score: ATR(5) / Close (highest priority)",
    ],
    exitRules: [
      { name: "Profit Target", description: "Entry + 0.5 × ATR(5)" },
      { name: "Price Action", description: "Close > previous day's high (rebound confirmed)" },
      { name: "Time Exit", description: "10 trading days maximum hold" },
    ],
    parameters: {
      dmaLength: 200,
      dipThresholdPct: 3,
      atrPeriod: 5,
      atrPctThreshold: 3,
      limitOrderAtrMultiple: 0.9,
      profitTargetAtrMultiple: 0.5,
      maxHoldDays: 10,
    },
  },

  bollinger_bounce: {
    id: "bollinger_bounce",
    name: "Bollinger Bounce",
    shortName: "Bollinger",
    description: "Configurable Bollinger Band mean-reversion. Set watchlist, entry, profit target, and stop loss conditions using standard deviation bands or the mean.",
    entryRules: [
      "Calculate N-day moving average and standard deviation",
      "Watchlist: stock drops below selected band (configurable: −1σ, −2σ, −3σ, or mean)",
      "Entry: stock crosses above selected level (configurable: −2σ, −1σ, mean, or +1σ)",
      "Position sizing: fixed (Capital / Max Positions)",
    ],
    exitRules: [
      { name: "Profit Target", description: "Configurable: reach mean, +1σ, +2σ, or +3σ" },
      { name: "Absolute Stop", description: "Optional: fixed % loss from entry price" },
      { name: "Trailing Stop", description: "Optional: fixed % drop from peak price" },
      { name: "Time Exit", description: "Optional: max trading days (leave blank for no limit)" },
    ],
    parameters: {
      maPeriod: 20,
      watchlistCondition: "below_-2s",
      entryCondition: "cross_above_-2s",
      exitTarget: "reach_mean",
      maxHoldDays: 0,
    },
  },
};

export function getStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGIES[id];
}

export function getAllStrategies(): StrategyDefinition[] {
  return Object.values(STRATEGIES);
}
