import test from "node:test";
import assert from "node:assert/strict";
import type { AccessContext } from "../src/types.js";
import { installTestEnv } from "./testEnv.js";

installTestEnv();
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_plan_2",
    days: 14,
    amount_xtr: 111,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_PHOTO_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_media_1",
    amount_xtr: 11,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);
process.env.MEDIA_ACTION_PLANS_JSON ??= JSON.stringify([
  {
    sku: "payment_action_1",
    feature_key: "fast_scene_skip",
    amount_xtr: 55,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
  {
    sku: "payment_action_2",
    feature_key: "scene_unlock",
    amount_xtr: 80,
    title: "text",
    description: "text",
    label: "text",
    button_text: "text",
  },
]);

const { ChatAccessRepository } = await import("../src/chatAccessRepository.js");

type QueryCall = {
  strings: string[];
  values: unknown[];
};

function buildAccessContext(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    chat_id: 999001,
    source: "telegram",
    source_user_id: 777001,
    terms_accepted_at: null,
    subscription_sku: null,
    subscription_until: null,
    subscription_active: false,
    active_scene_session_id: null,
    scene_access_active: false,
    turns_today: 0,
    scene_turn_no: -1,
    selected_character_i: null,
    active_menu_screen: null,
    active_menu_message_id: null,
    ...overrides,
  };
}

test("creates and returns access-context for a completely new chat_id with one upsert query", async () => {
  const calls: QueryCall[] = [];
  const expected = buildAccessContext();

  const query = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    calls.push({
      strings: Array.from(strings),
      values,
    });
    return Promise.resolve([expected]);
  }) as unknown as ConstructorParameters<typeof ChatAccessRepository>[0];

  const repository = new ChatAccessRepository(query);
  const result = await repository.ensureAndLoadAccessContext(
    999001,
    "telegram",
    777001,
    "Europe/Moscow",
  );

  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.values.slice(0, 3), [999001, "telegram", 777001]);

  const sqlText = calls[0]?.strings.join(" ");
  assert.match(sqlText ?? "", /INSERT INTO public\.chat_state/u);
  assert.match(sqlText ?? "", /ON CONFLICT \(chat_id\) DO UPDATE/u);
  assert.match(sqlText ?? "", /RETURNING/u);
  assert.doesNotMatch(sqlText ?? "", /DO NOTHING/u);
});
