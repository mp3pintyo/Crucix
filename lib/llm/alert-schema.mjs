import { ideaText } from './idea-schema.mjs';

// The JSON shape extractJson accepts for an alert answer: one plain object, so an array or a prose [3] is skipped; the fields
// are checked below (a string "true" is not coerced).
export const alertObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// An unusable model response must take the rule fallback rather than crash delivery.
export function normalizeAlertEvaluation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.shouldAlert !== 'boolean') return null;
  if (!value.shouldAlert) return { shouldAlert: false, reason: ideaText(value.reason, 1800) || 'No qualifying signals.' };
  const tier = ideaText(value.tier, 20).toUpperCase();
  const confidence = ideaText(value.confidence, 20).toUpperCase();
  const headline = ideaText(value.headline, 160);
  const reason = ideaText(value.reason, 1800);
  if (!['FLASH', 'PRIORITY', 'ROUTINE'].includes(tier) || !['HIGH', 'MEDIUM', 'LOW'].includes(confidence) || !headline || !reason) return null;
  return {
    shouldAlert: true, tier, confidence, headline, reason,
    actionable: ideaText(value.actionable, 800) || 'Monitor',
    signals: Array.isArray(value.signals) ? value.signals.map(s => ideaText(s, 240)).filter(Boolean).slice(0, 8) : [],
    crossCorrelation: ideaText(value.crossCorrelation, 400),
  };
}
