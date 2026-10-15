export const policyVersion = "operator-feedback-v3";

export function validateReviewPolicy(review) {
  if (review.policyVersion !== policyVersion) throw new Error("Read the current action inclusion policy before review");
  const keys = new Set();
  for (const action of review.actions) {
    const resolution = action.ownerResolution;
    if (!resolution || !["explicit_assignment", "accepted_commitment", "platform_operator", "unknown"].includes(resolution.basis)
      || typeof resolution.reason !== "string" || !resolution.reason.trim() || !Array.isArray(resolution.evidenceIds)
      || (resolution.basis === "unknown" ? action.owner !== null : typeof action.owner !== "string" || !action.owner.trim() || !resolution.evidenceIds.length)) {
      throw new Error("Owner requires a contextual operations-owner resolution");
    }
    if (!["explicit_request", "new_assignment", "exception_followup"].includes(action.intent)
      || !["platform_operations", "merchant_material_dependency"].includes(action.scope)
      || [action.reason, action.platformReason, action.taskKey].some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Action requires eligible intent, scope and contextual justification");
    }
    if (!["explicit_pending", "future_commitment", "unresolved_exception"].includes(action.pendingBasis)
      || !["explicit_context", "user_correction"].includes(action.platformBasis)
      || !Array.isArray(action.triggerEvidenceIds) || !action.triggerEvidenceIds.length
      || action.triggerEvidenceIds.some(id => !action.evidenceIds?.includes(id))
      || (action.platformBasis === "user_correction" && (typeof action.feedbackRef !== "string" || !action.feedbackRef.trim()))) {
      throw new Error("Action requires a pending-work trigger and grounded platform basis");
    }
    const key = JSON.stringify([action.groupId, action.platform, action.taskKey.trim().normalize("NFKC").toLowerCase()]);
    if (keys.has(key)) throw new Error("Merge evidence for duplicate pending actions");
    keys.add(key);
  }
}
