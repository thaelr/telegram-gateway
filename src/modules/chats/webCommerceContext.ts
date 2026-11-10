import { sql, queryRows as r, toIsoTimestamp as iso } from '../../db.js';
import {WebError} from '../../web/types.js';
import type {WebCommerceContext} from '../../web/commerceTypes.js';
type DB=Pick<typeof sql,'unsafe'>;
const contextQuery="SELECT c.chat_id,c.chat_code,c.character_i,c.active_scene_session_id AS scene_session_id,c.current_turn_no AS turn_no,c.scene_turn_no,c.debounce_revision,s.scene_mode FROM public.chat_state c LEFT JOIN public.chat_scene_sessions s ON s.chat_id=c.chat_id AND s.scene_session_id=c.active_scene_session_id WHERE c.user_id=$1 AND c.chat_code=$2 AND c.character_i IS NOT NULL AND c.is_active";
export async function loadWebCommerceContext(db:DB,userId:string,code:string,lock=false):Promise<WebCommerceContext>{
  const row=(await r(db,contextQuery+(lock?' FOR UPDATE OF c':''),[userId,code]))[0];
  if(!row)throw new WebError(404,'chat_not_found');
  return {...row,chat_id:Number(row.chat_id),character_i:Number(row.character_i),turn_no:Number(row.turn_no),scene_turn_no:row.scene_turn_no==null?null:Number(row.scene_turn_no)} as WebCommerceContext;
 }
