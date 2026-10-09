import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";
import { asyncRoute } from "./services/errors.js";
import {
  checkOrigin,
  requireAuth,
  requireAdmin,
} from "./middleware/security.js";
import auth from "./routes/auth.js";
import teams from "./routes/teams.js";
import games, { vortex } from "./routes/games.js";
import admin from "./routes/admin.js";
import { leaderboard } from "./services/leaderboard.js";
import {
  pagination,
  search,
  gameId,
  objectId,
  leaderboardSort,
} from "./services/validation.js";
import { ImageAsset } from "./models/index.js";
export const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({ contentSecurityPolicy: false }),
  express.json({ limit: "2mb" }),
  cookieParser(),
);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Request-ID", randomUUID());
  next();
});
// Liveness is independent of database availability; readiness below is not.
app.get("/api/health/live", (_req, res) => res.json({ status: "ok" }));
app.use(
  "/api",
  asyncRoute(async (req, res, next) => {
    await connectDB();
    next();
  }),
  checkOrigin,
);
app.get(
  "/api/assets/:id",
  asyncRoute(async (req, res) => {
    const asset = await ImageAsset.findById(
      objectId.parse(req.params.id),
    ).select("+data");
    if (!asset) return res.status(404).end();
    res
      .type(asset.mime)
      .set("Cache-Control", "public, max-age=31536000, immutable")
      .send(asset.data);
  }),
);
app.get(
  ["/api/health", "/api/health/ready"],
  asyncRoute(async (_req, res) => {
    // A connected driver alone does not prove the database can answer requests.
    await mongoose.connection.db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected" });
  }),
);
app.use("/api/auth", auth);
app.use("/api/teams", teams);
app.use("/api/games", games);
app.use("/api/admin", admin);
app.use("/api/v1", vortex);
app.get(
  "/api/leaderboard",
  requireAuth,
  requireAdmin,
  asyncRoute(async (req, res) =>
    res.json(
      await leaderboard({
        sort: leaderboardSort.parse(req.query.sort),
        ...pagination(req.query),
        search: search(req.query.search),
        game: req.query.gameId ? gameId.parse(req.query.gameId) : null,
        completedOnly: req.query.completed === "true",
      }),
    ),
  ),
);
app.use("/api", (_req, res) =>
  res.status(404).json({ message: "API endpoint not found." }),
);
app.use((err, req, res, _next) => {
  const status =
    err.name === "ZodError" || err.name === "ValidationError"
      ? 400
      : err.code === 11000
        ? 409
        : err.status || 503;
  const code =
    status >= 500
      ? err.publicCode ||
        (err.code === 13
          ? "DATABASE_PERMISSION_DENIED"
          : err.code === 20
            ? "DATABASE_TRANSACTIONS_UNSUPPORTED"
            : "SERVICE_UNAVAILABLE")
      : undefined;
  if (status >= 500) {
    // Keep logs useful without printing connection strings or participant data.
    console.error(
      JSON.stringify({
        event: "api_unavailable",
        requestId: res.get("X-Request-ID"),
        code,
      }),
    );
    res.set("Retry-After", "10");
  }
  res.status(status).json({
    message:
      status === 400
        ? "Please check your input."
        : err.code === 11000
          ? "This roll number, phone number or code is already registered."
          : status < 500
            ? err.message
            : "The service is temporarily unavailable. Please try again.",
    code,
    requestId: res.get("X-Request-ID"),
  });
});
export default app;
