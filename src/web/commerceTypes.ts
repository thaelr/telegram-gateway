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
 feature_key?: string;
};
