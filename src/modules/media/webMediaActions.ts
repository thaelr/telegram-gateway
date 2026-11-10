import {config} from '../../config.js';
import {WebError} from '../../web/types.js';
import type {WebCommerceRepository} from '../commerce/webPurchaseRepository.js';
export async function requestVideo(repository:WebCommerceRepository,consent:(userId:string)=>Promise<void>,userId:string,code:string,mediaId:string,clientId:string){
  await consent(userId);
  if(!config.MEDIA_VIDEO_ENABLED)throw new WebError(409,'video_disabled');
  const key=repository.videos.requestKey(userId,code,mediaId,clientId);
  const existing=await repository.videos.byRequest(userId,key);
  if(existing)return repository.videos.publicDelivery(existing);
  const offer=await repository.getOffer(userId,code,mediaId);
  if(!offer)throw new WebError(404,'media_offer_not_found');
  const state=await repository.videos.context(offer);
  if(!state.video||!state.scene_active||state.panel_delivered)throw new WebError(409,'video_unavailable');
  if(!state.full_active&&!state.video_pass_active)throw new WebError(402,'video_payment_required');
  const delivery=await repository.videos.prepare({request_key:key,chat_id:offer.chat_id,scene_session_id:offer.scene_session_id,video_id:state.video.video_id,media_signature:offer.media_signature,requested_photo_uuid:offer.media_id,photo_message_id:offer.panel_id});
  return repository.videos.publicDelivery(delivery);
 }
