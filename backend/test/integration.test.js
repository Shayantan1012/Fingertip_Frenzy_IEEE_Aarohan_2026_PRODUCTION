import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import supertest from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import * as models from "../src/models/index.js";
import { connectDB } from "../src/config/db.js";
import { hashPassword } from "../src/services/auth.js";
import {
  satisfies,
  initializeCalculator,
} from "../src/game-services/calculator.js";
import { defaults } from "../src/game-services/config.js";
import { detectiveData } from "../src/services/content.js";
import { getCurrent, startGame } from "../src/services/games.js";
import {
  hasSequentialTileAssets,
  refreshPuzzleAssets,
} from "../src/services/images.js";
let mongo, admin, players, team;
const origin = "http://localhost:5173";
const call = (agent, method, path, body) =>
  agent[method]("/api" + path)
    .set("Origin", origin)
    .send(body);
before(
  async () => {
    process.env.APP_ORIGIN = origin;
    process.env.NODE_ENV = "test";
    process.env.MONGOMS_DOWNLOAD_DIR = resolve(".cache/mongodb");
    mongo = await MongoMemoryReplSet.create({
      binary: { downloadDir: resolve(".cache/mongodb") },
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    process.env.MONGODB_URI = mongo.getUri("aarohan_test");
    await connectDB();
    for (const m of Object.values(models)) {
      await m.createCollection();
      await m.createIndexes();
    }
    admin = supertest.agent(app);
    await models.User.create({
      name: "Test Administrator",
      email: "test-admin@example.test",
      role: "ADMIN",
      passwordHash: hashPassword("test-only-password-123"),
    });
    players = Array.from({ length: 4 }, () => supertest.agent(app));
    const r = await call(admin, "post", "/auth/admin/login", {
      email: "test-admin@example.test",
      password: "test-only-password-123",
    });
    assert.equal(r.status, 200);
  },
  { timeout: 1200000 },
);
after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("QA: hint costs purchased at zero remain payable from later answers", async () => {
  const user = await models.User.findOne({ role: "ADMIN" });
  const content = await models.Content.create({
    gameId: "detective",
    title: "Penalty QA",
    published: true,
    order: 0,
    data: {
      description: "QA",
      difficulty: "Easy",
      clues: [],
      suspects: [],
      questions: [
        {
          id: "penalty-q",
          question: "Choose A",
          options: ["A", "B"],
          correctAnswerIndex: 0,
          points: 100,
        },
      ],
      hints: [{ id: "penalty-h", hintText: "A", penalty: 25, enabled: true }],
    },
  });
  const doc = await models.GameSession.create({
    scope: `admin:${user._id}`,
    gameId: "detective",
    userId: user._id,
    testMode: true,
    attempt: 9000,
    startedAt: new Date(),
    maximum: 100,
    config: defaults.detective,
    state: {
      case: { ...content.data, id: String(content._id), title: content.title },
      index: 0,
      answers: [],
      hintsUsed: [],
      expiresAt: null,
    },
  });
  try {
    assert.equal(
      (
        await call(admin, "post", "/v1/detective/use-hint", {
          hintId: "penalty-h",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(admin, "post", "/v1/detective/use-hint", {
          hintId: "penalty-h",
        })
      ).body.penaltyDeducted,
      0,
    );
    const answer = await call(admin, "post", "/v1/detective/submit-answer", {
      questionId: "penalty-q",
      selectedOptionIndex: 0,
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.newScore, 75);
  } finally {
    await models.GameSession.deleteOne({ _id: doc._id });
    await models.Content.deleteOne({ _id: content._id });
  }
});

test("QA: Memory attempts are isolated by team with same-team legacy compatibility", async () => {
  const user = await models.User.create({
    name: "Moved Memory QA",
    rollNo: "QAMOVE",
    phoneNo: "9876500001",
    email: "qa-move@example.test",
  });
  const teams = await models.Team.create([
    {
      name: "Old memory QA",
      code: "FF-111111111111",
      leaderId: user._id,
      memberIds: [user._id],
    },
    {
      name: "New memory QA",
      code: "FF-222222222222",
      leaderId: user._id,
      memberIds: [user._id],
    },
  ]);
  user.teamId = teams[0]._id;
  await user.save();
  for (const t of teams)
    for (const gameId of ["puzzle", "detective", "calculator"])
      await models.Result.create({
        sessionId: new mongoose.Types.ObjectId(),
        teamId: t._id,
        userId: user._id,
        gameId,
        valid: true,
        score: 0,
        maximum: 100,
      });
  const legacy = await models.GameSession.create({
    scope: String(user._id),
    userId: user._id,
    teamId: teams[0]._id,
    gameId: "memory",
    attempt: 1,
    status: "COMPLETED",
    startedAt: new Date(),
    state: { stage: 3, stages: [], active: null },
    config: defaults.memory,
    maximum: 18,
    score: 18,
  });
  await models.GameSession.updateOne(
    { _id: legacy._id },
    { $unset: { testMode: 1 } },
  );
  try {
    assert.equal(
      String((await getCurrent("memory", user)).doc._id),
      String(legacy._id),
    );
    user.teamId = teams[1]._id;
    await user.save();
    assert.equal((await getCurrent("memory", user)).doc, null);
    await models.Result.create({
      sessionId: new mongoose.Types.ObjectId(),
      teamId: teams[1]._id,
      userId: user._id,
      gameId: "calculator",
      valid: true,
      score: 0,
      maximum: 100,
    });
    const fresh = await startGame("memory", user);
    assert.equal(fresh.attempt, 1);
    assert.equal(String(fresh.teamId), String(teams[1]._id));
  } finally {
    await models.GameSession.deleteMany({ userId: user._id });
    await models.Result.deleteMany({ userId: user._id });
    await models.Team.deleteMany({ _id: { $in: teams.map((t) => t._id) } });
    await models.User.deleteOne({ _id: user._id });
  }
});

test("QA: Detective content rejects broken evidence and hint relationships", () => {
  const valid = {
    description: "QA",
    difficulty: "Easy",
    clues: [
      {
        id: "c",
        title: "Clue",
        description: "Proof",
        evidence: "Text",
        evidenceType: "text",
      },
    ],
    questions: [
      {
        id: "q",
        question: "Question",
        options: ["A", "B"],
        correctAnswerIndex: 0,
        points: 100,
        clueId: "c",
      },
    ],
    hints: [{ id: "h", questionId: "q", hintText: "Hint", penalty: 25 }],
  };
  assert.equal(detectiveData.safeParse(valid).success, true);
  assert.equal(
    detectiveData.safeParse({
      ...valid,
      clues: [...valid.clues, ...valid.clues],
    }).success,
    false,
  );
  assert.equal(
    detectiveData.safeParse({
      ...valid,
      questions: [{ ...valid.questions[0], clueId: "missing" }],
    }).success,
    false,
  );
  assert.equal(
    detectiveData.safeParse({
      ...valid,
      hints: [{ ...valid.hints[0], questionId: "missing" }],
    }).success,
    false,
  );
});

test("QA: exports match displayed pagination, search and deleted-record visibility", async () => {
  const teams = await models.Team.create(
    Array.from({ length: 26 }, (_, i) => ({
      name: `Export QA ${String(i).padStart(2, "0")}`,
      code: `FF-${(1000 + i).toString(16).toUpperCase().padStart(12, "0")}`,
      status: i === 0 ? "DELETED" : "ACTIVE",
    })),
  );
  try {
    const query = "?page=2&limit=10&search=Export%20QA";
    const shown = await admin.get("/api/admin/teams" + query);
    const exported = await admin.get("/api/admin/export/teams" + query);
    assert.equal(shown.status, 200);
    assert.equal(exported.status, 200);
    const lines = exported.text.trim().split("\r\n").slice(1);
    assert.equal(lines.length, shown.body.rows.length);
    for (const row of shown.body.rows)
      assert.ok(exported.text.includes(row.name));
    assert.ok(!exported.text.includes("Export QA 00"));
    const empty = await admin.get(
      "/api/admin/export/leaderboard?search=does-not-exist-qa&completed=true",
    );
    assert.equal(empty.text.trim().split("\r\n").length, 1);
  } finally {
    await models.Team.deleteMany({ _id: { $in: teams.map((t) => t._id) } });
  }
});

test("QA: schedule compares instants rather than timestamp formatting", async () => {
  const response = await call(admin, "patch", "/admin/games/memory/settings", {
    ...defaults.memory,
    startAt: "2026-10-08T12:00:00.000Z",
    endAt: "2026-10-08T12:00:00Z",
  });
  try {
    assert.equal(response.status, 400);
  } finally {
    await models.GameSetting.deleteOne({ gameId: "memory" });
  }
});

test("QA: reading game state never starts attempts, renews leases or writes expired results", async () => {
  const user = await models.User.findOne({ role: "ADMIN" });
  const content = await models.Content.create({
    gameId: "detective",
    title: "Read-only QA",
    published: true,
    order: 0,
    data: {
      description: "QA",
      difficulty: "Easy",
      suspects: [],
      clues: [],
      questions: [
        {
          id: "q",
          question: "Q",
          options: ["A", "B"],
          correctAnswerIndex: 0,
          points: 100,
        },
      ],
      hints: [],
    },
  });
  try {
    const before = await models.GameSession.countDocuments();
    assert.equal((await admin.get("/api/v1/detective/case")).status, 200);
    await admin.get("/api/games/calculator/state");
    assert.equal(await models.GameSession.countDocuments(), before);
    assert.equal(await models.CalculatorPresence.countDocuments(), 0);
    const expired = await models.GameSession.create({
      scope: `admin:${user._id}`,
      gameId: "puzzle",
      userId: user._id,
      testMode: false,
      attempt: 9001,
      startedAt: new Date(Date.now() - 10000),
      maximum: 100,
      state: {
        expiresAt: Date.now() - 1000,
        index: 0,
        puzzles: [],
        attempts: [],
      },
      config: defaults.puzzle,
    });
    await getCurrent("puzzle", user);
    assert.equal(
      (await models.GameSession.findById(expired._id)).status,
      "IN_PROGRESS",
    );
    assert.equal(
      await models.Result.countDocuments({ sessionId: expired._id }),
      0,
    );
    assert.equal(
      (await call(admin, "post", "/v1/game/r1/sync", {})).status,
      200,
    );
    assert.equal(
      (await call(admin, "post", "/v1/game/r1/sync", {})).status,
      200,
    );
    assert.equal(
      (await models.GameSession.findById(expired._id)).status,
      "COMPLETED",
    );
    assert.equal(
      await models.Result.countDocuments({ sessionId: expired._id }),
      1,
    );
    await models.Result.deleteOne({ sessionId: expired._id });
  } finally {
    await models.GameSession.deleteMany({ scope: `admin:${user._id}` });
    await models.CalculatorPresence.deleteMany({ userId: user._id });
    await models.Content.deleteOne({ _id: content._id });
  }
});

test("QA: partial legacy settings retain finite leaderboard weights", async () => {
  await models.GameSetting.create({
    gameId: "memory",
    config: { enabled: true },
  });
  const team = await models.Team.create({
    name: "Partial weight QA",
    code: "FF-333333333333",
    memberIds: [],
  });
  const result = await models.Result.create({
    sessionId: new mongoose.Types.ObjectId(),
    teamId: team._id,
    gameId: "memory",
    userId: new mongoose.Types.ObjectId(),
    valid: true,
    score: 10,
    maximum: 10,
    completionTime: 1,
    completedAt: new Date(),
  });
  await models.Team.updateOne(
    { _id: team._id },
    { $set: { memberIds: [result.userId] } },
  );
  try {
    const response = await admin.get(
      "/api/admin/leaderboard?search=Partial%20weight%20QA",
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.rows[0].total, 250);
  } finally {
    await models.GameSetting.deleteOne({ gameId: "memory" });
    await models.Result.deleteOne({ _id: result._id });
    await models.Team.deleteOne({ _id: team._id });
  }
});

const identity = (i) => ({
  name: "Test Student " + i,
  rollNo: "24CS10" + i,
  phoneNo: "987654320" + i,
  email: "student" + i + "@example.test",
});

test("QA: legacy puzzle asset refresh preserves tile content and answer identities", async () => {
  const assets = await models.ImageAsset.create(
    Array.from({ length: 4 }, (_, i) => ({
      // Explicit legacy IDs keep this fixture stable across clock-second boundaries.
      _id: new mongoose.Types.ObjectId(
        `000000000000000001${i.toString(16).padStart(6, "0")}`,
      ),
      data: Buffer.from(`tile-${i}`),
      mime: "image/jpeg",
    })),
  );
  const data = {
    pieces: assets.map((asset, i) => ({
      pieceId: `piece-${i}`,
      imageUrl: `/api/assets/${asset._id}`,
    })),
    correctOrder: ["piece-0", "piece-1", "piece-2", "piece-3"],
  };
  assert.equal(hasSequentialTileAssets(data), true);
  let refreshed;
  await mongoose.connection.transaction(async (tx) => {
    refreshed = await refreshPuzzleAssets(data, tx);
  });
  assert.equal(hasSequentialTileAssets(refreshed), false);
  assert.deepEqual(refreshed.correctOrder, data.correctOrder);
  for (const [i, piece] of refreshed.pieces.entries()) {
    assert.equal(piece.pieceId, data.pieces[i].pieceId);
    const copy = await models.ImageAsset.findById(
      piece.imageUrl.split("/").pop(),
    ).select("+data");
    assert.equal(copy.data.toString(), `tile-${i}`);
    assert.ok(
      await models.ImageAsset.exists({ _id: assets[i]._id }),
      "Cached image URLs remain usable",
    );
  }
});

test("QA: asset migration is dry-run by default, blocks active play and is idempotent", async () => {
  const assets = await models.ImageAsset.create(
    Array.from({ length: 4 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(
        `000000000000000002${i.toString(16).padStart(6, "0")}`,
      ),
      data: Buffer.from("migration-tile"),
      mime: "image/jpeg",
    })),
  );
  const content = await models.Content.create({
    gameId: "puzzle",
    title: "Migration QA",
    published: false,
    data: {
      pieces: assets.map((asset, i) => ({
        pieceId: `migration-${i}`,
        imageUrl: `/api/assets/${asset._id}`,
      })),
      correctOrder: assets.map((_, i) => `migration-${i}`),
    },
  });
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/refresh-puzzle-assets.mjs"), ...args],
      {
        env: { ...process.env, MONGODB_URI: mongo.getUri("aarohan_test") },
        encoding: "utf8",
      },
    );
  const audit = run();
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).legacyPuzzles, 1);
  assert.equal(
    hasSequentialTileAssets((await models.Content.findById(content._id)).data),
    true,
  );
  const active = await models.GameSession.create({
    scope: "migration-qa",
    gameId: "puzzle",
    status: "IN_PROGRESS",
    testMode: false,
    attempt: 1,
  });
  const blocked = run("--apply");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Finish or reset/);
  await models.GameSession.deleteOne({ _id: active._id });
  const apply = run("--apply");
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).refreshed, 1);
  assert.equal(
    hasSequentialTileAssets((await models.Content.findById(content._id)).data),
    false,
  );
  assert.ok(
    await models.Audit.exists({
      action: "SYSTEM_REFRESH_PUZZLE_ASSETS",
      entityId: String(content._id),
    }),
  );
  assert.equal(JSON.parse(run("--apply").stdout).refreshed, 0);
  await models.Content.deleteOne({ _id: content._id });
});
let otherCode;
test("Database failures are diagnosed safely and warm functions reconnect", async () => {
  const uri = process.env.MONGODB_URI;
  try {
    await mongoose.disconnect();
    process.env.MONGODB_URI = "";
    assert.equal((await supertest(app).get("/api/health/live")).status, 200);
    const unavailable = await supertest(app).get("/api/health/ready");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.code, "DATABASE_CONFIGURATION_MISSING");
    assert.equal(unavailable.headers["retry-after"], "10");
    assert.ok(unavailable.body.requestId);
    for (const path of ["/auth/login", "/auth/register"]) {
      const response = await call(supertest(app), "post", path, {});
      assert.equal(response.status, 503);
      assert.equal(response.body.code, "DATABASE_CONFIGURATION_MISSING");
    }
    process.env.MONGODB_URI =
      "https://secret-user:secret-password@example.test";
    const invalid = await supertest(app).get("/api/health");
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.code, "DATABASE_CONFIGURATION_INVALID");
    assert.ok(!JSON.stringify(invalid.body).includes("secret-"));
    process.env.MONGODB_URI = uri;
    await Promise.all([connectDB(), connectDB(), connectDB()]);
    assert.equal((await supertest(app).get("/api/health/ready")).status, 200);
    // Regression: the old resolved pending promise prevented this reconnect.
    await mongoose.disconnect();
    await Promise.all([connectDB(), connectDB()]);
    const recovered = await supertest(app).get("/api/health");
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.database, "connected");
    const configuredOrigin = process.env.APP_ORIGIN;
    try {
      delete process.env.APP_ORIGIN;
      const blocked = await call(supertest(app), "post", "/auth/login", {});
      assert.equal(blocked.status, 503);
      assert.equal(blocked.body.code, "APPLICATION_ORIGIN_MISSING");
      assert.ok(blocked.body.requestId);
    } finally {
      process.env.APP_ORIGIN = configuredOrigin;
    }
  } finally {
    process.env.MONGODB_URI = uri;
    await connectDB();
  }
});
test("Origin configuration tolerates formatting but still rejects other sites", async () => {
  const configuredOrigin = process.env.APP_ORIGIN;
  try {
    for (const value of [origin, origin + "/", `  "${origin}/"  `]) {
      process.env.APP_ORIGIN = value;
      assert.equal(
        (await call(supertest(app), "post", "/auth/logout", {})).status,
        200,
      );
    }
    const rejected = await supertest(app)
      .post("/api/auth/login")
      .set("Origin", "https://untrusted.example.test")
      .set("X-Forwarded-Host", "untrusted.example.test")
      .send({});
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, "ORIGIN_NOT_PERMITTED");
    assert.ok(rejected.body.requestId);
    process.env.APP_ORIGIN = origin + "/login";
    const invalid = await call(supertest(app), "post", "/auth/login", {});
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.code, "APPLICATION_ORIGIN_INVALID");
  } finally {
    process.env.APP_ORIGIN = configuredOrigin;
  }
});
test("Leader registration creates unique team atomically; five-field login, logout and expiry", async () => {
  const registered = await call(players[0], "post", "/auth/register", {
    ...identity(0),
    teamName: "Integration Team",
  });
  assert.equal(registered.status, 201);
  assert.match(registered.body.team.code, /^FF-[A-F0-9]{12}$/);
  team = registered.body.team;
  assert.equal(
    (
      await call(players[0], "post", "/auth/register", {
        ...identity(0),
        teamName: "Duplicate",
      })
    ).status,
    409,
  );
  assert.equal(await models.Team.countDocuments({ name: "Duplicate" }), 0);
  assert.equal(
    (
      await call(players[0], "post", "/auth/login", {
        ...identity(0),
        teamCode: team.code,
        email: "wrong@example.test",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(players[0], "post", "/auth/login", {
        rollNo: identity(0).rollNo,
        phoneNo: identity(0).phoneNo,
      })
    ).status,
    400,
  );
  const login = await call(players[0], "post", "/auth/login", {
    ...identity(0),
    teamCode: team.code,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "TEAM_LEADER");
  assert.match(login.headers["set-cookie"][0], /HttpOnly/);
  assert.ok(!login.body.token);
  team = (await players[0].get("/api/teams/me")).body.team;
  assert.equal(
    (
      await supertest(app)
        .post("/api/auth/register")
        .send({ ...identity(4), teamName: "Origin blocked" })
    ).status,
    403,
  );
  assert.equal((await players[0].get("/api/admin/teams")).status, 403);
  const other = await call(players[3], "post", "/auth/register", {
    ...identity(3),
    teamName: "Other Team",
  });
  assert.equal(other.status, 201);
  otherCode = other.body.team.code;
  await call(players[3], "post", "/auth/login", {
    ...identity(3),
    teamCode: otherCode,
  });
  await call(players[3], "post", "/auth/logout", {});
  assert.equal((await players[3].get("/api/auth/me")).status, 401);
  await call(players[3], "post", "/auth/login", {
    ...identity(3),
    teamCode: otherCode,
  });
  const u = await models.User.findOne({ rollNo: identity(3).rollNo });
  await models.AuthSession.updateMany(
    { userId: u._id },
    { $set: { expiresAt: new Date(0) } },
  );
  assert.equal((await players[3].get("/api/auth/me")).status, 401);
  await call(players[3], "post", "/auth/login", {
    ...identity(3),
    teamCode: otherCode,
  });
});
test("Teammates join only through full login; membership, capacity and roster locks hold", async () => {
  assert.equal(
    (await call(players[0], "post", "/teams", { name: "Bypass" })).status,
    410,
  );
  assert.equal(
    (
      await call(players[1], "post", "/auth/login", {
        ...identity(1),
        teamCode: "FF-000000000000",
      })
    ).status,
    401,
  );
  assert.equal(
    await models.User.countDocuments({ rollNo: identity(1).rollNo }),
    0,
  );
  for (let i = 1; i <= 2; i++)
    assert.equal(
      (
        await call(players[i], "post", "/auth/login", {
          ...identity(i),
          teamCode: team.code,
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call(supertest.agent(app), "post", "/auth/login", {
        ...identity(4),
        teamCode: team.code,
      })
    ).status,
    409,
  );
  assert.equal(
    await models.User.countDocuments({ rollNo: identity(4).rollNo }),
    0,
  );
  assert.equal(
    (
      await call(players[3], "post", "/auth/login", {
        ...identity(3),
        teamCode: team.code,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(players[1], "patch", "/teams/me", {
        name: "Unauthorized rename",
      })
    ).status,
    403,
  );
  assert.equal(
    (await players[0].get("/api/teams/me")).body.team.members.length,
    3,
  );
  const rounds = (await players[0].get("/api/games")).body.games;
  assert.equal(
    (await call(players[0], "patch", "/teams/me", { name: "Leader rename" }))
      .status,
    403,
  );
  assert.deepEqual(
    rounds.map((round) => round.id),
    ["puzzle", "detective", "calculator", "memory"],
  );
  assert.deepEqual(
    rounds.map((round) => round.locked),
    [false, true, true, true],
  );
  assert.equal(
    (await call(players[0], "post", "/games/memory/start", {})).status,
    403,
  );
});
test("Original Puzzle mechanics, server-side answer check, single completion and replay guard", async () => {
  const pieces = [0, 1, 2, 3].map((i) => ({
    pieceId: `piece${i}`,
    imageUrl: `https://example.test/${i}.png`,
  }));
  const r = await call(admin, "post", "/admin/games/puzzle/content", {
    title: "Test-only puzzle fixture",
    published: true,
    order: 0,
    data: {
      description: "Test fixture",
      imageUrl: "https://example.test/source.png",
      gridRows: 2,
      gridCols: 2,
      points: 100,
      timeLimitSeconds: 300,
      hint: "",
      pieces,
      correctOrder: pieces.map((p) => p.pieceId),
    },
  });
  assert.equal(r.status, 201);
  assert.equal(
    (await call(players[1], "post", "/v1/game/r1/start", {})).status,
    403,
  );
  assert.equal(
    (await call(players[0], "post", "/v1/game/r1/start", {})).status,
    200,
  );
  const state = await players[0].get("/api/v1/game/r1/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.currentPuzzle.correctOrder, undefined);
  const body = {
    puzzleId: r.body._id,
    pieceOrder: pieces.map((p) => p.pieceId),
  };
  assert.equal(
    (
      await call(players[0], "post", "/v1/game/r1/submit", {
        ...body,
        pieceOrder: ["piece0", "piece0", "piece2", "piece3"],
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(players[0], "post", "/v1/game/r1/submit", body)).body
      .isRoundCompleted,
    true,
  );
  assert.equal(
    (await call(players[0], "post", "/v1/game/r1/submit", body)).status,
    409,
  );
  assert.equal((await models.Result.findOne({ gameId: "puzzle" })).score, 100);
});
test("Puzzle completion automatically unlocks Detective for every teammate", async () => {
  for (const player of players.slice(0, 3)) {
    const cards = (await player.get("/api/games")).body.games;
    assert.equal(cards.find((g) => g.id === "detective").locked, false);
    assert.equal(cards.find((g) => g.id === "calculator").locked, true);
  }
});
test("Detective hides answers/hints and rejects question replay and out-of-order answers", async () => {
  const r = await call(admin, "post", "/admin/games/detective/content", {
    title: "Test-only case fixture",
    published: true,
    order: 0,
    data: {
      description: "Test fixture",
      difficulty: "Medium",
      suspects: [],
      clues: [],
      questions: [
        {
          id: "q1",
          question: "Test question?",
          options: ["A", "B"],
          correctAnswerIndex: 1,
          points: 100,
        },
        {
          id: "q2",
          question: "Second?",
          options: ["A", "B"],
          correctAnswerIndex: 0,
          points: 100,
        },
      ],
      hints: [{ id: "h1", hintText: "Test hint", penalty: 20, enabled: true }],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(
    (await call(players[0], "post", "/v1/detective/start", {})).status,
    200,
  );
  const state = await players[0].get("/api/v1/detective/case");
  assert.equal(state.status, 200);
  assert.equal(state.body.questions[0].correctAnswerIndex, undefined);
  assert.equal(state.body.hints[0].hintText, undefined);
  assert.equal(
    (
      await call(players[0], "post", "/v1/detective/submit-answer", {
        questionId: "q2",
        selectedOptionIndex: 0,
      })
    ).status,
    409,
  );
  await call(players[0], "post", "/v1/detective/submit-answer", {
    questionId: "q1",
    selectedOptionIndex: 1,
  });
  const hint = await call(players[0], "post", "/v1/detective/use-hint", {
    hintId: "h1",
  });
  assert.equal(hint.body.currentScore, 80);
  assert.equal(
    (await call(players[0], "post", "/v1/detective/use-hint", { hintId: "h1" }))
      .body.currentScore,
    80,
  );
  assert.equal(
    (
      await call(players[0], "post", "/v1/detective/submit-answer", {
        questionId: "q1",
        selectedOptionIndex: 1,
      })
    ).status,
    409,
  );
  await call(players[0], "post", "/v1/detective/submit-answer", {
    questionId: "q2",
    selectedOptionIndex: 0,
  });
  assert.equal(
    (await models.Result.findOne({ gameId: "detective" })).score,
    180,
  );
});
test("Detective completion automatically unlocks Calculator", async () => {
  assert.equal(
    (await players[0].get("/api/games")).body.games.find(
      (g) => g.id === "calculator",
    ).locked,
    false,
  );
});
test("Three independent Calculator sessions synchronize concurrent digits, tolerate jitter and recover offline teammates", async () => {
  const peers = players.slice(0, 3);
  const initial = await Promise.all(
    peers.map((p) => call(p, "post", "/games/calculator/sync", {})),
  );
  for (const r of initial) assert.equal(r.status, 200, JSON.stringify(r.body));
  const sameAttempt = new Set(initial.map((r) => r.body.sessionId));
  assert.equal(sameAttempt.size, 1);
  assert.equal(
    await models.GameSession.countDocuments({ gameId: "calculator" }),
    1,
  );
  const ready = await Promise.all(
    peers.map((p) => call(p, "post", "/games/calculator/sync", {})),
  );
  for (const r of ready) assert.ok(r.body.players.every((p) => p.online));
  const revision = ready[0].body.revision;
  for (let i = 0; i < 3; i++) {
    const poll = await Promise.all(
      peers.map((p) => call(p, "post", "/games/calculator/sync", {})),
    );
    for (const r of poll)
      assert.equal(
        r.body.revision,
        revision,
        "Heartbeat must not rewrite shared game state",
      );
  }
  const doc = await models.GameSession.findOne({ gameId: "calculator" });
  doc.state.phase = "PLAYING";
  doc.state.deadline = Date.now() + 40000;
  doc.state.question = {
    ...doc.state.question,
    expr: "X+Y+Z",
    target: 27,
    con: null,
  };
  doc.markModified("state");
  await doc.save();
  const events = await Promise.all(
    peers.map((p, i) =>
      call(p, "post", "/games/calculator/event", {
        type: "digit",
        digit: i + 2,
        conf: 1,
        questionId: doc.state.question.id,
        sessionId: String(doc._id),
      }),
    ),
  );
  for (const r of events) assert.equal(r.status, 200, JSON.stringify(r.body));
  const expected = Object.fromEntries(
    events.map((r, i) => [r.body.you.role, i + 2]),
  );
  // An eight-second gap exceeded the old lease; all three remain online now.
  await models.CalculatorPresence.updateMany(
    { sessionId: doc._id },
    { $set: { expiresAt: new Date(Date.now() + 22000) } },
  );
  const synced = await Promise.all(
    peers.map((p) => call(p, "post", "/games/calculator/sync", {})),
  );
  for (const r of synced) {
    assert.deepEqual(r.body.values, expected);
    assert.equal(r.body.paused, false);
    assert.ok(r.body.players.every((p) => p.online));
  }
  const offlineId = synced[2].body.you.id;
  await models.CalculatorPresence.updateOne(
    { sessionId: doc._id, userId: offlineId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const paused = await call(peers[0], "post", "/games/calculator/sync", {});
  assert.equal(paused.body.paused, true);
  assert.deepEqual(paused.body.values, expected);
  const resumed = await call(peers[2], "post", "/games/calculator/sync", {});
  assert.equal(resumed.body.paused, false);
  assert.deepEqual(resumed.body.values, expected);
  const stale = await call(peers[0], "post", "/games/calculator/event", {
    type: "digit",
    digit: 9,
    conf: 1,
    questionId: doc.state.question.id,
    sessionId: "old-attempt",
  });
  assert.equal(stale.status, 409);
  const clear = await call(peers[0], "post", "/games/calculator/event", {
    type: "digit",
    digit: null,
    conf: 0,
    questionId: doc.state.question.id,
    sessionId: String(doc._id),
  });
  delete expected[clear.body.you.role];
  for (const p of peers)
    assert.deepEqual(
      (await call(p, "post", "/games/calculator/sync", {})).body.values,
      expected,
    );
});

test("Calculator shared team state and equation scoring are authoritative in MongoDB", async () => {
  let users = await models.User.find({ teamId: team._id }).sort({ rollNo: 1 });
  await call(players[0], "post", "/games/calculator/start", {});
  for (const player of players.slice(0, 3))
    assert.equal(
      (await call(player, "post", "/games/calculator/sync", {})).status,
      200,
    );
  assert.equal(
    (
      await call(players[0], "post", "/games/calculator/event", {
        type: "start",
      })
    ).status,
    200,
  );
  let doc = await models.GameSession.findOne({ gameId: "calculator" });
  doc.config.sequence = [1];
  doc.markModified("config");
  doc.state.phase = "PLAYING";
  doc.state.deadline = Date.now() + 40000;
  const q = doc.state.question;
  let answer;
  for (let x = 0; x < 10 && !answer; x++)
    for (let y = 0; y < 10 && !answer; y++)
      for (let z = 0; z < 10 && !answer; z++)
        if (satisfies(q, x, y, z)) answer = [x, y, z];
  assert.ok(answer);
  doc.state.values = Object.fromEntries(
    "XYZ".split("").map((k, i) => [k, answer[i]]),
  );
  doc.state.changed = Date.now() - 2000;
  doc.state.presence = Object.fromEntries(
    users.map((u) => [String(u._id), Date.now() + 10000]),
  );
  doc.markModified("state");
  await doc.save();
  const state = await call(players[0], "post", "/games/calculator/sync", {});
  assert.equal(state.status, 200);
  assert.equal(state.body.phase, "FINISHED");
  assert.ok(
    (await models.Result.findOne({ gameId: "calculator" })).score >= 100,
  );
});
test("Calculator completion automatically unlocks Memory", async () => {
  assert.equal(
    (await players[1].get("/api/games")).body.games.find(
      (g) => g.id === "memory",
    ).locked,
    false,
  );
});
test("Memory uses server-owned sequences, validates time/order and records actual result", async () => {
  assert.equal(
    (await call(players[0], "post", "/games/memory/start", {})).status,
    200,
  );
  for (let stage = 1; stage <= 3; stage++) {
    const r = await call(players[0], "post", "/games/memory/stage/start", {
      stage,
    });
    assert.equal(r.status, 200);
    const retry = await call(players[0], "post", "/games/memory/stage/start", {
      stage,
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.sequence, r.body.sequence);
    assert.equal(
      (await players[0].get("/api/games/memory/state")).body.active.started,
      false,
    );
    assert.equal(
      (
        await call(players[0], "post", "/games/memory/submit", {
          stage,
          digits: r.body.sequence,
          score: 9999,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(players[0], "post", "/games/memory/submit", {
          stage,
          digits: r.body.sequence,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(players[0], "post", "/games/memory/stage/countdown", {}))
        .status,
      200,
    );
    const doc = await models.GameSession.findOne({ gameId: "memory" });
    doc.state.active.answerFrom = Date.now() - 100;
    doc.state.active.deadline = Date.now() + 10000;
    doc.markModified("state");
    await doc.save();
    for (let index = 0; index < r.body.sequence.length; index++) {
      assert.equal(
        (
          await call(players[0], "post", "/games/memory/guess/start", {
            sessionId: String(doc._id),
            index,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(players[0], "post", "/games/memory/guess", {
            sessionId: String(doc._id),
            index,
            digit: r.body.sequence[index],
          })
        ).status,
        200,
      );
    }
    assert.equal(
      (
        await call(players[0], "post", "/games/memory/submit", {
          stage,
          digits: r.body.sequence,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(players[0], "post", "/games/memory/submit", {
          stage,
          digits: r.body.sequence,
        })
      ).status,
      409,
    );
  }
  const result = await models.Result.findOne({ gameId: "memory" });
  assert.equal(result.score, 22);
});
test("Global leaderboard aggregates automatically checked scores and refuses manual edits", async () => {
  const r = await admin.get("/api/leaderboard");
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 2);
  assert.equal(Object.keys(r.body.rows[0].scores).length, 4);
  const result = await models.Result.findOne({ gameId: "puzzle" });
  assert.equal(
    (
      await call(players[0], "patch", `/admin/results/${result._id}`, {
        score: 50,
        reason: "Unauthorized attempt",
      })
    ).status,
    403,
  );
  for (const change of [{ score: 50 }, { valid: false }]) {
    assert.equal(
      (
        await call(admin, "patch", `/admin/results/${result._id}`, {
          ...change,
          reason: "Manual modification refused",
        })
      ).status,
      405,
    );
  }
  const unchanged = await models.Result.findById(result._id);
  assert.equal(unchanged.score, result.score);
  assert.equal(unchanged.valid, true);
  assert.equal(
    (
      await call(admin, "patch", `/admin/teams/${team._id}`, {
        name: "Renamed Team",
      })
    ).status,
    400,
  );
  assert.equal(
    (await admin.get("/api/leaderboard")).body.rows[0].name,
    "Integration Team",
  );
  assert.ok((await admin.get("/api/admin/dashboard")).body.submissions >= 4);
  for (const game of ["calculator", "memory", "puzzle", "detective"])
    assert.equal((await admin.get("/api/admin/games/" + game)).status, 200);
  const memoryAdmin = await admin.get("/api/admin/games/memory");
  assert.equal(memoryAdmin.body.sessions.rows[0].teamName, "Integration Team");
  assert.match(memoryAdmin.body.sessions.rows[0].userName, /Test Student/);
});

test("Only admins see standings and participants receive only their own team scores", async () => {
  assert.equal((await supertest(app).get("/api/leaderboard")).status, 401);
  assert.equal(
    (await supertest(app).get("/api/admin/leaderboard")).status,
    401,
  );
  assert.equal((await supertest(app).get("/api/teams/me/score")).status, 401);
  for (const player of players.slice(0, 3)) {
    assert.equal((await player.get("/api/leaderboard")).status, 403);
    assert.equal((await player.get("/api/admin/leaderboard")).status, 403);
    assert.equal(
      (await player.get("/api/admin/export/leaderboard")).status,
      403,
    );
    const own = await player.get(
      "/api/teams/me/score?teamId=000000000000000000000000&search=Other",
    );
    assert.equal(own.status, 200);
    assert.equal(own.body.score.teamId, String(team._id));
    assert.equal(own.body.score.name, "Integration Team");
    assert.equal(own.body.score.scores.puzzle, 100);
    assert.equal(Object.keys(own.body.score.scores).length, 4);
    assert.equal(own.body.score.rank, undefined);
    assert.equal(own.body.rows, undefined);
  }
  const other = await players[3].get("/api/teams/me/score");
  assert.equal(other.status, 200);
  assert.notEqual(other.body.score.teamId, String(team._id));
  assert.equal((await admin.get("/api/admin/leaderboard")).status, 200);
  const filtered = await admin.get("/api/admin/leaderboard?gameId=puzzle");
  assert.equal(filtered.body.rows[0].total, 100);
});

test("Simultaneous first logins cannot overfill a team", async () => {
  const leaderIdentity = {
    name: "Race Leader",
    rollNo: "RACE0",
    phoneNo: "9876500000",
    email: "race0@example.test",
  };
  const registered = await call(
    supertest.agent(app),
    "post",
    "/auth/register",
    { ...leaderIdentity, teamName: "Concurrency Team" },
  );
  assert.equal(registered.status, 201);
  const occupied = await models.Team.findOne({
    code: registered.body.team.code,
  });
  const filler = await models.User.create({
    name: "Race Filler",
    rollNo: "RACEF",
    phoneNo: "9876500009",
    email: "filler@example.test",
    teamId: occupied._id,
  });
  occupied.memberIds.push(filler._id);
  await occupied.save();
  const results = await Promise.all(
    [1, 2].map((i) =>
      call(supertest.agent(app), "post", "/auth/login", {
        teamCode: occupied.code,
        name: "Race Student " + i,
        rollNo: "RACE" + i,
        phoneNo: "987650000" + i,
        email: "race" + i + "@example.test",
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await models.Team.findById(occupied._id)).memberIds.length, 3);
});
test("Rank pagination and snapshot-specific Memory normalization remain stable", async () => {
  const members = await models.User.find({ teamId: team._id }).sort({
    rollNo: 1,
  });
  await models.Result.create({
    sessionId: new mongoose.Types.ObjectId(),
    teamId: team._id,
    userId: members[1]._id,
    gameId: "memory",
    score: 3,
    maximum: 6,
    completionTime: 10,
    attempt: 1,
    completedAt: new Date(),
  });
  const r = await admin.get("/api/leaderboard?limit=1&page=1");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.rows[0].rank, 1);
  const existing = await models.Result.find({ teamId: team._id, valid: true });
  const expected =
    existing
      .filter((x) => x.gameId !== "memory")
      .reduce((n, x) => n + (x.score / x.maximum) * 250, 0) +
    ((1 + 0.5) / 3) * 250;
  assert.ok(Math.abs(r.body.rows[0].total - expected) < 0.02);
  const second = await admin.get("/api/leaderboard?limit=1&page=2");
  assert.equal(second.body.rows[0].rank, 2);
  const search = await admin.get("/api/leaderboard?search=Concurrency");
  assert.ok(search.body.rows[0].rank >= 2);
});

test("Puzzle image upload persists cropped assets and validates malformed data", async () => {
  const image = await sharp({
    create: { width: 96, height: 64, channels: 3, background: "#24689a" },
  })
    .png()
    .toBuffer();
  const body = {
    image: "data:image/png;base64," + image.toString("base64"),
    title: "Organizer upload test",
    gridRows: 2,
    gridCols: 3,
    points: 120,
  };
  assert.equal(
    (await call(players[0], "post", "/admin/games/puzzle/upload", body)).status,
    403,
  );
  assert.equal(
    (
      await call(admin, "post", "/admin/games/puzzle/upload", {
        ...body,
        image: "data:image/png;base64,bm90YW5pbWFnZQ==",
      })
    ).status,
    400,
  );
  const r = await call(admin, "post", "/admin/games/puzzle/upload", body);
  assert.equal(r.status, 201);
  const draft = await models.Content.findOne({ title: body.title });
  assert.ok(draft);
  assert.equal(draft.published, false);
  assert.equal(draft.data.pieces.length, 6);
  assert.equal(new Set(draft.data.correctOrder).size, 6);
  // Sequential ObjectIds expose row-major tile order, even when pieces are shuffled.
  assert.ok(
    new Set(
      draft.data.pieces.map((p) => p.imageUrl.split("/").pop().slice(0, 8)),
    ).size > 1,
  );
  const asset = await supertest(app).get(draft.data.pieces[0].imageUrl);
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /image\/jpeg/);
  const metadata = await sharp(asset.body).metadata();
  assert.equal(metadata.width, 32);
  assert.equal(metadata.height, 32);
  assert.ok(await models.Audit.exists({ action: "UPLOAD_PUZZLE" }));
});

test("Admin reset invalidates an attempt and grants a retry only to its scope", async () => {
  const session = await models.GameSession.findOne({
    teamId: team._id,
    gameId: "memory",
  });
  const path = "/admin/games/memory/sessions/" + session._id + "/reset";
  assert.equal((await call(admin, "post", path, { reason: "x" })).status, 400);
  assert.equal(
    (
      await call(admin, "post", path, {
        reason: "Verified device interruption",
      })
    ).status,
    200,
  );
  assert.equal(
    (await models.Result.findOne({ sessionId: session._id })).valid,
    false,
  );
  const next = await call(players[0], "post", "/games/memory/start", {});
  assert.equal(next.status, 200);
  assert.equal(
    (await models.GameSession.findById(next.body.sessionId)).attempt,
    2,
  );
  assert.equal(
    (await models.GameSetting.findOne({ gameId: "memory" }))?.config
      .maxAttempts || 1,
    1,
  );
  assert.ok(
    await models.Audit.exists({
      action: "RESET_ATTEMPT",
      entityId: String(session._id),
    }),
  );
});

test("Admin manages identities and rosters, while team names remain immutable and deleted users lose access", async () => {
  const leader = supertest.agent(app),
    member = supertest.agent(app);
  leader.set("X-Forwarded-For", "192.0.2.105");
  member.set("X-Forwarded-For", "192.0.2.106");
  const registered = await call(leader, "post", "/auth/register", {
    ...identity(5),
    teamName: "Management Team",
  });
  assert.equal(registered.status, 201);
  const code = registered.body.team.code;
  assert.equal(
    (
      await call(leader, "post", "/auth/login", {
        ...identity(5),
        teamCode: code,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(member, "post", "/auth/login", {
        ...identity(6),
        teamCode: code,
      })
    ).status,
    200,
  );
  const managed = await models.Team.findOne({ code });
  const participant = await models.User.findOne({ rollNo: identity(6).rollNo });
  assert.equal(
    (
      await call(member, "delete", `/admin/teams/${managed._id}`, {
        confirm: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(admin, "patch", `/admin/teams/${managed._id}`, {
        name: "Forbidden rename",
      })
    ).status,
    400,
  );
  managed.name = "Model bypass";
  await managed.save();
  assert.equal(
    (await models.Team.findById(managed._id)).name,
    "Management Team",
  );
  const updated = {
    name: "Corrected Member",
    rollNo: "CORRECTED6",
    phoneNo: identity(6).phoneNo,
    email: "corrected6@example.test",
  };
  assert.equal(
    (
      await call(admin, "patch", `/admin/students/${participant._id}`, {
        ...updated,
        email: " CORRECTED6@EXAMPLE.TEST ",
      })
    ).status,
    200,
  );
  assert.equal((await member.get("/api/auth/me")).status, 401);
  assert.equal(
    (
      await call(member, "post", "/auth/login", {
        ...identity(6),
        teamCode: code,
      })
    ).status,
    401,
  );
  assert.equal(
    (await call(member, "post", "/auth/login", { ...updated, teamCode: code }))
      .status,
    200,
  );
  const details = await admin.get(`/api/admin/teams/${managed._id}`);
  assert.equal(
    (
      await call(admin, "patch", `/admin/students/${participant._id}`, {
        phoneNo: "9876555006",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(member, "post", "/auth/login", { ...updated, teamCode: code }))
      .status,
    401,
  );
  updated.phoneNo = "9876555006";
  assert.equal(
    (await call(member, "post", "/auth/login", { ...updated, teamCode: code }))
      .status,
    200,
  );
  assert.equal(
    details.body.members.find((u) => u.rollNo === updated.rollNo).email,
    updated.email,
  );
  assert.equal(
    (
      await call(admin, "patch", `/admin/teams/${managed._id}`, {
        leaderId: String(participant._id),
      })
    ).status,
    200,
  );
  assert.equal(
    (await models.User.findById(participant._id)).role,
    "TEAM_LEADER",
  );
  assert.equal(
    (
      await call(admin, "delete", `/admin/students/${participant._id}`, {
        confirm: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(admin, "patch", `/admin/teams/${managed._id}`, {
        leaderId: String(managed.leaderId),
      })
    ).status,
    200,
  );
  const attempt = await call(leader, "post", "/games/puzzle/start", {});
  assert.equal(attempt.status, 200);
  assert.equal(
    (
      await call(admin, "delete", `/admin/students/${participant._id}`, {
        confirm: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        admin,
        "post",
        `/admin/games/puzzle/sessions/${attempt.body.sessionId}/reset`,
        { reason: "Roster correction test" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(admin, "delete", `/admin/students/${participant._id}`, {
        confirm: true,
      })
    ).status,
    200,
  );
  assert.equal((await models.Team.findById(managed._id)).memberIds.length, 1);
  assert.equal((await models.User.findById(participant._id)).status, "DELETED");
  assert.equal((await member.get("/api/auth/me")).status, 401);
  const retry = await call(leader, "post", "/games/puzzle/start", {});
  assert.equal(retry.status, 200);
  assert.equal(
    (
      await call(admin, "delete", `/admin/teams/${managed._id}`, {
        confirm: true,
      })
    ).status,
    200,
  );
  assert.equal((await models.Team.findById(managed._id)).status, "DELETED");
  assert.equal(
    (await models.GameSession.findById(retry.body.sessionId)).status,
    "ABANDONED",
  );
  assert.equal((await models.User.findById(managed.leaderId)).teamId, null);
  assert.equal((await leader.get("/api/auth/me")).status, 401);
  assert.equal(
    (
      await call(leader, "post", "/auth/login", {
        ...identity(5),
        teamCode: code,
      })
    ).status,
    401,
  );
  assert.ok(
    await models.Audit.exists({
      action: "DELETE_TEAM",
      entityId: String(managed._id),
    }),
  );
  assert.ok(
    await models.Audit.exists({
      action: "DELETE_STUDENT",
      entityId: String(participant._id),
    }),
  );
});

test("Reset attempts return usable game states and Detective rejects blank options", async () => {
  const puzzle = await models.GameSession.findOne({
    teamId: team._id,
    gameId: "puzzle",
  }).sort({ attempt: -1 });
  assert.equal(
    (
      await call(
        admin,
        "post",
        `/admin/games/puzzle/sessions/${puzzle._id}/reset`,
        { reason: "Verified restart regression" },
      )
    ).status,
    200,
  );
  assert.equal(
    (await players[0].get("/api/v1/game/r1/state")).body.hasStarted,
    false,
  );
  assert.equal(
    (await call(players[0], "post", "/v1/game/r1/start", {})).status,
    200,
  );
  const retry = await models.GameSession.findOne({
    teamId: team._id,
    gameId: "puzzle",
  }).sort({ attempt: -1 });
  for (const item of retry.state.puzzles) {
    assert.equal(
      (
        await call(players[0], "post", "/v1/game/r1/submit", {
          puzzleId: item.id,
          pieceOrder: item.correctOrder,
        })
      ).status,
      200,
    );
  }
  const calculator = await models.GameSession.findOne({
    teamId: team._id,
    gameId: "calculator",
  }).sort({ attempt: -1 });
  assert.equal(
    (
      await call(
        admin,
        "post",
        `/admin/games/calculator/sessions/${calculator._id}/reset`,
        { reason: "Verified restart regression" },
      )
    ).status,
    200,
  );
  const state = await call(players[0], "post", "/games/calculator/sync", {});
  assert.equal(state.status, 200);
  assert.equal(state.body.phase, "ASSIGN");
  const calculatorRetry = await models.GameSession.findOne({
    teamId: team._id,
    gameId: "calculator",
  }).sort({ attempt: -1 });
  assert.equal(calculatorRetry.attempt, calculator.attempt + 1);
  const content = await models.Content.findOne({
    gameId: "detective",
    published: true,
  }).lean();
  content.data.questions[0].options[0] = "   ";
  assert.equal(
    (
      await call(admin, "post", "/admin/games/detective/content", {
        title: "Invalid blank option",
        published: false,
        order: 0,
        data: content.data,
      })
    ).status,
    400,
  );
});

test("Admin Memory controls fill partial settings and student cards agree with entry restrictions", async () => {
  const previous = await models.GameSetting.findOne({
    gameId: "memory",
  }).lean();
  try {
    await models.GameSetting.updateOne(
      { gameId: "memory" },
      {
        $set: {
          config: { enabled: false, stages: { stage1: { numbersCount: 3 } } },
        },
      },
      { upsert: true },
    );
    const management = await admin.get("/api/admin/games/memory");
    assert.equal(management.status, 200);
    assert.equal(management.body.settings.enabled, false);
    assert.equal(management.body.settings.stages.stage1.numbersCount, 3);
    assert.equal(management.body.settings.stages.stage3.numbersCount, 9);
    const catalog = await players[0].get("/api/games");
    const memory = catalog.body.games.find((game) => game.id === "memory");
    assert.equal(memory.available, false);
    assert.match(memory.unavailableReason, /paused/);
    const entry = await players[0].get("/api/games/memory/state");
    assert.equal(entry.status, 403);
    assert.equal(entry.body.message, memory.unavailableReason);
  } finally {
    if (previous)
      await models.GameSetting.updateOne(
        { gameId: "memory" },
        { $set: { config: previous.config } },
      );
    else await models.GameSetting.deleteOne({ gameId: "memory" });
  }
});

// Keep the sandbox regression at the end: it temporarily disables event games.
test("Missing and malformed content returns organizer guidance instead of a service failure", async () => {
  const published = await models.Content.find({
    gameId: "detective",
    published: true,
  }).select("_id");
  let bad;
  try {
    await models.Content.updateMany(
      { _id: { $in: published.map((c) => c._id) } },
      { $set: { published: false } },
    );
    const cards = await admin.get("/api/games");
    const detective = cards.body.games.find((g) => g.id === "detective");
    assert.equal(detective.available, false);
    assert.match(detective.unavailableReason, /not published/);
    assert.equal(
      (await call(admin, "post", "/games/detective/start", {})).status,
      409,
    );
    bad = await models.Content.create({
      gameId: "detective",
      title: "Invalid legacy fixture",
      published: true,
      order: -100,
    });
    assert.equal(
      (await call(admin, "post", "/games/detective/start", {})).status,
      409,
    );
    await models.Content.deleteOne({ _id: bad._id });
    bad = null;
    bad = await models.Content.create({
      gameId: "puzzle",
      title: "Incomplete legacy fixture",
      published: true,
      data: {},
      order: -100,
    });
    const puzzle = await call(admin, "post", "/games/puzzle/start", {});
    assert.equal(puzzle.status, 409);
    assert.match(puzzle.body.message, /incomplete/);
  } finally {
    if (bad) await models.Content.deleteOne({ _id: bad._id });
    await models.Content.updateMany(
      { _id: { $in: published.map((c) => c._id) } },
      { $set: { published: true } },
    );
  }
});
test("Admins can complete all games privately while competition gates and scores stay intact", async () => {
  const resultCount = await models.Result.countDocuments();
  const teamCount = await models.Team.countDocuments();
  const standings = (await admin.get("/api/admin/leaderboard")).body.rows;
  for (const gameId of ["puzzle", "detective", "calculator", "memory"]) {
    const config =
      (await models.GameSetting.findOne({ gameId }))?.config ||
      defaults[gameId];
    await models.GameSetting.updateOne(
      { gameId },
      { $set: { config: { ...config, enabled: false } } },
      { upsert: true },
    );
    assert.equal(
      (await call(players[0], "post", `/games/${gameId}/start`, {})).status,
      403,
    );
    assert.equal(
      (await call(players[0], "post", `/admin/games/${gameId}/test/reset`, {}))
        .status,
      403,
    );
    assert.equal(
      (await call(admin, "post", `/games/${gameId}/start`, {})).status,
      200,
    );
  }
  const puzzle = await models.GameSession.findOne({
    gameId: "puzzle",
    testMode: true,
  });
  await models.GameSession.updateOne(
    { _id: puzzle._id },
    { $set: { "state.expiresAt": Date.now() - 60000 } },
  );
  const practicePuzzle = await admin.get("/api/v1/game/r1/state");
  assert.equal(practicePuzzle.body.session.remainingSeconds, null);
  assert.equal(practicePuzzle.body.session.status, "IN_PROGRESS");
  for (const p of puzzle.state.puzzles) {
    const solved = await call(admin, "post", "/v1/game/r1/submit", {
      puzzleId: p.id,
      pieceOrder: p.correctOrder,
    });
    assert.equal(solved.status, 200);
    assert.equal(solved.body.isCorrect, true);
  }
  const detective = await models.GameSession.findOne({
    gameId: "detective",
    testMode: true,
  });
  await models.GameSession.updateOne(
    { _id: detective._id },
    { $set: { "state.expiresAt": Date.now() - 60000 } },
  );
  for (const q of detective.state.case.questions) {
    assert.equal(
      (
        await call(admin, "post", "/v1/detective/submit-answer", {
          questionId: q.id,
          selectedOptionIndex: q.correctAnswerIndex,
        })
      ).status,
      200,
    );
  }
  let view = await call(admin, "post", "/games/calculator/sync", {});
  assert.equal(view.status, 200);
  assert.equal(view.body.testMode, true);
  assert.equal(view.body.players.length, 3);
  assert.ok(view.body.players.every((p) => p.online));
  assert.equal(
    (await call(admin, "post", "/games/calculator/event", { type: "start" }))
      .body.phase,
    "PLAYING",
  );
  let calculator = await models.GameSession.findOne({
    gameId: "calculator",
    testMode: true,
  });
  calculator.config.sequence = [1];
  calculator.markModified("config");
  calculator.state.phase = "PLAYING";
  calculator.state.deadline = Date.now() + 40000;
  calculator.markModified("state");
  await calculator.save();
  const stale = await call(admin, "post", "/games/calculator/event", {
    type: "digit",
    digit: 9,
    conf: 1,
    questionId: "old-question",
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body.values, {});
  let answer;
  for (let x = 0; x < 10 && !answer; x++)
    for (let y = 0; y < 10 && !answer; y++)
      for (let z = 0; z < 10 && !answer; z++)
        if (satisfies(calculator.state.question, x, y, z)) answer = [x, y, z];
  assert.ok(answer);
  for (const [i, role] of ["X", "Y", "Z"].entries()) {
    const switched = await call(admin, "post", "/games/calculator/event", {
      type: "role",
      role,
    });
    assert.equal(switched.body.you.role, role);
    assert.equal(
      (
        await call(admin, "post", "/games/calculator/event", {
          type: "digit",
          digit: answer[i],
          conf: 1,
        })
      ).status,
      200,
    );
  }
  await models.GameSession.updateOne(
    { _id: calculator._id },
    { $set: { "state.changed": Date.now() - 6000 } },
  );
  assert.equal(
    (await call(admin, "post", "/games/calculator/sync", {})).body.phase,
    "FINISHED",
  );
  for (let stage = 1; stage <= 3; stage++) {
    const start = await call(admin, "post", "/games/memory/stage/start", {
      stage,
    });
    assert.equal(start.status, 200);
    await call(admin, "post", "/games/memory/stage/countdown", {});
    await models.GameSession.updateOne(
      { gameId: "memory", testMode: true },
      {
        $set: {
          "state.active.answerFrom": Date.now() - 1,
          "state.active.deadline": Date.now() + 20000,
        },
      },
    );
    for (let index = 0; index < start.body.sequence.length; index++) {
      assert.equal(
        (
          await call(admin, "post", "/games/memory/guess/start", {
            sessionId: start.body.sessionId,
            index,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(admin, "post", "/games/memory/guess", {
            sessionId: start.body.sessionId,
            index,
            digit: start.body.sequence[index],
          })
        ).status,
        200,
      );
    }
    assert.equal(
      (
        await call(admin, "post", "/games/memory/submit", {
          stage,
          digits: start.body.sequence,
        })
      ).status,
      200,
    );
  }
  assert.equal(
    await models.GameSession.countDocuments({
      testMode: true,
      status: "COMPLETED",
    }),
    4,
  );
  assert.equal(await models.Result.countDocuments(), resultCount);
  assert.equal(await models.Team.countDocuments(), teamCount);
  assert.deepEqual(
    (await admin.get("/api/admin/leaderboard")).body.rows,
    standings,
  );
  assert.equal(
    (await admin.get("/api/admin/games/puzzle")).body.sessions.rows.some(
      (s) => s.testMode,
    ),
    false,
  );
  assert.equal(
    (await call(admin, "post", "/games/puzzle/start", {})).status,
    200,
  );
  assert.equal(
    (await call(admin, "post", "/admin/games/puzzle/test/reset", {})).status,
    200,
  );
  assert.equal(
    (await call(admin, "post", "/games/puzzle/start", {})).status,
    200,
  );
  const fresh = await admin.get("/api/v1/game/r1/state");
  assert.equal(fresh.body.session.score, 0);
  assert.equal(fresh.body.session.attempts.length, 0);
  const second = supertest.agent(app);
  await models.User.create({
    name: "Second Test Admin",
    email: "second-admin@example.test",
    role: "ADMIN",
    passwordHash: hashPassword("second-test-password-123"),
  });
  assert.equal(
    (
      await call(second, "post", "/auth/admin/login", {
        email: "second-admin@example.test",
        password: "second-test-password-123",
      })
    ).status,
    200,
  );
  assert.equal(
    (await second.get("/api/v1/game/r1/state")).body.hasStarted,
    false,
  );
});

test("Authentication handles shared Wi-Fi, normalized identities, malformed sessions and invalid admin hashes", async () => {
  const ip = "203.0.113.88";
  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call(
        supertest.agent(app).set("X-Forwarded-For", ip),
        "post",
        "/auth/login",
        {
          ...identity(0),
          rollNo: `NAT${i}`,
          teamCode: "FF-000000000000",
        },
      ),
    ),
  );
  for (const r of attempts) assert.equal(r.status, 401, JSON.stringify(r.body));
  const valid = await call(
    supertest.agent(app).set("X-Forwarded-For", ip),
    "post",
    "/auth/login",
    {
      ...identity(0),
      name: "  test   STUDENT 0  ",
      email: " STUDENT0@EXAMPLE.TEST ",
      teamCode: team.code.toLowerCase(),
    },
  );
  assert.equal(valid.status, 200);
  assert.equal(
    (
      await supertest(app)
        .get("/api/auth/me")
        .set("Cookie", "aarohan_session=malformed")
    ).status,
    401,
  );
  const adminLogin = await call(supertest(app), "post", "/auth/admin/login", {
    email: " TEST-ADMIN@EXAMPLE.TEST ",
    password: "test-only-password-123",
  });
  assert.equal(adminLogin.status, 200);
  await models.User.create({
    name: "Invalid hash fixture",
    email: "bad-hash@example.test",
    role: "ADMIN",
    passwordHash: "plain-text-is-not-a-hash",
  });
  const invalid = await call(supertest(app), "post", "/auth/admin/login", {
    email: "bad-hash@example.test",
    password: "anything",
  });
  assert.equal(invalid.status, 401);
});

async function multiplayerFixture(game, state) {
  await models.GameSetting.updateOne(
    { gameId: game },
    { $set: { config: defaults[game] } },
    { upsert: true },
  );
  const { randomBytes } = await import("node:crypto");
  const { digest } = await import("../src/services/auth.js");
  const users = await models.User.create(
    [0, 1, 2].map((i) => ({
      name: `Multiplayer QA ${i}`,
      role: i ? "STUDENT" : "TEAM_LEADER",
    })),
  );
  const t = await models.Team.create({
    name: `Multiplayer ${randomBytes(4).toString("hex")}`,
    code: `FF-${randomBytes(6).toString("hex").toUpperCase()}`,
    leaderId: users[0]._id,
    memberIds: users.map((u) => u._id),
  });
  await models.User.updateMany(
    { _id: { $in: t.memberIds } },
    { $set: { teamId: t._id } },
  );
  const agents = [];
  for (const u of users) {
    const token = randomBytes(32).toString("hex");
    await models.AuthSession.create({
      userId: u._id,
      tokenHash: digest(token),
      expiresAt: new Date(Date.now() + 3600000),
    });
    agents.push(supertest.agent(app).set("Cookie", `aarohan_session=${token}`));
  }
  const doc = await models.GameSession.create({
    gameId: game,
    scope: String(t._id),
    teamId: t._id,
    userId: users[0]._id,
    attempt: 1,
    startedAt: new Date(),
    config: defaults[game],
    maximum: 100,
    state,
  });
  for (const prior of ["puzzle", "detective", "calculator"].slice(
    0,
    ["puzzle", "detective", "calculator", "memory"].indexOf(game),
  )) {
    await models.Result.create({
      sessionId: new mongoose.Types.ObjectId(),
      teamId: t._id,
      userId: users[0]._id,
      gameId: prior,
      score: 10,
      maximum: 100,
      valid: true,
      completionTime: 10,
    });
  }
  return { agents, users, t, doc };
}

test("Multiplayer: Detective members cannot submit answers or unlock hints", async () => {
  const f = await multiplayerFixture("detective", {
    case: {
      id: "case",
      title: "Case",
      clues: [],
      questions: [
        { id: "q", options: ["A", "B"], correctAnswerIndex: 0, points: 100 },
      ],
      hints: [{ id: "h", hintText: "A", penalty: 25 }],
    },
    index: 0,
    answers: [],
    hintsUsed: [],
    expiresAt: Date.now() + 600000,
  });
  assert.equal(
    (await call(f.agents[1], "post", "/v1/detective/use-hint", { hintId: "h" }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(f.agents[2], "post", "/v1/detective/submit-answer", {
        questionId: "q",
        selectedOptionIndex: 0,
      })
    ).status,
    403,
  );
  assert.equal((await models.GameSession.findById(f.doc._id)).score, 0);
});

test("Multiplayer: reset zeros the round and locks every descendant API without deleting other rounds", async () => {
  const f = await multiplayerFixture("detective", {
    index: 0,
    answers: [],
    hintsUsed: [],
  });
  f.doc.score = 100;
  f.doc.status = "COMPLETED";
  f.doc.completedAt = new Date();
  await f.doc.save();
  await models.Result.create({
    sessionId: f.doc._id,
    teamId: f.t._id,
    gameId: "detective",
    score: 100,
    maximum: 100,
    valid: true,
    completionTime: 20,
  });
  const later = await models.GameSession.create({
    gameId: "calculator",
    teamId: f.t._id,
    userId: f.users[0]._id,
    scope: String(f.t._id),
    attempt: 1,
    score: 40,
    status: "COMPLETED",
    state: {},
    config: defaults.calculator,
  });
  await models.Result.create({
    sessionId: later._id,
    teamId: f.t._id,
    gameId: "calculator",
    score: 40,
    maximum: 100,
    valid: true,
    completionTime: 30,
  });
  assert.equal(
    (
      await call(
        admin,
        "post",
        `/admin/games/detective/sessions/${f.doc._id}/reset`,
        { reason: "Multiplayer reset QA" },
      )
    ).status,
    200,
  );
  assert.equal((await models.GameSession.findById(f.doc._id)).score, 0);
  assert.equal((await models.GameSession.findById(later._id)).score, 40);
  const cards = (await f.agents[1].get("/api/games")).body.games;
  assert.equal(cards.find((g) => g.id === "memory").locked, true);
  assert.equal(
    (await call(f.agents[1], "post", "/games/calculator/sync", {})).status,
    403,
  );
  assert.equal(
    (await f.agents[1].get("/api/games/calculator/state")).status,
    403,
  );
});

test("Multiplayer: puzzle board is authoritative, permission checked and revision guarded", async () => {
  const pieces = [0, 1, 2, 3].map((i) => ({
    pieceId: `p${i}`,
    imageUrl: `https://example.test/${i}.png`,
  }));
  const f = await multiplayerFixture("puzzle", {
    puzzles: [
      {
        id: "puzzle",
        title: "QA",
        pieces,
        correctOrder: pieces.map((p) => p.pieceId),
        points: 100,
      },
    ],
    index: 0,
    attempts: [],
    expiresAt: Date.now() + 600000,
  });
  const body = {
    sessionId: String(f.doc._id),
    puzzleId: "puzzle",
    revision: 0,
    board: ["p2", null, "p1", null],
  };
  assert.equal(
    (await call(f.agents[0], "post", "/v1/game/r1/board", body)).status,
    200,
  );
  for (const a of f.agents.slice(1))
    assert.deepEqual(
      (await a.get("/api/v1/game/r1/state")).body.session.board,
      body.board,
    );
  assert.equal(
    (
      await call(f.agents[1], "post", "/v1/game/r1/board", {
        ...body,
        revision: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(f.agents[0], "post", "/v1/game/r1/board", body)).status,
    409,
  );
});

test("Multiplayer: leaderboard average time and selectable sort use authoritative results", async () => {
  const f = await multiplayerFixture("puzzle", {});
  await models.Result.create([
    {
      sessionId: new mongoose.Types.ObjectId(),
      teamId: f.t._id,
      gameId: "puzzle",
      score: 40,
      maximum: 100,
      valid: true,
      completionTime: 20,
    },
    {
      sessionId: new mongoose.Types.ObjectId(),
      teamId: f.t._id,
      gameId: "detective",
      score: 80,
      maximum: 100,
      valid: true,
      completionTime: 40,
    },
  ]);
  const r = await call(
    admin,
    "get",
    `/admin/leaderboard?search=${encodeURIComponent(f.t.name)}&sort=time-asc`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].averageTime, 30);
  assert.equal(
    (await call(admin, "get", "/admin/leaderboard?sort=invalid")).status,
    400,
  );
});

test("Multiplayer: three live streams converge, reconnect and isolate team data", async (t) => {
  const pieces = [0, 1, 2, 3].map((i) => ({
    pieceId: `live${i}`,
    imageUrl: `https://example.test/${i}.png`,
  }));
  const f = await multiplayerFixture("puzzle", {
    puzzles: [
      {
        id: "live-puzzle",
        title: "Live QA",
        pieces,
        correctOrder: pieces.map((p) => p.pieceId),
        points: 100,
      },
    ],
    index: 0,
    attempts: [],
    expiresAt: Date.now() + 600000,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const { randomBytes } = await import("node:crypto");
  const { digest } = await import("../src/services/auth.js");
  async function open(user, game = "puzzle") {
    const token = randomBytes(32).toString("hex");
    await models.AuthSession.create({
      userId: user._id,
      tokenHash: digest(token),
      expiresAt: new Date(Date.now() + 60000),
    });
    const control = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/games/${game}/events`,
      {
        headers: { Cookie: `aarohan_session=${token}` },
        signal: control.signal,
      },
    );
    assert.equal(response.status, 200);
    const messages = [],
      waiters = [];
    const item = {
      messages,
      abort: () => control.abort(),
      wait: (predicate) => {
        const found = messages.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Realtime update did not arrive: " +
                    JSON.stringify(messages.slice(-2)),
                ),
              ),
            4000,
          );
          waiters.push((message) => {
            if (predicate(message)) {
              clearTimeout(timer);
              resolve(message);
              return true;
            }
            return false;
          });
        });
      },
    };
    streams.push(item);
    void (async () => {
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const chunk = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const data = chunk
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!data) continue;
            const message = {
              event: chunk
                .split("\n")
                .find((line) => line.startsWith("event: "))
                ?.slice(7),
              data: JSON.parse(data.slice(6)),
              at: performance.now(),
            };
            messages.push(message);
            for (let i = waiters.length - 1; i >= 0; i--)
              if (waiters[i](message)) waiters.splice(i, 1);
          }
        }
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    })();
    await item.wait((m) => m.event === "state");
    return item;
  }
  const progress = await open(f.users[1], "progress");
  assert.equal(progress.messages[0].data.team.code, f.t.code);
  const live = [];
  for (const user of f.users) live.push(await open(user));
  const started = performance.now();
  const board = ["live3", null, "live1", null];
  assert.equal(
    (
      await call(f.agents[0], "post", "/v1/game/r1/board", {
        sessionId: String(f.doc._id),
        puzzleId: "live-puzzle",
        revision: 0,
        board,
      })
    ).status,
    200,
  );
  for (const s of live) {
    const update = await s.wait((m) => m.data.session?.revision === 1);
    assert.deepEqual(update.data.session.board, board);
    assert.equal(String(update.data.team.id), String(f.t._id));
    assert.ok(
      update.at - started < 2000,
      "Local push delivery should not wait for polling",
    );
  }
  live[1].abort();
  const reconnect = await open(f.users[1]);
  assert.deepEqual(
    reconnect.messages.find((m) => m.event === "state").data.session.board,
    board,
  );
  const other = await multiplayerFixture("puzzle", {
    puzzles: [
      {
        id: "other",
        title: "Private other team",
        pieces,
        correctOrder: pieces.map((p) => p.pieceId),
        points: 100,
      },
    ],
    index: 0,
    attempts: [],
    expiresAt: Date.now() + 600000,
  });
  await call(other.agents[0], "post", "/v1/game/r1/board", {
    sessionId: String(other.doc._id),
    puzzleId: "other",
    revision: 0,
    board,
  });
  await call(f.agents[0], "post", "/v1/game/r1/board", {
    sessionId: String(f.doc._id),
    puzzleId: "live-puzzle",
    revision: 1,
    board: [null, null, null, null],
  });
  for (const s of [live[0], live[2], reconnect]) {
    await s.wait((m) => m.data.session?.revision === 2);
    assert.ok(
      s.messages
        .filter((m) => m.event === "state")
        .every((m) => String(m.data.team.id) === String(f.t._id)),
    );
  }
  await call(admin, "post", `/admin/games/puzzle/sessions/${f.doc._id}/reset`, {
    reason: "Live reset verification",
  });
  for (const s of [live[0], live[2], reconnect])
    await s.wait((m) => m.event === "state" && m.data.hasStarted === false);

  await progress.wait(
    (m) =>
      m.data.games?.find((g) => g.id === "puzzle")?.score === 0 &&
      m.data.games?.find((g) => g.id === "puzzle")?.status === "ABANDONED",
  );

  const calc = await multiplayerFixture("calculator", {});
  calc.doc.state = initializeCalculator(calc.t.memberIds, defaults.calculator);
  calc.doc.config = { ...defaults.calculator, countdown: 0.05 };
  await calc.doc.save();
  for (const a of calc.agents)
    assert.equal(
      (await call(a, "post", "/games/calculator/sync", {})).status,
      200,
    );
  const calcStreams = [];
  for (const u of calc.users) calcStreams.push(await open(u, "calculator"));
  assert.equal(
    (
      await call(calc.agents[1], "post", "/games/calculator/event", {
        type: "start",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(calc.agents[0], "post", "/games/calculator/event", {
        type: "start",
      })
    ).status,
    200,
  );
  for (const s of calcStreams) await s.wait((m) => m.data.phase === "PLAYING");
  const beforeDigit = performance.now();
  const q = (await calc.agents[0].get("/api/games/calculator/state")).body
    .question.question_id;
  assert.equal(
    (
      await call(calc.agents[2], "post", "/games/calculator/event", {
        type: "digit",
        sessionId: String(calc.doc._id),
        questionId: q,
        digit: 8,
        conf: 1,
      })
    ).status,
    200,
  );
  const latencies = [];
  for (const s of calcStreams) {
    const m = await s.wait((m) => m.data.values?.Z === 8);
    latencies.push(Math.round(m.at - beforeDigit));
    assert.ok(m.at - beforeDigit < 2000);
  }
  t.diagnostic(
    `Local committed Calculator digit delivery to three clients: ${latencies.join(", ")} ms`,
  );
  const gate = await models.GameSession.create({
    teamId: calc.t._id,
    userId: calc.users[0]._id,
    scope: String(calc.t._id),
    gameId: "detective",
    attempt: 1,
    status: "COMPLETED",
    score: 100,
    state: {},
    config: defaults.detective,
  });
  await call(
    admin,
    "post",
    `/admin/games/detective/sessions/${gate._id}/reset`,
    { reason: "Dependent live lock QA" },
  );
  for (const s of calcStreams)
    await s.wait((m) => m.event === "access" && m.data.status === 403);

  const det = await multiplayerFixture("detective", {
    case: {
      id: "live-case",
      title: "Live shared case",
      clues: [],
      questions: [
        {
          id: "live-q",
          options: ["A", "B"],
          correctAnswerIndex: 0,
          points: 100,
        },
      ],
      hints: [
        {
          id: "live-hint",
          caseId: "live-case",
          questionId: "live-q",
          hintText: "Look at A",
          penalty: 25,
        },
      ],
    },
    index: 0,
    answers: [],
    hintsUsed: [],
    expiresAt: Date.now() + 600000,
  });
  const secondCase = {
    ...det.doc.state.case,
    id: "live-case-2",
    title: "Next live case",
    hints: [],
  };
  await models.GameSession.updateOne(
    { _id: det.doc._id },
    {
      $set: {
        "state.cases": [det.doc.state.case, secondCase],
        "state.caseIndex": 0,
        "state.completedCases": [],
        maximum: 200,
      },
    },
  );
  const detStreams = [];
  for (const u of det.users) detStreams.push(await open(u, "detective"));
  await call(det.agents[0], "post", "/v1/detective/selection", {
    sessionId: String(det.doc._id),
    caseId: "live-case",
    questionId: "live-q",
    selectedOptionIndex: 0,
  });
  await call(det.agents[0], "post", "/v1/detective/use-hint", {
    caseId: "live-case",
    hintId: "live-hint",
  });
  for (const stream of detStreams)
    await stream.wait(
      (m) =>
        m.data.attempt?.selectedOption === 0 &&
        m.data.hints?.[0]?.hintText === "Look at A",
    );
  await call(det.agents[0], "post", "/v1/detective/submit-answer", {
    caseId: "live-case",
    questionId: "live-q",
    selectedOptionIndex: 0,
  });
  for (const stream of detStreams)
    await stream.wait(
      (m) =>
        m.data.case?.id === "live-case-2" &&
        m.data.attempt?.status === "IN_PROGRESS" &&
        m.data.attempt?.score === 75,
    );
  assert.equal(
    (
      await call(det.agents[0], "post", "/v1/detective/submit-answer", {
        caseId: "live-case-2",
        questionId: "live-q",
        selectedOptionIndex: 0,
      })
    ).status,
    200,
  );
  for (const stream of detStreams)
    await stream.wait(
      (m) =>
        m.data.attempt?.status === "COMPLETED" && m.data.attempt?.score === 175,
    );
  await models.User.updateOne(
    { _id: det.users[1]._id },
    { $set: { status: "SUSPENDED" } },
  );
  await detStreams[1].wait(
    (m) => m.event === "access" && m.data.status === 401,
  );

  const mem = await multiplayerFixture("memory", {
    stage: 0,
    stages: [],
    guessProtocol: 1,
    active: {
      stage: 1,
      shown: [7, 2],
      answerFrom: Date.now() - 10,
      deadline: Date.now() + 30000,
      guesses: [],
      guessIndex: 0,
      guessDeadline: Date.now() + 150,
    },
  });
  mem.doc.scope = `${mem.t._id}:${mem.users[0]._id}`;
  await mem.doc.save();
  const memStream = await open(mem.users[0], "memory");
  const timeout = await memStream.wait(
    (m) => m.data.active?.guesses?.[0]?.timedOut === true,
  );
  assert.equal(timeout.data.active.guesses[0].correct, false);
});

test("Multiplayer: Detective selections and purchased hints are shared and earlier questions remain immutable", async () => {
  const f = await multiplayerFixture("detective", {
    case: {
      id: "observe",
      title: "Observe",
      clues: [{ id: "c", title: "Shared clue", description: "Evidence" }],
      questions: [
        {
          id: "first",
          options: ["A", "B"],
          correctAnswerIndex: 0,
          points: 100,
        },
        { id: "next", options: ["C", "D"], correctAnswerIndex: 1, points: 100 },
      ],
      hints: [
        {
          id: "hint",
          questionId: "first",
          hintText: "Read shared clue",
          penalty: 25,
        },
      ],
    },
    index: 0,
    answers: [],
    hintsUsed: [],
    expiresAt: Date.now() + 600000,
  });
  const selection = {
    sessionId: String(f.doc._id),
    questionId: "first",
    selectedOptionIndex: 0,
  };
  assert.equal(
    (await call(f.agents[1], "post", "/v1/detective/selection", selection))
      .status,
    403,
  );
  assert.equal(
    (await call(f.agents[0], "post", "/v1/detective/selection", selection))
      .status,
    200,
  );
  await call(f.agents[0], "post", "/v1/detective/use-hint", { hintId: "hint" });
  for (const a of f.agents.slice(1)) {
    const state = (await a.get("/api/v1/detective/case")).body;
    assert.equal(state.isLeader, false);
    assert.equal(state.attempt.selectedOption, 0);
    assert.equal(state.hints[0].hintText, "Read shared clue");
    assert.equal(state.clues[0].id, "c");
  }
  await call(f.agents[0], "post", "/v1/detective/submit-answer", {
    questionId: "first",
    selectedOptionIndex: 0,
  });
  assert.equal(
    (await call(f.agents[0], "post", "/v1/detective/selection", selection))
      .status,
    409,
  );
  assert.equal(
    (
      await call(f.agents[0], "post", "/v1/detective/submit-answer", {
        questionId: "first",
        selectedOptionIndex: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(f.agents[0], "post", "/games/calculator/start", {})).status,
    403,
  );
});

test("Multiplayer: Memory guess deadlines are server owned, timeouts cannot score and duplicate delivery is idempotent", async () => {
  const f = await multiplayerFixture("memory", {
    stage: 0,
    stages: [],
    guessProtocol: 1,
    active: {
      stage: 1,
      shown: [7, 2],
      answerFrom: Date.now() - 10,
      deadline: Date.now() + 30000,
      guesses: [],
    },
  });
  f.doc.scope = `${f.t._id}:${f.users[0]._id}`;
  await f.doc.save();
  const start = { sessionId: String(f.doc._id), index: 0 };
  assert.equal(
    (await call(f.agents[1], "post", "/games/memory/guess/start", start))
      .status,
    409,
  );
  assert.equal(
    (
      await call(f.agents[0], "post", "/games/memory/submit", {
        stage: 1,
        digits: [7, 2],
      })
    ).status,
    409,
  );
  const ready = await call(
    f.agents[0],
    "post",
    "/games/memory/guess/start",
    start,
  );
  assert.equal(ready.status, 200);
  assert.ok(ready.body.deadline > ready.body.serverNow);
  const earlyWrong = await call(f.agents[0], "post", "/games/memory/guess", {
    ...start,
    digit: 4,
  });
  assert.equal(earlyWrong.status, 409);
  assert.equal(
    (await models.GameSession.findById(f.doc._id)).state.active.guesses.length,
    0,
  );

  await models.GameSession.updateOne(
    { _id: f.doc._id },
    { $set: { "state.active.guessDeadline": Date.now() - 1 } },
  );
  const guess = await call(f.agents[0], "post", "/games/memory/guess", {
    ...start,
    digit: 7,
  });
  assert.equal(guess.status, 200);
  assert.equal(guess.body.timedOut, true);
  assert.equal(guess.body.correct, false);
  const replay = await call(f.agents[0], "post", "/games/memory/guess", {
    ...start,
    digit: 2,
  });
  assert.equal(replay.body.digit, 7);
  await call(f.agents[0], "post", "/games/memory/guess/start", {
    ...start,
    index: 1,
  });
  await call(f.agents[0], "post", "/games/memory/guess", {
    ...start,
    index: 1,
    digit: 2,
  });
  const finish = await call(f.agents[0], "post", "/games/memory/submit", {
    stage: 1,
    digits: [7, 2],
  });
  assert.equal(finish.status, 200);
  assert.equal(finish.body.score, 1);
  const saved = await models.GameSession.findById(f.doc._id);
  assert.equal(saved.state.stages[0].guesses[0].timedOut, true);
});

test("Multiplayer: all leaderboard sort orders keep missing times last and use score/time ties", async () => {
  const prefix = `SortQA-${Date.now()}`;
  const teams = await models.Team.create(
    [0, 1, 2, 3].map((i) => ({
      name: `${prefix}-${i}`,
      code: `FF-${new mongoose.Types.ObjectId().toString().slice(-12).toUpperCase()}`,
      leaderId: new mongoose.Types.ObjectId(),
      memberIds: [new mongoose.Types.ObjectId()],
    })),
  );
  for (const [i, score, time] of [
    [0, 100, 30],
    [1, 100, 10],
    [2, 50, 20],
  ])
    await models.Result.create({
      sessionId: new mongoose.Types.ObjectId(),
      teamId: teams[i]._id,
      gameId: "puzzle",
      score,
      maximum: 100,
      completionTime: time,
      valid: true,
    });
  const expected = {
    "score-desc": [1, 0, 2, 3],
    "score-asc": [3, 2, 1, 0],
    "time-asc": [1, 2, 0, 3],
    "time-desc": [0, 2, 1, 3],
  };
  for (const [sort, order] of Object.entries(expected)) {
    const r = await call(
      admin,
      "get",
      `/admin/leaderboard?search=${prefix}&sort=${sort}`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.rows.map((r) => r.name),
      order.map((i) => teams[i].name),
    );
  }
});

test("Multiplayer: team Memory reset clears all member attempts and scores but preserves predecessor results", async () => {
  const f = await multiplayerFixture("memory", {
    stage: 3,
    stages: [],
    active: null,
  });
  f.doc.scope = `${f.t._id}:${f.users[0]._id}`;
  f.doc.status = "COMPLETED";
  f.doc.score = 5;
  await f.doc.save();
  const docs = [f.doc];
  for (const u of f.users.slice(1))
    docs.push(
      await models.GameSession.create({
        gameId: "memory",
        teamId: f.t._id,
        userId: u._id,
        scope: `${f.t._id}:${u._id}`,
        attempt: 1,
        status: "COMPLETED",
        score: 5,
        state: { stage: 3 },
        config: defaults.memory,
      }),
    );
  for (const d of docs)
    await models.Result.create({
      sessionId: d._id,
      teamId: f.t._id,
      userId: d.userId,
      gameId: "memory",
      score: 5,
      maximum: 10,
      completionTime: 12,
      valid: true,
    });
  const r = await call(
    admin,
    "post",
    `/admin/games/memory/sessions/${f.doc._id}/reset`,
    { scope: "team", reason: "Reset whole team Memory round" },
  );
  assert.equal(r.status, 200);
  assert.equal(
    await models.Result.countDocuments({
      teamId: f.t._id,
      gameId: "memory",
      valid: true,
    }),
    0,
  );
  assert.equal(
    await models.Result.countDocuments({
      teamId: f.t._id,
      gameId: { $ne: "memory" },
      valid: true,
    }),
    3,
  );
  for (const d of await models.GameSession.find({
    teamId: f.t._id,
    gameId: "memory",
  })) {
    assert.equal(d.score, 0);
    assert.equal(d.status, "ABANDONED");
    assert.deepEqual(d.state, {});
  }
});

test("Detective: independent publishing, ordered cases, shared progress and cumulative hint penalties", async () => {
  const published = await models.Content.find({
    gameId: "detective",
    published: true,
  }).select("_id");
  const created = [];
  try {
    await models.Content.updateMany(
      { _id: { $in: published.map((c) => c._id) } },
      { $set: { published: false } },
    );
    const body = (title, order, points, penalty) => ({
      title,
      order,
      published: true,
      data: {
        description: title,
        difficulty: "Easy",
        suspects: [],
        clues: [
          {
            id: "shared-clue",
            title,
            description: title,
            evidence: title,
            evidenceType: "text",
          },
        ],
        questions: [
          {
            id: "shared-question",
            question: title,
            options: ["A", "B"],
            correctAnswerIndex: 0,
            points,
            clueId: "shared-clue",
          },
        ],
        hints: [{ id: "shared-hint", hintText: title, penalty, enabled: true }],
      },
    });
    // Create in reverse play order; repeated IDs are valid in different cases.
    const secondBody = body("Second case", 20, 50, 10);
    const firstBody = body("First case", 10, 100, 125);
    for (const b of [secondBody, firstBody]) {
      const response = await call(
        admin,
        "post",
        "/admin/games/detective/content",
        b,
      );
      assert.equal(response.status, 201);
      created.push((await models.Content.findOne({ title: b.title }))._id);
    }
    assert.equal(
      await models.Content.countDocuments({
        _id: { $in: created },
        published: true,
      }),
      2,
    );
    assert.equal(
      (
        await call(
          admin,
          "put",
          `/admin/games/detective/content/${created[0]}`,
          secondBody,
        )
      ).status,
      200,
    );
    assert.equal(
      await models.Content.countDocuments({
        _id: { $in: created },
        published: true,
      }),
      2,
    );
    const f = await multiplayerFixture("detective", {});
    await models.GameSession.updateOne(
      { _id: f.doc._id },
      { $set: { status: "ABANDONED", retryGranted: true } },
    );
    const started = await call(f.agents[0], "post", "/v1/detective/start", {});
    assert.equal(started.status, 200);
    const firstId = String(created[1]),
      secondId = String(created[0]);
    assert.equal(started.body.case.id, firstId);
    assert.equal(started.body.case.totalCases, 2);
    assert.equal(started.body.case.maximumScore, 150);
    assert.equal(started.body.attempt.totalQuestions, 2);
    assert.equal(started.body.questions[0].correctAnswerIndex, undefined);
    assert.equal(started.body.hints[0].hintText, undefined);
    const sessionId = started.body.attempt.id;
    const hint = (caseId) => ({ caseId, hintId: "shared-hint" });
    const answer = (caseId) => ({
      caseId,
      questionId: "shared-question",
      selectedOptionIndex: 0,
    });
    assert.equal(
      (
        await call(
          f.agents[1],
          "post",
          "/v1/detective/submit-answer",
          answer(firstId),
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(f.agents[0], "post", "/v1/detective/use-hint", hint(firstId)))
        .body.penaltyDeducted,
      125,
    );
    assert.equal(
      (await call(f.agents[0], "post", "/v1/detective/use-hint", hint(firstId)))
        .body.penaltyDeducted,
      0,
    );
    const next = await call(
      f.agents[0],
      "post",
      "/v1/detective/submit-answer",
      answer(firstId),
    );
    assert.equal(next.status, 200);
    assert.equal(next.body.isCaseCompleted, true);
    assert.equal(next.body.attempt.status, "IN_PROGRESS");
    assert.equal(next.body.case.id, secondId);
    assert.equal(next.body.case.caseNumber, 2);
    assert.equal(next.body.attempt.currentQuestionIndex, 0);
    assert.equal(next.body.attempt.answeredQuestions, 1);
    assert.equal(next.body.attempt.score, 0);
    assert.equal(next.body.hints[0].isUsed, false);
    assert.equal(next.body.clues[0].title, "Second case");
    assert.equal(next.body.attempt.expiresAt, started.body.attempt.expiresAt);
    assert.equal(await models.Result.countDocuments({ sessionId }), 0);
    for (const a of f.agents) {
      const state = (await a.get("/api/v1/detective/case")).body;
      assert.equal(state.case.id, secondId);
      assert.equal(state.attempt.answeredQuestions, 1);
    }
    // The snapshotted case survives later content edits/unpublishing.
    await models.Content.updateOne(
      { _id: created[0] },
      { $set: { published: false, "data.questions.0.points": 999 } },
    );
    assert.equal(
      (
        await call(
          f.agents[0],
          "post",
          "/v1/detective/submit-answer",
          answer(firstId),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(f.agents[0], "post", "/v1/detective/submit-answer", {
          questionId: "shared-question",
          selectedOptionIndex: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(f.agents[0], "post", "/v1/detective/use-hint", hint(firstId)))
        .status,
      409,
    );
    assert.equal(
      (
        await call(f.agents[0], "post", "/v1/detective/selection", {
          ...answer(firstId),
          sessionId,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          f.agents[0],
          "post",
          "/v1/detective/use-hint",
          hint(secondId),
        )
      ).body.penaltyDeducted,
      10,
    );
    const final = await call(
      f.agents[0],
      "post",
      "/v1/detective/submit-answer",
      answer(secondId),
    );
    assert.equal(final.status, 200);
    assert.equal(final.body.attempt.status, "COMPLETED");
    assert.equal(final.body.attempt.score, 15); // 150 earned - 125 - 10 penalties.
    assert.equal(final.body.attempt.answeredQuestions, 2);
    assert.equal(final.body.attempt.totalHintsUsed, 2);
    const result = await models.Result.findOne({ sessionId });
    assert.equal(result.score, 15);
    assert.equal(result.maximum, 150);
    assert.equal(await models.Result.countDocuments({ sessionId }), 1);
    assert.equal(
      (
        await call(
          f.agents[0],
          "post",
          "/v1/detective/submit-answer",
          answer(secondId),
        )
      ).status,
      409,
    );
  } finally {
    await models.Content.deleteMany({ _id: { $in: created } });
    await models.Content.updateMany(
      { _id: { $in: published.map((c) => c._id) } },
      { $set: { published: true } },
    );
  }
});

test("Detective: timer expiry between cases preserves accumulated score and finalizes once", async () => {
  const cases = [1, 2].map((n) => ({
    id: `expiry-case-${n}`,
    title: `Case ${n}`,
    clues: [],
    questions: [
      { id: "q", options: ["A", "B"], correctAnswerIndex: 0, points: 50 },
    ],
    hints: [],
  }));
  const f = await multiplayerFixture("detective", {
    cases,
    case: cases[0],
    caseIndex: 0,
    completedCases: [],
    index: 0,
    answers: [],
    hintsUsed: [],
    expiresAt: Date.now() + 600000,
  });
  await models.GameSession.updateOne(
    { _id: f.doc._id },
    { $set: { maximum: 100 } },
  );
  const first = await call(f.agents[0], "post", "/v1/detective/submit-answer", {
    caseId: cases[0].id,
    questionId: "q",
    selectedOptionIndex: 0,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.attempt.status, "IN_PROGRESS");
  await models.GameSession.updateOne(
    { _id: f.doc._id },
    { $set: { "state.expiresAt": Date.now() - 1000 } },
  );
  const expired = await call(f.agents[0], "post", "/v1/detective/sync", {});
  assert.equal(expired.body.attempt.status, "TIME_EXPIRED");
  assert.equal(expired.body.attempt.score, 50);
  assert.equal(expired.body.attempt.answeredQuestions, 1);
  await call(f.agents[0], "post", "/v1/detective/sync", {});
  assert.equal(await models.Result.countDocuments({ sessionId: f.doc._id }), 1);
});
