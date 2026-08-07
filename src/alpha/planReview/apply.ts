import { roundShares } from "../alphaClient.js";
import type { AlphaQuote } from "../alphaTypes.js";
import { entryReviewId } from "./payload.js";
import type { PlanReviewDecision, PlanReviewReasonCode, PlanReviewResponse } from "./schema.js";

/** Skip messages emitted by plan review (compatible with liveTrader LiveAction). */
export type PlanReviewSkipAction = {
  kind: "skip";
  message: string;
};

export type ApplyPlanReviewResult = {
  /** Placement queue with rejected entries removed and shrinks applied. */
  placementQueue: AlphaQuote[];
  actions: PlanReviewSkipAction[];
};

function formatReasons(reasons: PlanReviewReasonCode[]): string {
  return reasons.length > 0 ? reasons.join(",") : "other";
}

function shrinkQuote(quote: AlphaQuote, maxNotionalUsd: number): AlphaQuote | undefined {
  if (!(maxNotionalUsd > 0) || quote.price <= 0 || quote.price >= 1) return undefined;
  const notionalUsd = Math.min(quote.notionalUsd, maxNotionalUsd);
  if (notionalUsd <= 0 || notionalUsd + 1e-9 < quote.notionalUsd * 0.01) return undefined;
  const sizeShares = roundShares(notionalUsd / quote.price);
  if (sizeShares <= 0) return undefined;
  return {
    ...quote,
    sizeShares,
    notionalUsd: quote.price * sizeShares,
    reason: `${quote.reason}; plan-review shrink to $${(quote.price * sizeShares).toFixed(2)}`,
  };
}

/**
 * Apply model decisions to entry quotes. Missing / invalid decisions fail closed
 * (drop that entry). Non-entry quotes (inventory exits) pass through unchanged.
 */
export function applyPlanReviewDecisions(input: {
  placementQueue: AlphaQuote[];
  entryQuotes: AlphaQuote[];
  response: PlanReviewResponse | undefined;
  failReason?: string;
}): ApplyPlanReviewResult {
  const actions: PlanReviewSkipAction[] = [];
  const entryIds = input.entryQuotes.map((quote, index) => entryReviewId(quote, index));
  const entryById = new Map(entryIds.map((id, index) => [id, input.entryQuotes[index]!]));

  if (!input.response) {
    const reason = input.failReason ?? "plan review unavailable";
    for (const quote of input.entryQuotes) {
      actions.push({
        kind: "skip",
        message: `Plan review dropped ${quote.title} ${quote.outcome} ${quote.source}: ${reason}`,
      });
    }
    return {
      placementQueue: input.placementQueue.filter((quote) => quote.source === "inventory_exit"),
      actions,
    };
  }

  const decisionById = new Map<string, PlanReviewDecision>();
  for (const decision of input.response.decisions) {
    if (!entryById.has(decision.id)) continue;
    if (decisionById.has(decision.id)) continue;
    decisionById.set(decision.id, decision);
  }

  const keptEntries = new Map<string, AlphaQuote>();
  for (const [id, quote] of entryById) {
    const decision = decisionById.get(id);
    if (!decision) {
      actions.push({
        kind: "skip",
        message: `Plan review dropped ${quote.title} ${quote.outcome} ${quote.source}: missing decision (fail closed)`,
      });
      continue;
    }
    if (decision.action === "approve") {
      keptEntries.set(id, quote);
      actions.push({
        kind: "skip",
        message: `Plan review approved ${quote.title} ${quote.outcome} ${quote.source}`,
      });
      continue;
    }
    if (decision.action === "reject") {
      actions.push({
        kind: "skip",
        message: `Plan review rejected ${quote.title} ${quote.outcome} ${quote.source}: ${formatReasons(decision.reasons)}`,
      });
      continue;
    }
    // shrink
    if (decision.maxNotionalUsd === undefined || !(decision.maxNotionalUsd > 0)) {
      actions.push({
        kind: "skip",
        message: `Plan review dropped ${quote.title} ${quote.outcome} ${quote.source}: shrink missing maxNotionalUsd (fail closed)`,
      });
      continue;
    }
    const shrunk = shrinkQuote(quote, decision.maxNotionalUsd);
    if (!shrunk) {
      actions.push({
        kind: "skip",
        message: `Plan review dropped ${quote.title} ${quote.outcome} ${quote.source}: shrink invalid (fail closed)`,
      });
      continue;
    }
    keptEntries.set(id, shrunk);
    actions.push({
      kind: "skip",
      message: `Plan review shrunk ${quote.title} ${quote.outcome} ${quote.source} to $${shrunk.notionalUsd.toFixed(2)} (${formatReasons(decision.reasons)})`,
    });
  }

  if (input.response.notes?.trim()) {
    actions.push({ kind: "skip", message: `Plan review notes: ${input.response.notes.trim()}` });
  }

  // Preserve original placement order: exits and surviving entries interleaved as before.
  let entryIndex = 0;
  const placementQueue: AlphaQuote[] = [];
  for (const quote of input.placementQueue) {
    if (quote.source === "inventory_exit") {
      placementQueue.push(quote);
      continue;
    }
    const id = entryReviewId(quote, entryIndex);
    entryIndex += 1;
    const kept = keptEntries.get(id);
    if (kept) placementQueue.push(kept);
  }

  return { placementQueue, actions };
}
