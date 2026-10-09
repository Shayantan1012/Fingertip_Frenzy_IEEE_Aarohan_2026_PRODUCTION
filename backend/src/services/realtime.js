import mongoose from "mongoose";
import {
  AuthSession,
  User,
  GameSession,
  Result,
  Team,
  GameSetting,
  CalculatorPresence,
  Content,
} from "../models/index.js";
import {
  getCurrent,
  puzzleView,
  detectiveView,
  calculatorReadState,
  calculatorState,
  sessionFilter,
  gameCards,
  mutateGame,
} from "./games.js";
import { fail } from "./errors.js";
import { teamDetails } from "./teams.js";
import { leaderboard } from "./leaderboard.js";
import { recordGuess } from "../game-services/memory.js";

export async function arenaSnapshot(game, user) {
  if (game === "progress") {
    const team = await teamDetails(user);
    const scores = team
      ? await leaderboard({ teamId: team._id, limit: 1 })
      : null;
    const row = scores?.rows[0];
    return {
      games: await gameCards(user),
      team,
      score: row ? { scores: row.scores, total: row.total } : null,
    };
  }
  if (game === "calculator") return calculatorReadState(user);
  const { doc, team } = await getCurrent(game, user);
  if (game === "puzzle")
    return { ...puzzleView(doc, team, user), serverNow: Date.now() };
  if (game === "detective")
    return doc
      ? detectiveView(doc, team, user)
      : {
          success: true,
          hasStarted: false,
          isLeader: String(team.leaderId) === String(user._id),
          serverNow: Date.now(),
        };
  return {
    sessionId: doc?._id,
    revision: doc?.revision,
    score: doc?.score || 0,
    status: doc?.status || "NOT_STARTED",
    stage: doc?.state.stage || 0,
    active: doc?.state.active
      ? {
          stage: doc.state.active.stage,
          guesses: doc.state.active.guesses || [],
          guessDeadline: doc.state.active.guessDeadline,
        }
      : null,
    serverNow: Date.now(),
  };
}

// Each connection watches committed database changes, not process-local rooms.
// This also works when the three clients reach different serverless instances.
export async function streamArena(req, res, game) {
  const initialTeam = String(req.user.teamId || req.user._id);
  const teamId = req.user.role === "ADMIN" ? req.user._id : req.user.teamId;
  let closed = false,
    working = false,
    dirty = false,
    pendingTick = false,
    timer,
    last = "",
    heartbeat,
    lifetime;
  const clock = await mongoose.connection.db.command({ hello: 1 });
  const watch = mongoose.connection.db.watch(
    [
      {
        $match: {
          $or: [
            {
              "ns.coll": Content.collection.name,
              ...(game === "progress" ? {} : { "fullDocument.gameId": game }),
            },
            {
              "ns.coll": GameSession.collection.name,
              "fullDocument.teamId": teamId,
            },
            {
              "ns.coll": Result.collection.name,
              "fullDocument.teamId": teamId,
            },
            { "ns.coll": Team.collection.name, "documentKey._id": teamId },
            {
              "ns.coll": User.collection.name,
              "documentKey._id": req.user._id,
            },
            {
              "ns.coll": AuthSession.collection.name,
              "documentKey._id": req.authSession._id,
            },
            {
              "ns.coll": GameSetting.collection.name,
              ...(game === "progress" ? {} : { "fullDocument.gameId": game }),
            },
            {
              "ns.coll": CalculatorPresence.collection.name,
              "fullDocument.userId": {
                $in: (await Team.findById(teamId).select("memberIds"))
                  ?.memberIds || [req.user._id],
              },
            },
          ],
        },
      },
    ],
    {
      fullDocument: "updateLookup",
      maxAwaitTimeMS: 500,
      startAtOperationTime: clock.operationTime,
    },
  );
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    void watch.close().catch(() => {});
    res.end();
  };
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // A single valid snapshot can exceed Node's high-water mark. Allow it to
    // drain; retire only clients that accumulate excessive queued output.
    if (res.writableLength > 2 * 1024 * 1024) close();
  };
  async function refresh(tick = false) {
    if (closed) return;
    if (working) {
      dirty = true;
      pendingTick ||= tick;
      return;
    }
    working = true;
    try {
      const [user, session] = await Promise.all([
        User.findOne({ _id: req.user._id, status: "ACTIVE" }),
        AuthSession.exists({
          _id: req.authSession._id,
          expiresAt: { $gt: new Date() },
        }),
      ]);
      if (!user || !session)
        fail(401, "Your session has expired. Please log in again.");
      if (String(user.teamId || user._id) !== initialTeam)
        fail(403, "Your team membership changed. Reopen the arena.");
      req.user = user;
      if (tick && game === "calculator")
        await calculatorState(user, { type: "clock" });
      const data = await arenaSnapshot(game, user);
      // serverNow is refreshed on delivery, but must not produce duplicate snapshots.
      const key = JSON.stringify({ ...data, serverNow: undefined });
      if (key !== last) {
        last = key;
        send("state", data);
      }
      clearTimeout(timer);
      if (game === "progress") return;
      const doc = await GameSession.findOne(sessionFilter(game, user)).sort({
        attempt: -1,
      });
      if (doc?.status === "IN_PROGRESS") {
        let due = doc.state.expiresAt;
        if (game === "memory") due = doc.state.active?.guessDeadline;
        if (game === "calculator") {
          const s = doc.state;
          const options = [s.deadline];
          if (
            s.phase === "PLAYING" &&
            s.hold === null &&
            "XYZ".split("").every((k) => Number.isInteger(s.values[k])) &&
            "XYZ"
              .split("")
              .map((k) => s.values[k])
              .join(",") !== s.checked
          )
            options.push(s.changed + doc.config.lockSeconds * 1000);
          if (["COUNTDOWN", "PLAYING"].includes(s.phase) && s.hold === null)
            options.push(
              ...(
                await CalculatorPresence.find({ sessionId: doc._id }).lean()
              ).map((p) => +p.expiresAt),
            );
          due = Math.min(...options.filter((t) => Number.isFinite(t) && t));
        }
        if (Number.isFinite(due))
          timer = setTimeout(
            async () => {
              try {
                if (game === "memory")
                  await mutateGame("memory", user, (current) => {
                    const a = current.state.active;
                    if (
                      a?.guessDeadline &&
                      Date.now() >= a.guessDeadline &&
                      a.guesses.length === a.guessIndex
                    )
                      recordGuess(current, a.guessIndex, 0);
                  });
                else if (game !== "calculator")
                  await getCurrent(game, user, { finalize: true });
                await refresh(game === "calculator");
              } catch {
                await refresh();
              }
            },
            Math.max(10, due - Date.now() + 5),
          );
      }
    } catch (error) {
      send("access", {
        status: error.status || 503,
        message:
          error.status < 500
            ? error.message
            : "Realtime connection interrupted. Reconnecting…",
      });
      last = "";
      if (error.status === 401 || !error.status || error.status >= 500) close();
    } finally {
      working = false;
      if (closed) clearTimeout(timer);
      if (dirty && !closed) {
        dirty = false;
        const tick = pendingTick;
        pendingTick = false;
        void refresh(tick);
      }
    }
  }
  watch.on("change", () => void refresh());
  watch.on("error", () => {
    send("access", {
      status: 503,
      message: "Realtime connection interrupted. Reconnecting…",
    });
    close();
  });
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "private, no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 500\n\n");
  res.on("close", close);
  // The captured operation time bridges cursor setup and the first snapshot.
  await refresh();
  if (closed) return;
  heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
    void refresh();
  }, 10000);
  // Reconnect before the configured 30-second Vercel function limit.
  lifetime = setTimeout(() => {
    send("renew", {});
    close();
  }, 25000);
}
