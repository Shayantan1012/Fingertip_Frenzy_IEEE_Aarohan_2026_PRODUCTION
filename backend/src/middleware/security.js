import { AuthSession, User, RateBucket } from "../models/index.js";
import { digest } from "../services/auth.js";
import { asyncRoute, fail } from "../services/errors.js";
export const requireAuth = asyncRoute(async (req, res, next) => {
  const token = req.cookies.aarohan_session;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    fail(401, "Your session has expired. Please log in again.");
  const session = await AuthSession.findOne({
    tokenHash: digest(token),
    expiresAt: { $gt: new Date() },
  });
  const user =
    session && (await User.findOne({ _id: session.userId, status: "ACTIVE" }));
  if (!user) fail(401, "Your session has expired. Please log in again.");
  req.user = user;
  req.authSession = session;
  next();
});
export const requireAdmin = (req, res, next) => {
  if (req.user?.role !== "ADMIN")
    return res.status(403).json({ message: "Administrator access required." });
  next();
};
export const checkOrigin = (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!process.env.APP_ORIGIN)
      return next(
        Object.assign(new Error("Application origin is not configured."), {
          status: 503,
          publicCode: "APPLICATION_ORIGIN_MISSING",
        }),
      );
    let configuredOrigin;
    try {
      // Dashboard values may contain surrounding whitespace/quotes or a slash.
      const value = process.env.APP_ORIGIN.trim().replace(
        /^(["'])(.*)\1$/,
        "$2",
      );
      const url = new URL(value);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid application origin");
      configuredOrigin = url.origin;
    } catch {
      return next(
        Object.assign(new Error("Application origin is invalid."), {
          status: 503,
          publicCode: "APPLICATION_ORIGIN_INVALID",
        }),
      );
    }
    const origin = req.headers.origin;
    if (origin !== configuredOrigin)
      return res.status(403).json({
        message: "Request origin is not permitted.",
        code: "ORIGIN_NOT_PERMITTED",
        requestId: res.get("X-Request-ID"),
      });
  }
  next();
};
export function rateLimit(group, limit, seconds = 60, identity = null) {
  return asyncRoute(async (req, res, next) => {
    const window = Math.floor(Date.now() / (seconds * 1000));
    const key = digest(
      `${group}:${identity ? identity(req) : req.user?._id || req.ip}:${window}`,
    );
    const bucket = await RateBucket.findOneAndUpdate(
      { key },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((window + 2) * seconds * 1000) },
      },
      { upsert: true, new: true },
    );
    if (bucket.count > limit) {
      res.set("Retry-After", String(seconds));
      fail(429, "Too many requests. Please wait a moment and try again.");
    }
    next();
  });
}
