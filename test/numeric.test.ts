import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
} from "../src/mediaCommerce/utils.js";

test("numeric normalizers accept only integer numbers and integer strings", () => {
  assert.equal(normalizePositiveInteger(123), 123);
  assert.equal(normalizePositiveInteger("123"), 123);
  assert.equal(normalizeNonNegativeInteger(123), 123);
  assert.equal(normalizeNonNegativeInteger("123"), 123);
  assert.equal(normalizeNonNegativeInteger("0"), 0);
  assert.equal(normalizeNonNegativeInteger(0), 0);
});

test("numeric normalizers reject nullish, blank, boolean, object, array, decimal, and invalid values", () => {
  const invalidValues = [
    null,
    undefined,
    "",
    "   ",
    true,
    false,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    "1.5",
    String(Number.MAX_SAFE_INTEGER + 1),
  ];

  for (const value of invalidValues) {
    assert.equal(normalizePositiveInteger(value), null);
    assert.equal(normalizeNonNegativeInteger(value), null);
  }

  assert.equal(normalizePositiveInteger(0), null);
  assert.equal(normalizePositiveInteger("0"), null);
  assert.equal(normalizePositiveInteger(-1), null);
  assert.equal(normalizePositiveInteger("-1"), null);
  assert.equal(normalizeNonNegativeInteger(-1), null);
  assert.equal(normalizeNonNegativeInteger("-1"), null);
});
