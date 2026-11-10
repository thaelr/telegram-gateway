import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, {
  max: 5,
  prepare: false,
});

// Existing repository helpers shared by the extracted atomic operations.
export const queryRows = async (db:Pick<typeof sql,'unsafe'>,text:string,params:any[]=[]):Promise<Record<string,any>[]> => db.unsafe(text,params);
export const toIsoTimestamp = (value:unknown) => value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
