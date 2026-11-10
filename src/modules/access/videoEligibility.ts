import type { VideoCommerceRepository } from '../media/videoRepository.js';
import { normalizePositiveInteger, normalizeString } from '../../mediaCommerce/utils.js';

export async function videoInvoiceAllowed(videos: VideoCommerceRepository, chatId:number, scene:string, feature:string, payload:Record<string,unknown>) {
    const offer=await videos.passOfferContext(chatId,scene,'telegram');
    if(offer.scene_session_id!==scene || offer.full_active || offer.video_pass_active ||
      (payload.user_id!=null && payload.user_id!==offer.user_id)) return false;
    if(feature==='video_pass'){
      if(payload.purchase_variant==='scene_unlock_upgrade' && (!offer.paid_scene_unlock_token ||
        payload.paid_scene_unlock_token!==offer.paid_scene_unlock_token))return false;
      if(payload.video_id==null)return offer.available && (payload.media_signature==null || payload.media_signature===offer.media_signature);
    }
    const context=await videos.context({chat_id:chatId,scene_session_id:scene,panel_message_id:normalizePositiveInteger(payload.photo_message_id),
      media_signature:normalizeString(typeof payload.media_signature==='string'?payload.media_signature:null),
      requested_photo_uuid:typeof payload.requested_photo_uuid==='string'?payload.requested_photo_uuid:null,
      character_i:normalizePositiveInteger(payload.character_i)});
    return context.scene_active && !context.panel_delivered && !context.delivery && context.video?.video_id===payload.video_id &&
      (!context.panel_photo_uuid || context.panel_photo_uuid===payload.requested_photo_uuid);
  }
