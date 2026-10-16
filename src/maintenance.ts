import { config } from "./config.js";
import { normalizePositiveInteger } from "./numeric.js";

export function isMaintenanceBlocked(userIdInput: unknown): boolean {
  if (!config.MAINTENANCE_MODE) return false;

  const userId = normalizePositiveInteger(userIdInput);
  return userId == null
    || !config.MAINTENANCE_ALLOWED_USER_IDS_JSON.includes(userId);
}
