import { z } from "zod";

const textSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();

export const telegramUxCopySchema = z.object({
  language: z.object({
    message: textSchema,
    ru_button: textSchema,
    en_button: textSchema,
    updated: textSchema,
  }).optional(),
  opening_replies: z.object({
    input_placeholder: textSchema,
    reminder_html: textSchema.optional(),
    followup_prompt: textSchema.optional(),
  }).optional(),
  terms: z.object({
    message: textSchema,
    open_button: textSchema,
    accept_button: textSchema,
  }),
  scene_reset: z.object({
    confirm: textSchema,
    yes_button: textSchema,
    no_button: textSchema,
    processing: textSchema,
    continue: textSchema,
  }),
  promo: z.object({
    activated: textSchema,
    effect_id: textSchema,
  }),
  paysupport: z.object({
    message_html: textSchema,
    free_fast_scene_skips_line: textSchema.optional(),
    free_scene_unlocks_line: textSchema.optional(),
  }),
  free_balances: z.object({
    heading: textSchema,
    scene_unlock: z.object({ one: textSchema, few: textSchema, many: textSchema }),
    photo: z.object({ one: textSchema, few: textSchema, many: textSchema }),
    fast_scene_skip: z.object({ one: textSchema, few: textSchema, many: textSchema }),
  }).optional(),
  free_actions: z.object({
    fast_scene_skip_button: textSchema,
  }),
  payment_ui: z.object({
    fast_scene_skip_hint: textSchema,
    scene_unlock_hint: textSchema,
    pay_with_stars_button: textSchema,
    pay_with_sbp_button: textSchema,
    stars_payment_button: textSchema,
    sbp_payment_button: textSchema,
    subscription_stars_plan_button: textSchema,
    subscription_sbp_plan_button: textSchema,
  }),
  scene_mode: z.object({
    choice: textSchema,
    roleplay_button: textSchema,
    fast_button: textSchema,
    back_button: textSchema,
    transition: z.object({
      fast: z.object({ text: textSchema, effect_id: textSchema }),
      roleplay: z.object({ text: textSchema, effect_id: textSchema }),
    }),
  }),
  character_gallery: z.object({
    heading: textSchema,
    empty: textSchema,
    order: z.array(positiveIntegerSchema).superRefine((value, ctx) => {
      if (new Set(value).size !== value.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Character gallery order ids must be unique",
        });
      }
    }),
    next_first_button: textSchema,
    next_button: textSchema,
    back_button: textSchema,
    vote_button: textSchema,
    vote_url: z.string().url(),
    resume_with_name: textSchema.optional(),
    resume_without_name: textSchema.optional(),
    characters: z.record(z.string().min(1), z.object({
      gallery_title: textSchema,
      gallery_body: textSchema,
      mode_intro: textSchema,
      roleplay_description_html: textSchema,
      fast_description_html: textSchema,
    })),
  }),
  subscription: z.object({
    active: textSchema,
    daily_limit_offer: textSchema,
    command_offer: textSchema,
  }),
  media: z.object({
    get_photo_button: textSchema,
    more_photo_button: textSchema,
    generating: textSchema,
    pay_button: textSchema,
    scene_unlock_button: textSchema,
    prev_button: textSchema,
    next_button: textSchema,
    video_unlock_button: textSchema.optional(),
    animate_photo_button: textSchema.optional(),
    video_pass_button: textSchema.optional(),
  }),
  video: z.object({
    duplicate_payment_review: textSchema,
    unavailable: textSchema,
    panel_changed: textSchema,
    pass_scene_changed: textSchema,
    pass_activated: textSchema,
    subscription_valid_until: textSchema,
    subscription_benefits_preserved: textSchema,
    full_benefits: textSchema,
    base_benefits: textSchema,
    full_upgrade_description: textSchema,
  }).optional(),
  callbacks: z.object({
    newscene_yes: textSchema,
    newscene_no: textSchema,
    terms_accept: textSchema,
    character_select: textSchema,
    character_back: textSchema,
    scene_mode_fast: textSchema,
    scene_mode_roleplay: textSchema,
    scene_access_activated: textSchema,
  }),
  payment_errors: z.object({
    expired: textSchema,
    stale: textSchema,
    different_scene: textSchema,
    subscription_active: textSchema,
    scene_already_unlocked: textSchema,
  }),
  fallbacks: z.object({
    audio_transcription_error: textSchema,
  }).optional(),
  web_continue: z.object({
    message: textSchema,
    button: textSchema,
  }).optional(),
  maintenance: z.object({
    message: textSchema,
  }).optional(),
  rewards: z.object({
    activated: textSchema,
    already_activated: textSchema,
    unavailable: textSchema,
  }).optional(),
});

export type TelegramUxCopy = z.infer<typeof telegramUxCopySchema>;
