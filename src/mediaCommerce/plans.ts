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
  amount_rub?: number | null;
  title: string;
  description: string;
  label: string;
  button_text: string;
};

export type PromotedInvoicePlan<T extends InvoicePlan> = T & {
  original_amount_xtr: number;
  final_amount_xtr: number;
  original_amount_rub: number | null;
  final_amount_rub: number | null;
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
): { amount_xtr: number; amount_rub: number | null } | null {
  const item = promotion.items.find(
    (entry) => normalizeString(entry.sku)?.toLowerCase() === normalizedSku,
  );

  return item
    ? {
      amount_xtr: Math.max(1, Math.trunc(item.promo_amount_xtr)),
      amount_rub:
        item.promo_amount_rub != null
          ? Math.max(1, Math.trunc(item.promo_amount_rub))
          : null,
    }
    : null;
}

export function resolvePromotionForSku(
  sku: string,
  promotions: MediaPromotion[] = config.MEDIA_PROMOTIONS_JSON,
  nowMs: number = Date.now(),
): {
  promo_key: string;
  promo_amount_xtr: number;
  promo_amount_rub: number | null;
} | null {
  const normalizedSku = normalizeString(sku)?.toLowerCase();
  if (!normalizedSku) {
    return null;
  }

  let matchedPromotion: {
    promo_key: string;
    promo_amount_xtr: number;
    promo_amount_rub: number | null;
  } | null = null;

  for (const promotion of promotions) {
    if (!isPromotionActive(promotion, nowMs)) {
      continue;
    }
    const promoAmount = resolvePromotionAmountForSku(promotion, normalizedSku);
    if (promoAmount != null) {
      matchedPromotion = {
        promo_key: promotion.promo_key,
        promo_amount_xtr: promoAmount.amount_xtr,
        promo_amount_rub: promoAmount.amount_rub,
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
  const originalAmountRub =
    plan.amount_rub != null
      ? Math.max(1, Math.trunc(plan.amount_rub))
      : null;
  const promotion = resolvePromotionForSku(plan.sku, promotions, nowMs);
  const finalAmount = promotion?.promo_amount_xtr ?? originalAmount;
  const finalAmountRub = originalAmountRub == null
    ? null
    : promotion?.promo_amount_rub ?? originalAmountRub;

  return {
    ...plan,
    amount_xtr: finalAmount,
    amount_rub: finalAmountRub,
    original_amount_xtr: originalAmount,
    final_amount_xtr: finalAmount,
    original_amount_rub: originalAmountRub,
    final_amount_rub: finalAmountRub,
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
    title: "text",
    description: "text",
    label: "text",
    button_text: config.TELEGRAM_UX_COPY_JSON.media.pay_button,
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
