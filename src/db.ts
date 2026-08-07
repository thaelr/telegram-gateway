import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, {
  max: 5,
  prepare: false,
});
