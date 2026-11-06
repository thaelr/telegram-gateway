import {z} from 'zod';
import {WebError} from './types.js';

export const quickRepliesSchema=z.object({scene_session_id:z.string().min(1),turn_no:z.number().int(),options:z.array(z.union([
 z.string(),z.object({option_index:z.number().int(),reply_text:z.string(),next_replies:z.array(z.unknown()).nullable().optional()})
])).max(20)});
export const eventSchema=z.object({cursor:z.string().regex(/^\d+$/),type:z.enum(['message','scene','operation_status','quick_replies','media_offer','media_unlocked','video_delivered']),data:z.record(z.unknown()),created_at:z.string().datetime()})
 .superRefine((event,ctx)=>{if(event.type==='quick_replies'&&!quickRepliesSchema.safeParse(event.data).success)ctx.addIssue({code:'custom',message:'Invalid quick reply projection'});});
/** Stored boundary data can outlive a deploy. Fail without leaking its contents. */
export function parseStored<T>(schema:z.ZodType<T>,value:unknown):T{
 const parsed=schema.safeParse(value);if(!parsed.success)throw new WebError(500,'invalid_stored_contract');return parsed.data;
}
