import test from "node:test";
import assert from "node:assert/strict";
import { isInternalApiAuthorized } from "../src/internalApiAuth.js";

test("authorizes matching internal api key header", () => {
  const authorized = isInternalApiAuthorized(
    {
      "x-internal-api-key": "secret-key",
    },
    "x-internal-api-key",
    "secret-key",
  );

  assert.equal(authorized, true);
});

test("rejects missing or mismatched internal api key header", () => {
  assert.equal(
    isInternalApiAuthorized({}, "x-internal-api-key", "secret-key"),
    false,
  );
  assert.equal(
    isInternalApiAuthorized(
      {
        "x-internal-api-key": "wrong-key",
      },
      "x-internal-api-key",
      "secret-key",
    ),
    false,
  );
});
