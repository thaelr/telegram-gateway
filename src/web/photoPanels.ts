import {createHash} from 'node:crypto';
import {sql} from '../db.js';
import {MediaCommerceRepository} from '../mediaCommerceRepository.js';
import {calculateMediaPriceRequired,normalizeUnlockedItems,normalizeNextUnseen,selectNavigatedPhoto} from '../mediaCommerce/mediaAction.js';
import type {WebProductPlan} from './commerceTypes.js';
import {WebError} from './types.js';

export type WebPhotoPanelAction='photo_prev'|'photo_next'|'photo_regen';
export type WebPhotoPanel={position:number|null;count:number;media_id:string;photo_url:string|null;unlocked:boolean;scene_session_id:string;actions:{previous:boolean;next:boolean;more:boolean};offer?:{media_id:string;sku:string;conditions:{price:{amount:string;currency:string}|null;price_required:number}}};
type DB=Pick<typeof sql,'unsafe'>;
const rows=async(db:DB,query:string,args:any[]=[]):Promise<Record<string,any>[]>=>db.unsafe(query,args);

/** Adapter over existing panel context, unlock ledger and photo selection rules. */
export class WebPhotoPanels {
 constructor(private readonly query:typeof sql=sql){}
 private async context(db:DB,userId:string,code:string,anchor:string,current:string|undefined,plans:WebProductPlan[],lock=false){
  const [chat]=await rows(db,"SELECT chat_id,character_i,active_scene_session_id FROM public.chat_state WHERE user_id=$1 AND chat_code=$2 AND is_active"+(lock?' FOR UPDATE':''),[userId,code]);
  if(!chat)throw new WebError(404,'chat_not_found');
  const [panel]=await rows(db,"SELECT * FROM app_private.web_media_offers WHERE user_id=$1 AND chat_id=$2 AND media_id=$3::uuid ORDER BY created_at DESC LIMIT 1",[userId,chat.chat_id,anchor]);
  if(!panel)throw new WebError(404,'media_offer_not_found');
  const plan=plans.find(p=>p.kind==='photo'&&p.sku===panel.sku);if(!plan)throw new WebError(404,'product_not_found');
  const common=new MediaCommerceRepository(db as typeof sql);
  const input={chat_id:Number(chat.chat_id),scene_session_id:panel.scene_session_id,turn_no:Number(panel.turn_no),scene_turn_no:panel.scene_turn_no==null?null:Number(panel.scene_turn_no),media_signature:panel.media_signature,current_uuid:current??anchor,target_message_id:Number(panel.panel_id),base_price_xtr:plan.amount_xtr,action_kind:'photo_next',requested_action:'photo_request',invoice_token:null,force_deliver_after_payment:false,paid_access_mode:null,callback_valid:true,panel_text:null,panel_entities_json:[]};
  const context=await common.loadMediaContext(input),items=normalizeUnlockedItems(context.unlocked_items_json);
  if(current&&current!==anchor&&!items.some(item=>item.uuid===current))throw new WebError(404,'media_not_unlocked');
  const next=Number(context.panel_unlocked_count??items.length)<5?normalizeNextUnseen(context.next_unseen_json):null;
  const active=chat.active_scene_session_id===panel.scene_session_id;
  const selected=items.find(item=>item.uuid===input.current_uuid);
  const result:WebPhotoPanel={position:selected?items.findIndex(item=>item.uuid===selected.uuid)+1:null,count:items.length,media_id:input.current_uuid,photo_url:selected?.photo_url??null,unlocked:Boolean(selected),scene_session_id:panel.scene_session_id,actions:{previous:items.length>1,next:items.length>1,more:Boolean(active&&next)}};
  return {chat,panel,plan,common,input,context,items,next,active,result};
 }
 async get(userId:string,code:string,anchor:string,current:string|undefined,plans:WebProductPlan[]){return (await this.context(this.query,userId,code,anchor,current,plans)).result;}
 async act(userId:string,code:string,anchor:string,input:{client_message_id:string;action:WebPhotoPanelAction;current_media_id?:string},plans:WebProductPlan[]):Promise<WebPhotoPanel>{
  return this.query.begin(async tx=>{
   const state=await this.context(tx,userId,code,anchor,input.current_media_id,plans,true);
   const token='web_photo_panel_'+createHash('sha256').update(userId+':'+input.client_message_id).digest('hex').slice(0,32);
   const fingerprint=createHash('sha256').update(JSON.stringify({code,anchor,action:input.action,current:input.current_media_id??anchor})).digest('hex');
   await rows(tx,'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[token]);
   const [saved]=await rows(tx,'SELECT payload_json FROM public.interaction_tokens WHERE token=$1',[token]);
   if(saved){if(saved.payload_json.fingerprint!==fingerprint)throw new WebError(409,'idempotency_conflict');return saved.payload_json.response as WebPhotoPanel;}
   let result=state.result;
   if(input.action==='photo_regen'){
    if(!state.active)throw new WebError(409,'stale_scene');
    if(!state.next)throw new WebError(409,'photo_unavailable');
    const required=calculateMediaPriceRequired({subscription_active:state.context.subscription_active,scene_access_active:state.context.scene_access_active,delivered_in_scene:state.context.delivered_in_scene,base_price_xtr:state.plan.amount_xtr});
    const conditions={price:required===0?{amount:'0',currency:'RUB'}:state.plan.amount_rub==null?null:{amount:String(state.plan.amount_rub),currency:'RUB'},price_required:required};
    // The immutable panel and scene survive browsing. No catalog choice or URL
    // comes from the caller; the existing unlock/payment route grants access.
    const [offer]=await rows(tx,"INSERT INTO app_private.web_media_offers(user_id,chat_id,scene_session_id,media_id,sku,media_signature,panel_id,turn_no,scene_turn_no,conditions) VALUES($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::text::jsonb) ON CONFLICT(chat_id,scene_session_id,media_id) DO UPDATE SET conditions=EXCLUDED.conditions RETURNING media_id::text,sku,panel_id",[userId,state.chat.chat_id,state.panel.scene_session_id,state.next.uuid,state.panel.sku,state.panel.media_signature,state.panel.panel_id,state.panel.turn_no,state.panel.scene_turn_no,JSON.stringify(conditions)]);
    if(String(offer!.panel_id)!==String(state.panel.panel_id))throw new WebError(409,'media_panel_conflict');
    result={...result,offer:{media_id:offer!.media_id,sku:offer!.sku,conditions}};
    await rows(tx,"SELECT app_private.web_publish($1,'media_offer',$2::text::jsonb)",[state.chat.chat_id,JSON.stringify({...result.offer,...conditions,media_kind:'photo',scene_session_id:state.panel.scene_session_id,panel_media_id:anchor})]);
   }else{
    const selected=selectNavigatedPhoto(state.items,state.input.current_uuid,input.action);if(!selected)throw new WebError(404,'media_not_unlocked');
    result={...result,position:state.items.findIndex(item=>item.uuid===selected.uuid)+1,media_id:selected.uuid,photo_url:selected.photo_url,unlocked:true};
    await rows(tx,"SELECT set_config('app_private.media_source','web',true)");
    const required=calculateMediaPriceRequired({subscription_active:state.context.subscription_active,scene_access_active:state.context.scene_access_active,delivered_in_scene:state.context.delivered_in_scene,base_price_xtr:state.plan.amount_xtr});
    await state.common.storePhotoEvent({...state.input,event_type:'media.photo.viewed.nav',uuid:selected.uuid,panel_message_id:Number(state.panel.panel_id),price_xtr:0,access_mode:'nav',action_kind:input.action,fulfillment_invoice_token:null,next_invoice_token:null,next_invoice_link:null,price_required:required});
   }
   await rows(tx,"INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,turn_no,action_kind,status,payload_json) VALUES($1,'button_callback',$2,$3,$4,$5,'fulfilled',$6::text::jsonb)",[token,state.chat.chat_id,state.panel.scene_session_id,state.panel.turn_no,input.action,JSON.stringify({source:'web',fingerprint,response:result})]);
   return result;
  });
 }
}
