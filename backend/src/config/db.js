import dotenv from "dotenv";
import { resolve } from "node:path";
// Load backend configuration first; retain root configuration as a fallback.
dotenv.config({ path: resolve(import.meta.dirname, "../../.env") });
dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });
import mongoose from "mongoose";
mongoose.set("bufferCommands", false);
let pending;
const databaseError = (code) =>
  Object.assign(
    new Error(
      "The database is unavailable. Please contact the event organizers.",
    ),
    {
      status: 503,
      publicCode: code,
    },
  );

// Inspect driver error codes only. Raw driver messages can contain credentials.
export function connectionErrorCode(error) {
  const errors = [];
  const seen = new Set();
  const inspect = (value, depth = 0) => {
    if (!value || depth > 8 || seen.has(value)) return;
    seen.add(value);
    errors.push(value);
    inspect(value.cause, depth + 1);
    inspect(value.reason, depth + 1);
    inspect(value.error, depth + 1);
    for (const server of value.servers?.values?.() || [])
      inspect(server.error, depth + 1);
  };
  inspect(error);
  if (errors.some((e) => e?.code === 18)) return "DATABASE_AUTH_FAILED";
  if (errors.some((e) => e?.name === "MongoParseError"))
    return "DATABASE_CONFIGURATION_INVALID";
  if (
    errors.some((e) =>
      /^(?:ERR_SSL_|ERR_TLS_|CERT_|DEPTH_ZERO_|UNABLE_TO_VERIFY_)/.test(
        e.code || "",
      ),
    )
  )
    return "DATABASE_TLS_ERROR";
  if (
    errors.some((e) =>
      ["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "ETIMEOUT", "EBADNAME", "EREFUSED"].includes(e.code),
    )
  )
    return "DATABASE_DNS_ERROR";
  if (
    errors.some(
      (e) =>
        [
          "ECONNREFUSED",
          "ETIMEDOUT",
          "ECONNRESET",
          "ENETUNREACH",
          "EHOSTUNREACH",
        ].includes(e?.code) ||
        ["MongoNetworkError", "MongoNetworkTimeoutError"].includes(e?.name),
    )
  )
    return "DATABASE_NETWORK_ERROR";
  if (
    errors.some((e) =>
      ["MongoServerSelectionError", "MongooseServerSelectionError"].includes(
        e.name,
      ),
    )
  )
    return "DATABASE_CONNECTION_TIMEOUT";
  return "DATABASE_UNAVAILABLE";
}

export async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw databaseError("DATABASE_CONFIGURATION_MISSING");
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw databaseError("DATABASE_CONFIGURATION_INVALID");
  if (!pending)
    pending = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 8000,
        // Realtime cursors share this pool with commands; leave capacity for writes.
        maxPoolSize: 40,
        waitQueueTimeoutMS: 5000,
      })
      .catch((e) => {
        throw databaseError(connectionErrorCode(e));
      })
      .finally(() => {
        // Cache only an in-flight connection, not a forever-resolved promise.
        // A warm function must reconnect after a dropped database connection.
        pending = null;
      });
  await pending;
}
export const transaction = (fn) => mongoose.connection.transaction(fn);
