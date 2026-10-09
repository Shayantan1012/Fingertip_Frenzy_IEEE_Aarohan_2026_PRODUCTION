import mongoose from "mongoose";
import { GameSession } from "../backend/src/models/index.js";
import { connectDB, connectionErrorCode } from "../backend/src/config/db.js";
let stream;
try {
  await connectDB();
  // Read-only capability/permission check; no event or participant data is printed.
  stream = mongoose.connection.db.watch(
    [{ $match: { "ns.coll": GameSession.collection.name } }],
    { maxAwaitTimeMS: 500 },
  );
  await stream.tryNext();
  console.log(JSON.stringify({ status: "ok", changeStreams: "available" }));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "unavailable",
      code:
        error.code === 13
          ? "DATABASE_CHANGE_STREAM_PERMISSION_DENIED"
          : error.publicCode || connectionErrorCode(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await stream?.close().catch(() => {});
  await mongoose.disconnect();
}
