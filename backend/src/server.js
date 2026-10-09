import "dotenv/config";
import { app } from "./app.js";
import mongoose from "mongoose";
import { serveFrontend } from "./web.js";
serveFrontend(app);
const server = app.listen(process.env.PORT || 5000, "0.0.0.0", () =>
  console.log("Aarohan API listening on port " + (process.env.PORT || 5000)),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 25000).unref();
  server.close(async () => {
    await mongoose.disconnect();
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
