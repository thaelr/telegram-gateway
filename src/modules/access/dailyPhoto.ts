import { config } from '../../config.js';
import type { QueryClient } from '../../mediaCommerceRepository/shared.js';

export async function authorizeDailyPhoto(query: QueryClient, chatId:number,scene:string,requestKey:string,photo:string,panel:number) {
    const [row] = await query<{ mode:'free'|'subscription'|'scene_pass'|'nav'|null;dispatch_by:Date }[]>`
      SELECT app_private.authorize_daily_photo(${chatId}::bigint,${scene}::text,${requestKey}::text,
        ${photo}::text,${panel}::bigint,${config.DAILY_FREE_LIMITS_JSON.photos}::integer) AS mode,
        statement_timestamp()+interval '90 seconds' AS dispatch_by`;
    return { mode:row?.mode ?? null,dispatchBy:row?.dispatch_by.toISOString() };
  }
