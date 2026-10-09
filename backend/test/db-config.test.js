import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionErrorCode } from "../src/config/db.js";

const selectionError = (error) => ({
  name: "MongooseServerSelectionError",
  reason: { servers: new Map([["private-host", { error }]]) },
});

test("Atlas errors retain actionable classifications through nested driver causes", () => {
  const cases = [
    [{ code: 18 }, "DATABASE_AUTH_FAILED"],
    [{ name: "MongoParseError" }, "DATABASE_CONFIGURATION_INVALID"],
    [{ code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" }, "DATABASE_TLS_ERROR"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "DATABASE_TLS_ERROR"],
    [{ code: "ENOTFOUND" }, "DATABASE_DNS_ERROR"],
    [{ code: "ENODATA" }, "DATABASE_DNS_ERROR"],
    [{ code: "ETIMEOUT", syscall: "querySrv" }, "DATABASE_DNS_ERROR"],
    [{ code: "EREFUSED", syscall: "queryTxt" }, "DATABASE_DNS_ERROR"],
    [{ code: "ECONNREFUSED" }, "DATABASE_NETWORK_ERROR"],
    [{ name: "MongoNetworkTimeoutError" }, "DATABASE_NETWORK_ERROR"],
  ];
  for (const [cause, expected] of cases) {
    const failure = selectionError({ name: "MongoNetworkError", cause });
    assert.equal(connectionErrorCode(failure), expected);
  }
  assert.equal(
    connectionErrorCode(selectionError(null)),
    "DATABASE_CONNECTION_TIMEOUT",
  );
});

test("Database diagnostics never contain raw messages, hosts or credentials", () => {
  const error = {
    message:
      "mongodb+srv://private-user:private-password@private-host/secret-db",
  };
  error.cause = error;
  const code = connectionErrorCode(error);
  assert.equal(code, "DATABASE_UNAVAILABLE");
  assert.ok(!code.includes("private"));
});
