import { WebError } from './types.js';
type Row = Record<string, any>;
export function businessResult(row: Row | undefined): Record<string, any> {
  const result = row?.result;
  if (!result || typeof result !== 'object') throw new WebError(500, 'internal_error');
  if (result.status === 'error') {
    const codes: Record<string, [number, string]> = {
      campaign_not_active: [409, 'campaign_not_active'], candidate_not_found: [404, 'candidate_not_found'],
      vote_conflict: [409, 'vote_conflict'], account_not_found: [401, 'account_not_found'],
      telegram_link_expired: [410, 'telegram_link_expired'], telegram_link_used: [409, 'telegram_link_used'],
      telegram_identity_conflict: [409, 'telegram_account_conflict'], telegram_proof_reused: [409, 'telegram_proof_reused'],
      subscription_conflict: [409, 'subscription_conflict'], identity_conflict: [409, 'identity_conflict'],
      account_busy: [409, 'account_busy'],
    };
    const [status, code] = codes[String(result.code)] ?? [500, 'internal_error'];
    throw new WebError(status, code);
  }
  return result;
}
