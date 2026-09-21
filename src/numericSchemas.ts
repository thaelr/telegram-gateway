import { z } from "zod";
import { parseIntegerInput } from "./numeric.js";

function preprocessIntegerInput(value: unknown): unknown {
  const parsed = parseIntegerInput(value);
  return parsed ?? value;
}

export const integerInputSchema = z.preprocess(
  preprocessIntegerInput,
  z.number().int(),
);

export const positiveIntegerInputSchema = integerInputSchema.refine(
  (value) => value > 0,
  { message: "Expected positive integer" },
);

export const nonNegativeIntegerInputSchema = integerInputSchema.refine(
  (value) => value >= 0,
  { message: "Expected non-negative integer" },
);
