import { z } from "zod";

const subscriptionPlanOverrideSchema = z.object({
  sku: z.string().min(1),
  enabled: z.boolean().optional(),
  days: z.coerce.number().int().positive().optional(),
  amount_xtr: z.coerce.number().int().positive().optional(),
  amount_rub: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  button_text: z.string().min(1).optional(),
}).strict();

const sceneUnlockOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  amount_xtr: z.coerce.number().int().positive().optional(),
  amount_rub: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  button_text: z.string().min(1).optional(),
}).strict();

const subscriptionOfferParamsSchema = z.object({
  text: z.string().min(1).optional(),
  command_offer_text: z.string().min(1).optional(),
  daily_limit_offer_text: z.string().min(1).optional(),
  plans: z.array(subscriptionPlanOverrideSchema).optional(),
  scene_unlock: sceneUnlockOverrideSchema.optional(),
}).strict();

const distributionSchema = z.record(
  z.string().min(1),
  z.coerce.number().int().nonnegative(),
).refine(
  (distribution) => Object.values(distribution).some((weight) => weight > 0),
  "distribution must contain at least one positive weight",
);

const experimentSchema = z.object({
  key: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  distribution: distributionSchema,
  variants: z.record(z.string().min(1), subscriptionOfferParamsSchema),
}).superRefine((value, ctx) => {
  if (Date.parse(value.starts_at) > Date.parse(value.ends_at)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "starts_at must be before or equal to ends_at",
      path: ["starts_at"],
    });
  }

  for (const variant of Object.keys(value.distribution)) {
    if (!(variant in value.variants)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `distribution variant ${variant} is missing from variants`,
        path: ["variants", variant],
      });
    }
  }
});

const assignmentSchema = z.object({
  variant: z.string().min(1),
  assigned_at: z.string().min(1),
}).strict();

export type SubscriptionOfferExperimentParams = z.infer<
  typeof subscriptionOfferParamsSchema
>;

export type AbTestConfig = z.infer<typeof experimentSchema> & {
  assignment_key: string;
};

export type AbTestContext = {
  key: string;
  starts_at: string;
  version: string;
  variant: string;
};

export type AbTestAssignment = z.infer<typeof assignmentSchema>;

export type AbTestSelection = {
  assignment_key: string;
  config: AbTestConfig;
  assignment: AbTestAssignment;
  params: SubscriptionOfferExperimentParams;
};

export function buildAbTestAssignmentKey(config: {
  key: string;
  starts_at: string;
}): string {
  return `${config.key}|${config.starts_at}`;
}

function parseExperimentEnv(raw: string): AbTestConfig {
  const parsed = JSON.parse(raw) as unknown;
  const config = experimentSchema.parse(parsed);

  return {
    ...config,
    assignment_key: buildAbTestAssignmentKey(config),
  };
}

export function loadExperimentConfigsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AbTestConfig[] {
  const configs = Object.entries(env)
    .filter(([key, value]) =>
      /^EXP_[A-Z0-9_]+_JSON$/u.test(key) && value != null && value.trim().length > 0)
    .map(([key, value]) => {
      try {
        return parseExperimentEnv(value ?? "");
      } catch (error) {
        throw new Error(
          `Invalid experiment config ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  const seenRunKeys = new Set<string>();
  for (const config of configs) {
    if (seenRunKeys.has(config.assignment_key)) {
      throw new Error(
        `Duplicate experiment config for ${config.assignment_key}`,
      );
    }
    seenRunKeys.add(config.assignment_key);
  }

  return configs;
}

export function findActiveExperiment(
  configs: AbTestConfig[],
  key: string,
  nowMs: number = Date.now(),
): AbTestConfig | null {
  return configs
    .filter((config) =>
      config.key === key
      && Date.parse(config.starts_at) <= nowMs
      && nowMs <= Date.parse(config.ends_at))
    .sort((left, right) => Date.parse(right.starts_at) - Date.parse(left.starts_at))
    .at(0) ?? null;
}

export function chooseVariant(
  distribution: Record<string, number>,
  random: () => number = Math.random,
): string {
  const entries = Object.entries(distribution)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const roll = Math.min(Math.max(random(), 0), 0.999999999) * total;
  let cursor = 0;

  for (const [variant, weight] of entries) {
    cursor += weight;
    if (roll < cursor) {
      return variant;
    }
  }

  return entries.at(-1)?.[0] ?? "A";
}

export function buildAssignment(input: {
  variant: string;
  assigned_at?: string;
}): AbTestAssignment {
  return {
    variant: input.variant,
    assigned_at: input.assigned_at ?? new Date().toISOString(),
  };
}

export function parseAbTestAssignment(
  value: unknown,
): AbTestAssignment | null {
  const parsed = assignmentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAbTestContext(
  selection: AbTestSelection | null,
): AbTestContext | null {
  if (!selection) {
    return null;
  }

  return {
    key: selection.config.key,
    starts_at: selection.config.starts_at,
    version: selection.config.version,
    variant: selection.assignment.variant,
  };
}
