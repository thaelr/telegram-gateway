import {
  config,
  type MediaActionPlan,
  type MediaPromotion,
  type MediaPhotoPlan,
  type MediaSubscriptionPlan,
} from "../config.js";
import { normalizeString } from "./utils.js";

type InvoicePlan = {
  sku: string;
  amount_xtr: number;
  title: string;
  description: string;
  label: string;
  button_text: string;
};

export type PromotedInvoicePlan<T extends InvoicePlan> = T & {
  original_amount_xtr: number;
  final_amount_xtr: number;
  promo_key: string | null;
  promo_active: boolean;
};

function isPromotionActive(promotion: MediaPromotion, nowMs: number): boolean {
  const startsAt = Date.parse(promotion.starts_at);
  const endsAt = Date.parse(promotion.ends_at);

  return Number.isFinite(startsAt)
    && Number.isFinite(endsAt)
    && startsAt <= nowMs
    && nowMs <= endsAt;
}

function resolvePromotionAmountForSku(
  promotion: MediaPromotion,
  normalizedSku: string,
): number | null {
  const item = promotion.items.find(
    (entry) => normalizeString(entry.sku)?.toLowerCase() === normalizedSku,
  );

  return item ? Math.max(1, Math.trunc(item.promo_amount_xtr)) : null;
}

export function resolvePromotionForSku(
  sku: string,
  promotions: MediaPromotion[] = config.MEDIA_PROMOTIONS_JSON,
  nowMs: number = Date.now(),
): { promo_key: string; promo_amount_xtr: number } | null {
  const normalizedSku = normalizeString(sku)?.toLowerCase();
  if (!normalizedSku) {
    return null;
  }

  let matchedPromotion: { promo_key: string; promo_amount_xtr: number } | null = null;

  for (const promotion of promotions) {
    if (!isPromotionActive(promotion, nowMs)) {
      continue;
    }
    const promoAmount = resolvePromotionAmountForSku(promotion, normalizedSku);
    if (promoAmount != null) {
      matchedPromotion = {
        promo_key: promotion.promo_key,
        promo_amount_xtr: promoAmount,
      };
    }
  }

  return matchedPromotion;
}

export function applyPromotionToPlan<T extends InvoicePlan>(
  plan: T,
  promotions: MediaPromotion[] = config.MEDIA_PROMOTIONS_JSON,
  nowMs: number = Date.now(),
): PromotedInvoicePlan<T> {
  const originalAmount = Math.max(1, Math.trunc(plan.amount_xtr));
  const promotion = resolvePromotionForSku(plan.sku, promotions, nowMs);
  const finalAmount = promotion?.promo_amount_xtr ?? originalAmount;

  return {
    ...plan,
    amount_xtr: finalAmount,
    original_amount_xtr: originalAmount,
    final_amount_xtr: finalAmount,
    promo_key: promotion?.promo_key ?? null,
    promo_active: promotion != null,
  };
}

export function resolvePhotoPlanByAmount(
  amountXtr: number,
): PromotedInvoicePlan<MediaPhotoPlan> {
  const normalizedAmount = Math.max(1, Math.trunc(amountXtr));

  const plan = config.MEDIA_PHOTO_PLANS_JSON.find(
    (plan) => plan.amount_xtr === normalizedAmount,
  ) ?? {
    sku: `payment_media_custom_${normalizedAmount}`,
    amount_xtr: normalizedAmount,
    title: "Payment media",
    description: "Media payment option.",
    label: "Payment media",
    button_text: `Получить фото • ${normalizedAmount} ⭐`,
  };

  return applyPromotionToPlan(plan);
}

export function resolveSubscriptionPlans(): Array<PromotedInvoicePlan<MediaSubscriptionPlan>> {
  return config.MEDIA_SUBSCRIPTION_PLANS_JSON.map((plan) => applyPromotionToPlan(plan));
}

export function resolveActionPlanByFeatureKey(
  featureKey: string | null | undefined,
): PromotedInvoicePlan<MediaActionPlan> | null {
  const normalizedFeatureKey = normalizeString(featureKey);
  if (!normalizedFeatureKey) {
    return null;
  }

  const plan = config.MEDIA_ACTION_PLANS_JSON.find(
    (plan) => normalizeString(plan.feature_key) === normalizedFeatureKey,
  ) ?? null;

  return plan ? applyPromotionToPlan(plan) : null;
}
