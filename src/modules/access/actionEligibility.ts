import { config } from '../../config.js';

export function calculateMediaPriceRequired(input: {
  subscription_active: boolean;
  scene_access_active?: boolean;
  free_photos_today: number;
  base_price_xtr: number;
}): number {
  return input.subscription_active || input.scene_access_active === true
    ? 0
    : input.free_photos_today < config.DAILY_FREE_LIMITS_JSON.photos
      ? 0
      : input.base_price_xtr;
}
