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
    shortName: "Boll Bounce",
    description: "Mean-reversion using Bollinger Bands. Watchlist when price drops below −2σ, buy when it crosses back above. Exit at mean or stop at −3σ.",
    entryRules: [
      "Calculate 20-day moving average and standard deviation",
      "Watchlist: stock drops below −2σ band (lower Bollinger Band)",
      "Entry signal: stock crosses back above −2σ on the way back up",
      "Rank by distance below mean (deeper dip = higher conviction)",
    ],
    exitRules: [
      { name: "Mean Reversion Target", description: "Price reaches the 20-day moving average (mean)" },
      { name: "Stop Loss", description: "Price drops to −3σ (extreme deviation, cut loss)" },
      { name: "Time Exit", description: "10 trading days maximum hold" },
    ],
    parameters: {
      maPeriod: 20,
      entryBandSigma: 2,
      stopLossSigma: 3,
      maxHoldDays: 10,
    },
  },
};

export function getStrategy(id: string): StrategyDefinition | undefined {
  return STRATEGIES[id];
}

export function getAllStrategies(): StrategyDefinition[] {
  return Object.values(STRATEGIES);
}
