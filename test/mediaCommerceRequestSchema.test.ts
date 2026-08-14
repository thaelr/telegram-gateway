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
