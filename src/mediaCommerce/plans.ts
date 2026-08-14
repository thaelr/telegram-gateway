import {
  config,
  type MediaActionPlan,
  type MediaPhotoPlan,
} from "../config.js";
import { normalizeString } from "./utils.js";

export function resolvePhotoPlanByAmount(
  amountXtr: number,
): MediaPhotoPlan {
  const normalizedAmount = Math.max(1, Math.trunc(amountXtr));

  return config.MEDIA_PHOTO_PLANS_JSON.find(
    (plan) => plan.amount_xtr === normalizedAmount,
  ) ?? {
    sku: `payment_media_custom_${normalizedAmount}`,
    amount_xtr: normalizedAmount,
    title: "Payment media",
    description: "Media payment option.",
    label: "Payment media",
    button_text: `Payment media • ${normalizedAmount} Stars`,
  };
}

export function resolveActionPlanByFeatureKey(
  featureKey: string | null | undefined,
): MediaActionPlan | null {
  const normalizedFeatureKey = normalizeString(featureKey);
  if (!normalizedFeatureKey) {
    return null;
  }

  return config.MEDIA_ACTION_PLANS_JSON.find(
    (plan) => normalizeString(plan.feature_key) === normalizedFeatureKey,
  ) ?? null;
}
