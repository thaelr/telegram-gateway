import { config } from '../../config.js';
import { parseStrictJsonObject } from '../../mediaCommerceRepository/shared.js';
import type { ActivateSceneAccessInput, ActivateSubscriptionInput, LoadFreeCreditsResult, QueryClient, RedeemFreeActionResult, SceneAccessStatus, SceneAccessStatusInput } from '../../mediaCommerceRepository/shared.js';

export function validateRedeemResult(
    row: RedeemFreeActionResult | null,
    operation: string,
  ): RedeemFreeActionResult | null {
    if (
      row
      && (
        row.token != null
        || row.redeemed === true
        || row.already_consumed === true
        || row.already_fulfilled === true
      )
    ) {
      return {
        ...row,
        payload_json: parseStrictJsonObject(row.payload_json, operation),
      };
    }

    return row;
  }

export async function activateSubscription(query: QueryClient, input: ActivateSubscriptionInput,
  ): Promise<number> {
    const rows = await query<Array<{ activated_count: number }>>`
      SELECT public.media_activate_subscription(
        ${input.payment_token}::text,
        ${input.chat_id}::bigint,
        ${input.subscription_sku}::text,
        ${input.subscription_days}::integer
      ) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
  }

export async function activateSceneAccess(query: QueryClient, input: ActivateSceneAccessInput,
  ): Promise<number> {
    const rows = await query<Array<{ activated_count: number }>>`
      SELECT public.media_activate_scene_access(
        ${input.payment_token}::text,
        ${input.chat_id}::bigint,
        ${input.scene_session_id}::text,
        ${input.scene_access_sku}::text
      ) AS activated_count
    `;

    return rows[0]?.activated_count ?? 0;
  }

export async function loadSceneAccessStatus(query: QueryClient, input: SceneAccessStatusInput,
  ): Promise<SceneAccessStatus | null> {
    const rows = await query<SceneAccessStatus[]>`
      SELECT
        cs.chat_id, cs.user_id,
        COALESCE(${input.scene_session_id}::text, cs.active_scene_session_id) AS scene_session_id,
        cs.active_scene_session_id,
        (
          account.subscription_until IS NOT NULL
          AND account.subscription_until > now()
        ) AS subscription_active,
        COALESCE((SELECT e.scene_access_active FROM app_private.scene_entitlements(css.chat_id,css.scene_session_id) e), FALSE) AS scene_access_active,
        css.scene_access_payment_token,
        (
          css.scene_session_id IS NOT NULL
          AND css.scene_session_id = cs.active_scene_session_id
        ) AS scene_is_active
      FROM public.chat_state cs
      JOIN public.users account
        ON account.user_id = cs.user_id
      LEFT JOIN public.chat_scene_sessions css
        ON css.chat_id = cs.chat_id
       AND css.scene_session_id = COALESCE(${input.scene_session_id}::text, cs.active_scene_session_id)
      WHERE cs.chat_id = ${input.chat_id}::bigint
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

export async function loadFreeCredits(query: QueryClient, chatId: number): Promise<LoadFreeCreditsResult | null> {
    const rows = await query<LoadFreeCreditsResult[]>`
      SELECT
        cs.chat_id,
        cs.active_scene_session_id,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_fast_scene_skips')::integer,
          0
        ) AS free_fast_scene_skips,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_scene_unlocks')::integer,
          0
        ) AS free_scene_unlocks,
        COALESCE(
          (account.entitlements_jsonb ->> 'free_photo_unlocks')::integer,
          0
        ) AS free_photo_unlocks
      FROM public.chat_state cs
      JOIN public.users account
        ON account.user_id = cs.user_id
      WHERE cs.chat_id = ${chatId}::bigint
      LIMIT 1
    `;

    return rows[0] ?? null;
  }

export async function redeemFreeFastSceneSkip(query: QueryClient, token: string | null,
    chatId: number | null,
  ): Promise<RedeemFreeActionResult | null> {
    const rows = await query<RedeemFreeActionResult[]>`
      SELECT *
      FROM public.media_redeem_free_fast_scene_skip(
        ${token}::text,
        ${chatId}::bigint
      )
    `;

    return validateRedeemResult(
      rows[0] ?? null,
      "media_redeem_free_fast_scene_skip",
    );
  }

export async function redeemFreeSceneUnlock(query: QueryClient, token: string | null,
    chatId: number | null,
  ): Promise<RedeemFreeActionResult | null> {
    const rows = await query<RedeemFreeActionResult[]>`
      SELECT *
      FROM public.media_redeem_free_scene_unlock(
        ${token}::text,
        ${chatId}::bigint
      )
    `;

    return validateRedeemResult(
      rows[0] ?? null,
      "media_redeem_free_scene_unlock",
    );
  }

export async function redeemFreePhotoUnlock(query: QueryClient, token: string | null,
    chatId: number | null,
  ): Promise<RedeemFreeActionResult | null> {
    const rows = await query<RedeemFreeActionResult[]>`
      SELECT *
      FROM public.media_redeem_free_photo_unlock(
        ${token}::text,
        ${chatId}::bigint,
        ${config.DAILY_FREE_LIMITS_JSON.photos}::integer
      )
    `;

    return validateRedeemResult(
      rows[0] ?? null,
      "media_redeem_free_photo_unlock",
    );
  }
