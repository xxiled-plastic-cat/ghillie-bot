import type { AlphaBotState, AlphaOrderbook } from "./alphaTypes.js";

export function updateUnrealisedPnl(
  state: AlphaBotState,
  books: Map<number, AlphaOrderbook>,
): void {
  let total = 0;
  for (const position of Object.values(state.positionsByMarket)) {
    const book =
      (position.marketAppId !== undefined ? books.get(position.marketAppId) : undefined) ??
      [...books.values()].find((candidate) => candidate.marketId === position.marketId);
    const yesMark = book?.yesBid ?? book?.yesMid ?? 0;
    const noMark = book?.noBid ?? book?.noMid ?? 0;
    const yesPnl = (yesMark - position.avgYesCost) * position.yesShares;
    const noPnl = (noMark - position.avgNoCost) * position.noShares;
    position.unrealisedPnl = yesPnl + noPnl;
    position.lastMark = Math.max(yesMark, noMark);
    total += position.unrealisedPnl;
  }
  state.unrealisedPnl = total;
  state.totalPnl = state.realisedPnl + state.unrealisedPnl;
}
