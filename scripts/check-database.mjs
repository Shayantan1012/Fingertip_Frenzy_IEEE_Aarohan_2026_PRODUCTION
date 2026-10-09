import mongoose from "mongoose";
import { connectDB, connectionErrorCode } from "../backend/src/config/db.js";

// Read-only diagnostics: no collections, indexes or participant records change.
try {
  await connectDB();
  await mongoose.connection.db.command({ ping: 1 });
  const topology = await mongoose.connection.db.command({ hello: 1 });
  const transactionsSupported = Boolean(
    topology.setName || topology.msg === "isdbgrid",
  );
  console.log(
    JSON.stringify({
      status: "ok",
      database: "connected",
      transactionsSupported,
    }),
  );
  if (!transactionsSupported) process.exitCode = 1;
} catch (error) {
  const code = error.publicCode || connectionErrorCode(error);
  const hints = {
    DATABASE_CONFIGURATION_MISSING: "Set MONGODB_URI in /opt/fingertip-frenzy/.env on EC2.",
    DATABASE_CONFIGURATION_INVALID: "Use the Atlas connection string with the real database password; URL-encode special characters in the password.",
    DATABASE_AUTH_FAILED: "Check the Atlas database username and password, including any recent password reset.",
    DATABASE_DNS_ERROR: "Check the Atlas cluster hostname and DNS resolution from EC2, including SRV/TXT records.",
    DATABASE_TLS_ERROR: "Check TLS connectivity and the Atlas IP access list; do not disable TLS verification.",
    DATABASE_NETWORK_ERROR: "Check the Atlas IP access list for EC2's outbound public IP, cluster status and EC2 outbound connectivity.",
    DATABASE_CONNECTION_TIMEOUT: "Check the Atlas IP access list for EC2's outbound public IP, cluster status and EC2 outbound connectivity.",
  };
  console.error(
    JSON.stringify({
      status: "unavailable",
      code,
      hint: hints[code] || "Check the Atlas IP access list, cluster status, database credentials and DNS from EC2. Do not paste the connection string into logs.",
    }),
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
