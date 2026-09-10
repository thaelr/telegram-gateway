import test from "node:test";
import assert from "node:assert/strict";
import { installTestEnv } from "./testEnv.js";

installTestEnv();

const {
  buildAbTestAssignmentKey,
  buildAssignment,
  chooseVariant,
  findActiveExperiment,
  loadExperimentConfigsFromEnv,
  toAbTestContext,
} = await import("../src/abTesting.js");

const experimentJson = {
  key: "subscription_offer",
  version: "v1",
  description: "Subscription copy and price",
  starts_at: "2026-09-01T00:00:00+07:00",
  ends_at: "2026-10-01T00:00:00+07:00",
  distribution: {
    A: 25,
    B: 75,
  },
  variants: {
    A: {},
    B: {
      command_offer_text: "variant B",
      plans: [
        {
          sku: "payment_plan_2",
          amount_xtr: 111,
          button_text: "B button",
        },
      ],
    },
  },
};

test("experiment env parser builds stable run identity and keeps readable version", () => {
  const [config] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify(experimentJson),
  });

  assert.equal(
    config?.assignment_key,
    "subscription_offer|2026-09-01T00:00:00+07:00",
  );
  assert.equal(config?.version, "v1");
  assert.equal(buildAbTestAssignmentKey(config!), config?.assignment_key);
});

test("experiment env parser rejects duplicate configs for same run identity", () => {
  assert.throws(
    () => loadExperimentConfigsFromEnv({
      EXP_SUBSCRIPTION_OFFER_FIRST_JSON: JSON.stringify(experimentJson),
      EXP_SUBSCRIPTION_OFFER_SECOND_JSON: JSON.stringify({
        ...experimentJson,
        version: "v2",
      }),
    }),
    /Duplicate experiment config for subscription_offer\|2026-09-01T00:00:00\+07:00/u,
  );
});

test("experiment env parser requires explicit version", () => {
  const { version: _version, ...withoutVersion } = experimentJson;

  assert.throws(
    () => loadExperimentConfigsFromEnv({
      EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify(withoutVersion),
    }),
    /Invalid experiment config EXP_SUBSCRIPTION_OFFER_SEP_JSON/u,
  );
});

test("variant selection respects configured weighted distribution", () => {
  assert.equal(chooseVariant({ A: 25, B: 75 }, () => 0), "A");
  assert.equal(chooseVariant({ A: 25, B: 75 }, () => 0.249), "A");
  assert.equal(chooseVariant({ A: 25, B: 75 }, () => 0.25), "B");
  assert.equal(chooseVariant({ A: 25, B: 75 }, () => 0.999), "B");
});

test("active experiment lookup uses date window and allows independent runs", () => {
  const configs = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_OLD_JSON: JSON.stringify({
      ...experimentJson,
      starts_at: "2026-08-01T00:00:00+07:00",
      ends_at: "2026-08-31T23:59:59+07:00",
    }),
    EXP_SUBSCRIPTION_OFFER_CURRENT_JSON: JSON.stringify(experimentJson),
  });

  assert.equal(
    findActiveExperiment(
      configs,
      "subscription_offer",
      Date.parse("2026-09-10T12:00:00+07:00"),
    )?.starts_at,
    "2026-09-01T00:00:00+07:00",
  );
  assert.equal(
    findActiveExperiment(
      configs,
      "subscription_offer",
      Date.parse("2026-10-02T00:00:00+07:00"),
    ),
    null,
  );
});

test("assignment stores only sticky group while context uses current config version", () => {
  const [config] = loadExperimentConfigsFromEnv({
    EXP_SUBSCRIPTION_OFFER_SEP_JSON: JSON.stringify(experimentJson),
  });
  const assignment = buildAssignment({
    variant: "B",
    assigned_at: "2026-09-10T10:00:00.000Z",
  });

  assert.deepEqual(assignment, {
    variant: "B",
    assigned_at: "2026-09-10T10:00:00.000Z",
  });
  assert.deepEqual(
    toAbTestContext({
      assignment_key: config!.assignment_key,
      config: config!,
      assignment,
      params: config!.variants.B ?? {},
    }),
    {
      key: "subscription_offer",
      starts_at: "2026-09-01T00:00:00+07:00",
      version: "v1",
      variant: "B",
    },
  );
});
