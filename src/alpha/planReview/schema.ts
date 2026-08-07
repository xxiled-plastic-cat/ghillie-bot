import { z } from "zod";

export const PLAN_REVIEW_REASON_CODES = [
  "one_sided_entry",
  "stranded_inventory",
  "thin_book",
  "incomplete_data",
  "other",
] as const;

export type PlanReviewReasonCode = (typeof PLAN_REVIEW_REASON_CODES)[number];

export const planReviewDecisionSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["approve", "reject", "shrink"]),
  maxNotionalUsd: z.number().positive().optional(),
  reasons: z.array(z.enum(PLAN_REVIEW_REASON_CODES)).default([]),
});

export const planReviewResponseSchema = z.object({
  decisions: z.array(planReviewDecisionSchema).min(1),
  notes: z.string().optional(),
});

export type PlanReviewDecision = z.infer<typeof planReviewDecisionSchema>;
export type PlanReviewResponse = z.infer<typeof planReviewResponseSchema>;

/** Prefer raw JSON, then fenced ```json, then the outermost `{...}` object. */
export function extractJsonObjectText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return undefined;
}

export function parsePlanReviewResponse(text: string): PlanReviewResponse {
  const candidate = extractJsonObjectText(text);
  if (!candidate) {
    throw new Error("Plan review response contained no JSON object");
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plan review JSON parse failed: ${message}`);
  }
  return planReviewResponseSchema.parse(value);
}
