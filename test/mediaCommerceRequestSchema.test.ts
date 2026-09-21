import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";
process.env.INTERNAL_API_KEY ??= "test-internal-key";

const { mediaCommerceRequestSchema } = await import(
  "../src/mediaCommerce/requestSchema.js"
);

test("media commerce request schema accepts zero and positive turn counters", () => {
  const zeroParsed = mediaCommerceRequestSchema.safeParse({
    chat_id: "101",
    turn_no: "0",
    scene_turn_no: "0",
  });
  assert.equal(zeroParsed.success, true);
  if (zeroParsed.success) {
    assert.equal(zeroParsed.data.chat_id, 101);
    assert.equal(zeroParsed.data.turn_no, 0);
    assert.equal(zeroParsed.data.scene_turn_no, 0);
  }

  const positiveParsed = mediaCommerceRequestSchema.safeParse({
    chat_id: 101,
    turn_no: 5,
    scene_turn_no: 3,
  });
  assert.equal(positiveParsed.success, true);
  if (positiveParsed.success) {
    assert.equal(positiveParsed.data.turn_no, 5);
    assert.equal(positiveParsed.data.scene_turn_no, 3);
  }
});

test("media commerce request schema rejects unsafe numeric coercions", () => {
  const invalidValues = ["", "   ", true, false, 1.5, "1.5", -1, "-1"];

  for (const value of invalidValues) {
    const parsed = mediaCommerceRequestSchema.safeParse({
      chat_id: value,
    });
    assert.equal(parsed.success, false);
  }
});

test("media commerce request schema preserves nullable and optional numeric fields", () => {
  const parsed = mediaCommerceRequestSchema.safeParse({
    chat_id: null,
    turn_no: undefined,
    scene_turn_no: null,
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.chat_id, null);
    assert.equal(parsed.data.turn_no, undefined);
    assert.equal(parsed.data.scene_turn_no, null);
  }
});
