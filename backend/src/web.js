import express from "express";
import { resolve, extname, relative, sep } from "node:path";

const common = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; ";
const mainPolicy = common + "connect-src 'self'; script-src 'self';";
const arenaPolicy = common + "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:;";

// The same-origin production server also supports direct SPA navigation.
export function serveFrontend(app, directory = resolve(import.meta.dirname, "../../frontend/dist")) {
  app.use((req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    res.set("Content-Security-Policy", req.path.startsWith("/game-assets/") ? arenaPolicy : mainPolicy);
    res.set("Permissions-Policy", "camera=(self), microphone=()");
    next();
  });
  app.use(express.static(directory, {
    dotfiles: "deny",
    setHeaders(res, file) {
      res.set("Cache-Control", relative(directory, file).startsWith(`assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  }));
  app.get("*", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/game-assets/") || req.path.startsWith("/assets/") || extname(req.path)) return next();
    res.set("Cache-Control", "no-cache").sendFile(resolve(directory, "index.html"));
  });
}
