export type SceneMode = 'fast' | 'roleplay';
export type WebAction = 'scene_start' | 'message' | 'reset';
export type WebIdentity = { verified_telegram_id?:string; auth_user_id: string; is_anonymous: boolean; display_name: string | null; locale: string | null };
export type WebProfile = { user_id: string; display_name: string | null; profile_text?: string | null; language: string | null; language_confirmed_at: string | null; age_confirmed_at: string | null; terms_accepted_at: string | null; subscription_sku: string | null; subscription_until: string | null; entitlements: Record<string, unknown>; needs_language_selection: boolean };
export type WebChat = { chat_code: string; character_i: number; scene_mode: SceneMode | null; scene_session_id: string | null; turn_no: number; scene_turn_no: number; updated_at: string; origin?:'web'|'telegram'; last_message?:WebMessage|null; unread_count?:number; last_read_message_id?:string|null };
export type WebChatSummary=WebChat & {last_message:WebMessage|null;unread_count:number;last_read_message_id:string|null};
export type WebCharacter = { character_i: number; name: string; description: string; image_url: string | null; gallery_photo_url: string | null; gallery_photos?: string[]; menu_photo_url: string | null; scene_start_exposition_text: string | null; scene_start_greeting_text: string | null; fast_mode_scene_start_exposition_text: string | null; fast_mode_scene_start_greeting_text: string | null; modes: SceneMode[]; chat_code: string | null };
export type WebOperation = { operation_id: string; event_id: string; status: string; action: WebAction; chat_code: string; client_message_id?:string; error_code?:string };
export type WebQuickReplies = {scene_session_id:string;turn_no:number;options:(string|{option_index:number;reply_text:string;next_replies?:unknown[]|null})[]};
export type WebMessage = { id: string; role: 'user' | 'assistant'; text: string; source: string; scene_session_id: string | null; turn_no: number; created_at: string; media_kind?: 'photo' | 'video'; media_id?: string; video_delivery_id?: string; photo_url?: string | null; client_message_id?: string };
export type WebEvent = { cursor: string; type: 'message' | 'scene' | 'operation_status' | 'quick_replies' | 'media_offer' | 'media_unlocked' | 'video_delivered'; data: Record<string, unknown>; created_at: string };
export type WebDeliveryEvent = { event_id: string; user_id: string; chat_id: number; character_i: number; scene_mode: SceneMode; source: 'web'; action: WebAction; data: { user_message?: string; client_message_id: string; entry_mode?: 'fast_scene_skip'; payment_token?: string; feature_key?: 'fast_scene_skip' } };
export class WebError extends Error {
  constructor(readonly statusCode: number, readonly code: string) { super(code); }
}
export interface WebRepositoryContract {
  bootstrap(identity: WebIdentity): Promise<WebProfile>;
  resolveIdentity(authUserId: string): Promise<string | null>;
  getMe(userId: string): Promise<WebProfile>;
  updateMe(userId: string, patch: { display_name?: string; profile_text?: string; language?: string }): Promise<WebProfile>;
  confirmAge(userId: string): Promise<WebProfile>;
  acceptTerms(userId: string): Promise<WebProfile>;
  listCharacters(userId: string): Promise<WebCharacter[]>;
  getCharacter(userId: string, characterId: number): Promise<WebCharacter>;
  listChats(userId: string): Promise<WebChat[]>;
  listChatSummaries?(userId:string):Promise<WebChatSummary[]>;
  createChat(userId: string, characterId: number, mode: SceneMode, clientId: string): Promise<{ chat: WebChat; operation: WebOperation | null }>;
  getChat(userId: string, code: string): Promise<WebChat>;
  enqueue(userId: string, code: string, action: 'message' | 'reset', clientId: string, text?: string, sceneMode?: SceneMode): Promise<WebOperation>;
  history(userId: string, code: string, before?: string, limit?: number): Promise<{ messages: WebMessage[]; next_before: string | null; event_cursor?:string; quick_replies?:WebQuickReplies|null }>;
  events(userId: string, code: string, after?: string, limit?: number, operationIds?:string[]): Promise<{ events: WebEvent[]; cursor: string; operations?:WebOperation[] }>;
  continuation(userId: string, code: string): Promise<{ offered: boolean; separator: string; messages: WebMessage[]; chat: WebChat }>;
}
