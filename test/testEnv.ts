export const testTelegramUxCopy = {
  language: {
    message: "Choose language",
    ru_button: "RU",
    en_button: "EN",
    updated: "Language updated",
  },
  opening_replies: {
    input_placeholder: "Write my own reply",
    reminder_html: "<code>Choose a reply</code>",
    followup_prompt: "Choose a reply",
  },
  terms: {
    message: "text",
    open_button: "text",
    accept_button: "text",
  },
  scene_reset: {
    confirm: "text",
    yes_button: "text",
    no_button: "text",
    processing: "text",
    continue: "text",
  },
  promo: {
    activated: "text",
    effect_id: "text",
  },
  paysupport: {
    message_html: "text",
    free_fast_scene_skips_line: "fast skips: {count}",
    free_scene_unlocks_line: "scene unlocks: {count}",
  },
  free_balances: {
    heading: "Gifts:",
    scene_unlock: { one: "{count} scene unlock", few: "{count} scene unlocks", many: "{count} scene unlocks" },
    photo: { one: "{count} photo", few: "{count} photos", many: "{count} photos" },
    fast_scene_skip: { one: "{count} scene skip", few: "{count} scene skips", many: "{count} scene skips" },
  },
  free_actions: {
    fast_scene_skip_button: "free skip {count}",
  },
  payment_ui: {
    fast_scene_skip_hint: "*skip hint",
    scene_unlock_hint: "*unlock hint",
    pay_with_stars_button: "pay stars",
    pay_with_sbp_button: "pay sbp",
    stars_payment_button: "star {amount}",
    sbp_payment_button: "sbp {amount}",
    subscription_stars_plan_button: "{label} star {amount}",
    subscription_sbp_plan_button: "{label} sbp {amount}",
  },
  scene_mode: {
    choice: "text",
    roleplay_button: "text",
    fast_button: "text",
    back_button: "text",
    transition: {
      fast: {
        text: "text",
        effect_id: "text",
      },
      roleplay: {
        text: "text",
        effect_id: "text",
      },
    },
  },
  character_gallery: {
    heading: "text",
    empty: "text",
    order: [1],
    next_first_button: "more characters",
    next_button: "more",
    back_button: "back",
    vote_button: "vote",
    vote_url: "https://example.com/vote",
    resume_with_name: "Continue with {name}",
    resume_without_name: "Continue",
    characters: {
      "1": {
        button_text: "button",
        gallery_title: "text",
        gallery_body: "text",
        mode_intro: "text",
        roleplay_description_html: "text",
        fast_description_html: "text",
      },
    },
  },
  subscription: {
    active: "text",
    daily_limit_offer: "text",
    command_offer: "text",
  },
  media: {
    get_photo_button: "text",
    more_photo_button: "text",
    generating: "text",
    pay_button: "text",
    prev_button: "text",
    next_button: "text",
    animate_photo_button: "animate photo",
  },
  commerce_ui: {
    video: "video",
    scene_photo: "scene photo",
    scene_subscription: "scene subscription",
    back: "back",
    scene_unlock: "scene unlock",
    video_pass: "video pass",
    scene_unlock_upgrade: "scene unlock upgrade",
    video_unlock: "video unlock",
    free_scene_unlock: "text",
  },
  video: {
    duplicate_payment_review: "duplicate payment review",
    unavailable: "video unavailable",
    panel_changed: "panel changed",
    pass_scene_changed: "scene changed",
    pass_activated: "video pass active",
    subscription_valid_until: "valid until {date}",
    subscription_benefits_preserved: "benefits preserved",
    full_benefits: "full benefits",
    base_benefits: "base benefits",
    full_upgrade_description: "full upgrade: {description}",
  },
  callbacks: {
    newscene_yes: "text",
    newscene_no: "text",
    terms_accept: "text",
    character_select: "text",
    character_back: "text",
    scene_mode_fast: "text",
    scene_mode_roleplay: "text",
    scene_access_activated: "text",
  },
  payment_errors: {
    expired: "text",
    stale: "text",
    different_scene: "text",
    subscription_active: "text",
    scene_already_unlocked: "text",
  },
  fallbacks: {
    audio_transcription_error: "send text",
  },
  web_continue: {
    message: "Continue Web dialogue?",
    button: "Continue",
  },
  maintenance: {
    message: "Maintenance",
  },
  rewards: {
    activated: "Reward activated",
    already_activated: "Reward already activated",
    unavailable: "Reward unavailable",
  },
};

export const testTelegramRuntimeSettings = {
  characterGalleryOrder: [1],
  characterVoteUrl: "https://example.com/vote",
};

export function installTestEnv(): void {
  process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
  process.env.INTERNAL_API_KEY ??= "test-internal-key";
  process.env.PUBLIC_OFFER_URL ??= "https://offer.example/terms";
  process.env.GATEWAY_PUBLIC_URL ??= "https://gateway.example";
  process.env.TG_BOT_TOKEN ??= "test-telegram-bot-token";
  process.env.TELEGRAM_API_BASE_URL ??= "https://midnight-telegram-proxy.shenko-nik.workers.dev";
  process.env.MAINTENANCE_MODE ??= "false";
  process.env.MAINTENANCE_ALLOWED_USER_IDS_JSON ??= "[]";
  process.env.TELEGRAM_CHARACTER_GALLERY_ORDER_JSON ??= JSON.stringify(
    testTelegramRuntimeSettings.characterGalleryOrder,
  );
  process.env.TELEGRAM_CHARACTER_VOTE_URL ??= testTelegramRuntimeSettings.characterVoteUrl;
}
