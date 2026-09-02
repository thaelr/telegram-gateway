export const testTelegramUxCopy = {
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
    characters: {
      "1": {
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
    scene_unlock_button: "text",
    prev_button: "text",
    next_button: "text",
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
};

export function installTestEnv(): void {
  process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
  process.env.INTERNAL_API_KEY ??= "test-internal-key";
  process.env.TELEGRAM_UX_COPY_JSON ??= JSON.stringify(testTelegramUxCopy);
}
