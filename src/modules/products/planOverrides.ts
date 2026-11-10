import type { SubscriptionOfferExperimentParams } from '../experiments/abTesting.js';
import { config } from '../../config.js';

export function applySubscriptionPlanOverrides<T extends {
  sku: string;
  amount_xtr: number;
  amount_rub?: number | null;
  days?: number;
  title: string;
  description: string;
  label: string;
  button_text: string;
  tier?: 'base'|'full';
  upgrade_full_amount_xtr?: number;
  upgrade_full_amount_rub?: number | null;
}>(
  plans: T[],
  params: SubscriptionOfferExperimentParams,
): T[] {
  const overrides = new Map(
    (params.plans ?? []).map((override) => [override.sku, override]),
  );

  return plans.flatMap((plan) => {
    const override = overrides.get(plan.sku);
    if (override?.enabled === false) {
      return [];
    }

    const fullMultiplier = 1-config.MEDIA_FULL_DISCOUNT_PERCENT/100;
    return [{
      ...plan,
      days: plan.tier === 'full' ? 30 : override?.days ?? plan.days,
      amount_xtr: override?.amount_xtr != null && plan.tier === 'full' ? Math.max(1,Math.round(override.amount_xtr*fullMultiplier)) : override?.amount_xtr ?? plan.amount_xtr,
      amount_rub:
        "amount_rub" in (override ?? {})
          ? override?.amount_rub == null ? null : plan.tier === 'full' ? Math.max(1,Math.round(override.amount_rub*fullMultiplier)) : override.amount_rub
          : plan.amount_rub ?? null,
      upgrade_full_amount_xtr:override?.amount_xtr != null && plan.tier === 'full' ? override.amount_xtr*fullMultiplier : plan.upgrade_full_amount_xtr,
      upgrade_full_amount_rub:override?.amount_rub != null && plan.tier === 'full' ? override.amount_rub*fullMultiplier : plan.upgrade_full_amount_rub,
      title: override?.title ?? plan.title,
      description: override?.description ?? plan.description,
      label: override?.label ?? plan.label,
      button_text: override?.button_text ?? plan.button_text,
    } as T];
  });
}

export function applySceneUnlockOverride<T extends {
  amount_xtr: number;
  amount_rub?: number | null;
  title: string;
  description: string;
  label: string;
  button_text: string;
}>(
  plan: T | null,
  params: SubscriptionOfferExperimentParams,
): T | null {
  if (!plan || params.scene_unlock?.enabled === false) {
    return null;
  }

  const override = params.scene_unlock;
  return {
    ...plan,
    amount_xtr: override?.amount_xtr ?? plan.amount_xtr,
    amount_rub:
      override && "amount_rub" in override
        ? override.amount_rub ?? null
        : plan.amount_rub ?? null,
    title: override?.title ?? plan.title,
    description: override?.description ?? plan.description,
    label: override?.label ?? plan.label,
    button_text: override?.button_text ?? plan.button_text,
  };
}
