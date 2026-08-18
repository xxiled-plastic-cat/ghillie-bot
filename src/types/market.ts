export type Timeframe = "hourly" | "daily" | "weekly" | "monthly" | "unknown";

export type MarketStatus = "open" | "locked" | "settled" | "expired" | "unknown";

export type Market = {
  id: string;
  underlying: "BTC" | "ETH" | "XAU" | "SPY" | string;
  timeframe: Timeframe;
  strike: number;
  expiryTs: number;
  status: MarketStatus;
  marketGroupId?: string;
  strikeIndex?: number;
  haltTs?: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  oraclePrice?: number;
  raw?: unknown;
};

export type Ladder = {
  underlying: string;
  timeframe: Timeframe;
  expiryTs: number;
  markets: Market[];
};

export type Orderbook = {
  marketId: string;
  books: Array<{
    strikeIndex: number;
    strike: number;
    yesBuys: Array<{ price: number; quantity: number }>;
    yesSells: Array<{ price: number; quantity: number }>;
    noBuys: Array<{ price: number; quantity: number }>;
    noSells: Array<{ price: number; quantity: number }>;
  }>;
};

export type LadderSnapshot = {
  marketId: string;
  underlying: string;
  timeframe: Timeframe;
  expiryTs: number;
  rows: Array<{
    strikeIndex: number;
    strike: number;
    yesBid?: number;
    yesAsk?: number;
    noBid?: number;
    noAsk?: number;
  }>;
  raw?: unknown;
};

export type OraclePrice = {
  underlying: string;
  price: number;
  timestamp: number;
  isStale: boolean;
  raw?: unknown;
};

export type RewardMarket = {
  marketId: string;
  allocation: number;
  activeLps: number;
  baseShare: number;
  bonusShare: number;
  raw?: unknown;
};

export type LadderOpportunity = {
  type: "ladder_inversion";
  underlying: string;
  timeframe: Timeframe;
  expiryTs: number;
  lowerMarketId: string;
  higherMarketId: string;
  lowerStrike: number;
  higherStrike: number;
  lowerYesAsk: number;
  higherYesBid: number;
  edgeBps: number;
  takerAdjustedEdgeBps: number;
};

export type ParityOpportunity = {
  type: "parity";
  kind: "cheap_pair" | "rich_pair";
  marketId: string;
  underlying: string;
  timeframe: Timeframe;
  strike: number;
  expiryTs: number;
  yesPrice: number;
  noPrice: number;
  edgeBps: number;
  takerAdjustedEdgeBps: number;
};

export type MakerCandidate = {
  type: "maker_candidate";
  marketId: string;
  underlying: string;
  timeframe: Timeframe;
  strike: number;
  expiryTs: number;
  yesMid: number;
  spread: number;
  atmWeight: number;
  reason: string;
  score: number;
};

export type LiquiditySignal = {
  type: "liquidity_signal";
  kind: "improve_quote" | "seed_liquidity";
  marketId: string;
  marketGroupId?: string;
  strikeIndex?: number;
  haltTs?: number;
  underlying: string;
  timeframe: Timeframe;
  strike: number;
  expiryTs: number;
  score: number;
  reason: string;
  yesMid: number;
  spread: number;
  rewardAllocation: number;
  haltBufferMinutes: number;
  bookState: "two_sided" | "one_sided" | "empty";
  suggestedYesBid?: number;
  suggestedYesAsk?: number;
  suggestedNoBid?: number;
  suggestedNoAsk?: number;
};
