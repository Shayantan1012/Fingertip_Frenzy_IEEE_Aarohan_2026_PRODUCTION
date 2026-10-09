import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import { serveFrontend } from "../src/web.js";

const directory = mkdtempSync(join(tmpdir(), "frenzy-web-"));
mkdirSync(join(directory, "assets"));
mkdirSync(join(directory, "game-assets", "memory"), { recursive: true });
writeFileSync(join(directory, "index.html"), '<div id="root"></div>');
writeFileSync(join(directory, "assets", "app-hash.js"), 'console.log("ready")');
writeFileSync(join(directory, "game-assets", "memory", "index.html"), "memory arena");
const app = express();
serveFrontend(app, directory);
after(() => rmSync(directory, { recursive: true, force: true }));

test("EC2 serves direct SPA navigation but never masks missing API routes or assets", async () => {
  const page = await supertest(app).get("/admin/leaderboard").expect(200);
  assert.match(page.text, /id="root"/);
  assert.match(page.headers["content-security-policy"], /script-src 'self';/);
  assert.equal(page.headers["cache-control"], "no-cache");
  for (const path of ["/api", "/api/missing", "/missing.js", "/game-assets/missing", "/assets/missing.js"])
    await supertest(app).get(path).expect(404);
});

test("EC2 preserves arena camera/WASM policy and caches only built assets immutably", async () => {
  const arena = await supertest(app).get("/game-assets/memory/index.html").expect(200);
  assert.match(arena.headers["content-security-policy"], /wasm-unsafe-eval/);
  assert.match(arena.headers["content-security-policy"], /https:\/\/storage.googleapis.com/);
  assert.equal(arena.headers["permissions-policy"], "camera=(self), microphone=()");
  assert.equal(arena.headers["cache-control"], "no-cache");
  const asset = await supertest(app).get("/assets/app-hash.js").expect(200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
});
