import { createContext, useContext, useState } from "react";

interface StrategyContextType {
  strategyId: string;
  setStrategyId: (id: string) => void;
  strategyName: string;
}

const STRATEGY_NAMES: Record<string, string> = {
  atr_dip_buyer: "ATR Dip Buyer",
  bollinger_bounce: "Bollinger Bounce",
  bollinger_mr: "Bollinger Mean Reversion",
};

const StrategyContext = createContext<StrategyContextType>({
  strategyId: "atr_dip_buyer",
  setStrategyId: () => {},
  strategyName: "ATR Dip Buyer",
});

export function StrategyProvider({ children }: { children: React.ReactNode }) {
  const [strategyId, setStrategyId] = useState("atr_dip_buyer");
  return (
    <StrategyContext.Provider
      value={{
        strategyId,
        setStrategyId,
        strategyName: STRATEGY_NAMES[strategyId] || strategyId,
      }}
    >
      {children}
    </StrategyContext.Provider>
  );
}

export function useStrategy() {
  return useContext(StrategyContext);
}
