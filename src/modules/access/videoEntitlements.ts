import type { QueryClient } from '../../mediaCommerceRepository/shared.js';

export async function activateVideoPass(query: QueryClient, paymentToken: string, chatId: number): Promise<number> {
    const rows = await query<{ value: number }[]>`SELECT public.media_activate_video_pass(${paymentToken}::text,${chatId}::bigint) AS value`;
    return Number(rows[0]?.value ?? 0);
  }

export async function activateFullSubscription(query: QueryClient, paymentToken: string, chatId: number, sku: string, days: number, change: string): Promise<number> {
    const rows = await query<{ value: number }[]>`SELECT public.media_activate_full_subscription(${paymentToken}::text,${chatId}::bigint,${sku}::text,${days}::integer,${change}::text) AS value`;
    return Number(rows[0]?.value ?? 0);
  }
