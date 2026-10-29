export type WebProductPlan = {
 sku: string;
 kind: 'subscription' | 'photo' | 'feature';
 title: string;
 description: string;
 amount_xtr: number;
 amount_rub: number | null;
 original_amount_rub: number | null;
 promo_key: string | null;
 subscription_days?: number;
 subscription_tier?: 'base' | 'full';
 subscription_change?: 'upgrade' | 'renew';
 upgrade_base_sku?: string;
 upgrade_full_amount_xtr?: number;
 upgrade_full_amount_rub?: number | null;
 feature_key?: string;
};
