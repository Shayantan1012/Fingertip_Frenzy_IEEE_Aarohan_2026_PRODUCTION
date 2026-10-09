import {
  GameSession,
  Result,
  Content,
  User,
  CalculatorPresence,
} from "../models/index.js";
import { transaction } from "../config/db.js";
import { teamFor } from "./teams.js";
import { gameSettings } from "./settings.js";
import {
  initializeCalculator,
  advanceCalculator,
  calculatorView,
  CALCULATOR_PRESENCE_MS,
} from "../game-services/calculator.js";
import { fail } from "./errors.js";
import { puzzleData, detectiveData } from "./content.js";
import { names } from "../game-services/config.js";
export async function gameCards(user) {
  const games = await Promise.all(
    ["puzzle", "detective", "calculator", "memory"].map(async (id) => {
      const config = await gameSettings(id);
      const doc =
        user.teamId &&
        (await GameSession.findOne(sessionFilter(id, user))
          .sort({ attempt: -1 })
          .select("status score"));
      const missingContent =
        ["puzzle", "detective"].includes(id) &&
        (!doc || doc.status === "ABANDONED") &&
        !(await Content.exists({ gameId: id, published: true }));
      const unavailableReason =
        availabilityReason(config) ||
        (missingContent
          ? `The organizer has not published ${id === "puzzle" ? "a puzzle" : "a Detective case"} yet.`
          : null);
      return {
        id,
        name: names[id],
        enabled: config.enabled,
        available: !unavailableReason,
        unavailableReason,
        weight: config.weight,
        locked: Boolean(await roundLock(id, user)),
        status: doc?.status || "NOT_STARTED",
        score: doc?.score || 0,
      };
    }),
  );
  return games;
}
export function assertAvailable(config, now = Date.now()) {
  const reason = availabilityReason(config, now);
  if (reason) fail(403, reason);
}
export function availabilityReason(config, now = Date.now()) {
  if (!config.enabled)
    return "The organizer has paused this game. Please contact the event desk.";
  if (
    [config.startAt, config.endAt].some(
      (value) => value && !Number.isFinite(+new Date(value)),
    )
  )
    return "The game schedule needs an organizer correction.";
  if (config.startAt && now < +new Date(config.startAt))
    return `This game opens at ${new Date(config.startAt).toISOString()}.`;
  if (config.endAt && now > +new Date(config.endAt))
    return "This game's entry window has closed. Please contact the event desk.";
  return null;
}
export const scopeFor = (game, user) =>
  user.role === "ADMIN"
    ? `admin:${user._id}`
    : game === "memory"
      ? `${user.teamId}:${user._id}`
      : String(user.teamId);
// Match historical Memory attempts by their original ownership, while new
// attempts get a team-specific scope for the unique attempt index.
export const sessionFilter = (game, user) =>
  game === "memory" && user.role !== "ADMIN"
    ? {
        gameId: game,
        teamId: user.teamId,
        userId: user._id,
        testMode: { $ne: true },
      }
    : { gameId: game, scope: scopeFor(game, user) };
export const gameOrder = ["puzzle", "detective", "calculator", "memory"];
export async function roundLock(game, user, tx) {
  if (user.role === "ADMIN") return null;
  const previousRounds = gameOrder.slice(0, gameOrder.indexOf(game));
  if (!previousRounds.length) return null;
  const completed = await Result.distinct("gameId", {
    teamId: user.teamId,
    gameId: { $in: previousRounds },
    valid: true,
  }).session(tx || null);
  return previousRounds.find((id) => !completed.includes(id)) || null;
}
export async function assertRoundAccess(game, user, tx) {
  const locked = await roundLock(game, user, tx);
  if (locked) fail(403, `Complete ${locked} before accessing this round.`);
}
export function assertLeader(team, user) {
  if (String(team.leaderId) !== String(user._id))
    fail(403, "Only the team leader can perform this action.");
}
export async function finishResult(doc, session) {
  if (doc.status !== "COMPLETED" || doc.testMode) return;
  await Result.updateOne(
    { sessionId: doc._id },
    {
      $setOnInsert: {
        sessionId: doc._id,
        valid: true,
        teamId: doc.teamId,
        userId: doc.userId,
        gameId: doc.gameId,
        score: doc.score,
        maximum: doc.maximum,
        attempt: doc.attempt,
        completionTime:
          doc.gameId === "memory" &&
          doc.state.stages?.every((s) => Number.isFinite(s.durationSeconds))
            ? doc.state.stages.reduce((sum, s) => sum + s.durationSeconds, 0)
            : Math.max(
                0,
                (+doc.completedAt -
                  +doc.startedAt -
                  (doc.state.pausedMs || 0)) /
                  1000,
              ),
        completedAt: doc.completedAt,
      },
    },
    { upsert: true, session },
  );
}
export async function startGame(game, user) {
  let result;
  await transaction(async (tx) => {
    const team = await teamFor(user, tx),
      cfg = await gameSettings(game, tx);
    if (user.role !== "ADMIN") assertAvailable(cfg);
    const locked = await roundLock(game, user, tx);
    if (locked)
      fail(403, "Complete the previous round before starting this game.");
    if (["puzzle", "detective"].includes(game)) assertLeader(team, user);
    if (game === "calculator" && team.memberIds.length !== 3)
      fail(
        409,
        "AI Calculator requires exactly three team members for X, Y and Z.",
      );
    const scope = scopeFor(game, user);
    let previous = await GameSession.findOne(sessionFilter(game, user))
      .sort({ attempt: -1 })
      .session(tx);
    if (previous?.status === "IN_PROGRESS") {
      result = previous;
      return;
    }
    if (
      previous &&
      user.role !== "ADMIN" &&
      previous.attempt >= cfg.maxAttempts &&
      !previous.retryGranted
    )
      fail(409, "All permitted attempts have been used.");
    const startedAt = new Date(),
      state = {};
    let maximum;
    if (game === "memory") {
      Object.assign(state, {
        stage: 0,
        stages: [],
        active: null,
        guessProtocol: 1,
      });
      maximum = Object.values(cfg.stages).reduce(
        (a, b) => a + b.numbersCount,
        0,
      );
    }
    if (game === "calculator") {
      Object.assign(state, initializeCalculator(team.memberIds, cfg));
      maximum = cfg.sequence.reduce(
        (a, l) => a + cfg.base[l] + cfg.time[l] * cfg.speed,
        0,
      );
    }
    if (game === "puzzle") {
      const contents = await Content.find({ gameId: game, published: true })
        .sort({ order: 1, _id: 1 })
        .session(tx)
        .lean();
      if (!contents.length)
        fail(409, "No puzzles have been published by the event organizer.");
      if (contents.some((c) => !puzzleData.safeParse(c.data).success))
        fail(
          409,
          "A published puzzle is incomplete. Ask the organizer to correct and save its image and tiles.",
        );
      state.puzzles = contents.map((c) => ({
        ...c.data,
        id: String(c._id),
        title: c.title,
      }));
      state.index = 0;
      state.attempts = [];
      state.expiresAt =
        user.role === "ADMIN" ? null : +startedAt + cfg.durationSeconds * 1000;
      maximum = state.puzzles.reduce((a, p) => a + p.points, 0);
    }
    if (game === "detective") {
      const content = await Content.findOne({ gameId: game, published: true })
        .sort({ order: 1 })
        .session(tx)
        .lean();
      if (!content?.data?.questions?.length)
        fail(
          409,
          "No detective case has been published by the event organizer.",
        );
      if (!detectiveData.safeParse(content.data).success)
        fail(
          409,
          "The published Detective case is incomplete. Ask the organizer to correct and save its questions and clues.",
        );
      state.case = {
        ...content.data,
        id: String(content._id),
        title: content.title,
      };
      state.index = 0;
      state.answers = [];
      state.hintsUsed = [];
      state.expiresAt =
        user.role === "ADMIN" ? null : +startedAt + cfg.durationSeconds * 1000;
      maximum = state.case.questions.reduce((a, q) => a + q.points, 0);
    }
    [result] = await GameSession.create(
      [
        {
          scope,
          gameId: game,
          userId: user._id,
          teamId: team._id,
          testMode: user.role === "ADMIN",
          attempt: (previous?.attempt || 0) + 1,
          startedAt,
          maximum,
          state,
          config: cfg,
        },
      ],
      { session: tx },
    );
    // Touch the team in the same transaction so game start and membership edits cannot race.
    if (!team.testMode) {
      team.updatedAt = new Date();
      await team.save({ session: tx });
    }
  });
  return result;
}
export async function mutateGame(game, user, fn) {
  let payload;
  await transaction(async (tx) => {
    const team = await teamFor(user, tx);
    await assertRoundAccess(game, user, tx);
    if (user.role !== "ADMIN") assertAvailable(await gameSettings(game, tx));
    const doc = await GameSession.findOne(sessionFilter(game, user))
      .sort({ attempt: -1 })
      .session(tx);
    if (!doc) fail(409, "Start the game first.");
    if (doc.status !== "IN_PROGRESS")
      fail(409, "This attempt has already finished.");
    if (
      !doc.testMode &&
      doc.state.expiresAt &&
      Date.now() > doc.state.expiresAt
    ) {
      doc.status = "COMPLETED";
      doc.completedAt = new Date(doc.state.expiresAt);
      payload = { expired: true };
    } else payload = await fn(doc, team, tx);
    doc.revision++;
    doc.markModified("state");
    await doc.save({ session: tx });
    if (!team.testMode) {
      team.updatedAt = new Date();
      await team.save({ session: tx });
    }
    await finishResult(doc, tx);
  });
  return payload;
}
export async function calculatorState(user, event = {}) {
  if (!event.type) await assertRoundAccess("calculator", user);
  let view;
  const scope = scopeFor("calculator", user);
  let recent = await GameSession.findOne({ scope, gameId: "calculator" }).sort({
    attempt: -1,
  });
  if (
    event.sessionId &&
    (!recent ||
      recent.status === "ABANDONED" ||
      event.sessionId !== String(recent._id))
  )
    fail(409, "This attempt was reset. Refresh the arena before continuing.");
  if (!recent || recent.status === "ABANDONED") {
    try {
      await startGame("calculator", user);
    } catch (error) {
      // Simultaneous first connections can race on the unique attempt index.
      if (
        error.code !== 11000 ||
        !(await GameSession.exists({ scope, gameId: "calculator" }))
      )
        throw error;
    }
    recent = await GameSession.findOne({ scope, gameId: "calculator" }).sort({
      attempt: -1,
    });
  }
  if (recent.status === "COMPLETED") {
    await assertRoundAccess("calculator", user);
    const team = await teamFor(user),
      members = team.testMode
        ? team.members
        : await User.find({ _id: { $in: team.memberIds } });
    return calculatorView(recent, team, members, user);
  }
  // Gesture commands skip heartbeat-only reads. Permissions, dependencies and
  // state are checked once inside the committing transaction.
  if (event.type) {
    if (event.type !== "clock")
      await CalculatorPresence.updateOne(
        { sessionId: recent._id, userId: user._id },
        { $set: { expiresAt: new Date(Date.now() + CALCULATOR_PRESENCE_MS) } },
        { upsert: true },
      );
    await mutateGame("calculator", user, async (doc, team, tx) => {
      if (
        String(doc._id) !== String(recent._id) ||
        (event.sessionId && event.sessionId !== String(doc._id))
      )
        fail(409, "This attempt was reset. Reopen the arena.");
      if (event.type === "start") assertLeader(team, user);
      const presence = Object.fromEntries(
        (
          await CalculatorPresence.find({ sessionId: doc._id })
            .session(tx)
            .lean()
        ).map((p) => [String(p.userId), +p.expiresAt]),
      );
      advanceCalculator(doc, team, user, event, Date.now(), presence);
      const members = team.testMode
        ? team.members
        : await User.find({ _id: { $in: team.memberIds } })
            .select("name")
            .session(tx);
      view = calculatorView(doc, team, members, user);
      view.revision = doc.revision + 1;
    });
    return view;
  }
  const team = await teamFor(user);
  if (user.role !== "ADMIN") assertAvailable(await gameSettings("calculator"));
  const leaseKey = { sessionId: recent._id, userId: user._id };
  const renew = () =>
    CalculatorPresence.updateOne(
      leaseKey,
      {
        $set: { expiresAt: new Date(Date.now() + CALCULATOR_PRESENCE_MS) },
      },
      { upsert: true },
    );
  try {
    await renew();
  } catch (error) {
    if (error.code !== 11000) throw error;
    await renew();
  }
  const readPresence = async (tx = null) =>
    Object.fromEntries(
      (
        await CalculatorPresence.find({ sessionId: recent._id })
          .session(tx)
          .lean()
      ).map((p) => [String(p.userId), +p.expiresAt]),
    );
  const presence = await readPresence(),
    now = Date.now(),
    s = recent.state;
  const online =
    team.testMode ||
    team.memberIds.every((id) => (presence[String(id)] || 0) > now);
  const live = ["COUNTDOWN", "PLAYING"].includes(s.phase);
  const readyToCheck =
    s.phase === "PLAYING" &&
    "XYZ".split("").every((k) => Number.isInteger(s.values[k])) &&
    now - s.changed >= recent.config.lockSeconds * 1000 &&
    "XYZ"
      .split("")
      .map((k) => s.values[k])
      .join(",") !== s.checked;
  // Normal polls only renew this participant's lease and read the game. Write the
  // shared document for an event, a clock transition, a pause/resume or scoring.
  if (
    !event.type &&
    s.n > 0 &&
    s.hold === null &&
    !(live && (!online || (s.deadline && s.deadline <= now) || readyToCheck))
  ) {
    recent.state.presence = team.testMode
      ? Object.fromEntries(
          team.memberIds.map((id) => [
            String(id),
            now + CALCULATOR_PRESENCE_MS,
          ]),
        )
      : presence;
    const members = team.testMode
      ? team.members
      : await User.find({ _id: { $in: team.memberIds } });
    return calculatorView(recent, team, members, user);
  }
  await mutateGame("calculator", user, async (doc, team, tx) => {
    if (String(doc._id) !== String(recent._id))
      fail(409, "This attempt was reset. Refresh the arena before continuing.");
    if (event.sessionId && event.sessionId !== String(doc._id))
      fail(409, "This attempt was reset. Refresh the arena before continuing.");
    const currentPresence = await readPresence(tx);
    advanceCalculator(doc, team, user, event, Date.now(), currentPresence);
    const members = team.testMode
      ? team.members
      : await User.find({ _id: { $in: team.memberIds } }).session(tx);
    view = calculatorView(doc, team, members, user);
    // mutateGame increments the persisted revision after this callback.
    view.revision = doc.revision + 1;
  });
  return view;
}
export async function calculatorReadState(user) {
  const { doc, team } = await getCurrent("calculator", user);
  if (!doc)
    fail(409, "Connect to the calculator arena before reading its state.");
  const presence = await CalculatorPresence.find({ sessionId: doc._id }).lean();
  doc.state.presence = Object.fromEntries(
    presence.map((p) => [String(p.userId), +p.expiresAt]),
  );
  const members = team.testMode
    ? team.members
    : await User.find({ _id: { $in: team.memberIds } });
  return calculatorView(doc, team, members, user);
}
export async function getCurrent(game, user, { finalize = false } = {}) {
  const team = await teamFor(user);
  if (user.role !== "ADMIN") assertAvailable(await gameSettings(game));
  await assertRoundAccess(game, user);
  const doc = await GameSession.findOne(sessionFilter(game, user)).sort({
    attempt: -1,
  });
  if (doc?.status === "ABANDONED") return { team, doc: null };
  if (
    doc?.status === "IN_PROGRESS" &&
    !doc.testMode &&
    doc.state.expiresAt &&
    Date.now() > doc.state.expiresAt
  ) {
    if (finalize) {
      await mutateGame(game, user, () => ({}));
      return { team, doc: await GameSession.findById(doc._id) };
    }
    // A read can report expiry, but persisting a result requires an explicit POST.
    doc.status = "COMPLETED";
    doc.completedAt = new Date(doc.state.expiresAt);
  }
  return { team, doc };
}
export function puzzleView(doc, team, user) {
  const done = doc?.status === "COMPLETED",
    p = doc && !done ? doc.state.puzzles[doc.state.index] : null;
  const pieces = p?.pieces
    ?.map(({ pieceId, imageUrl }) => ({ pieceId, imageUrl }))
    .sort(() => Math.random() - 0.5);
  return {
    success: true,
    testMode: Boolean(doc?.testMode),
    hasStarted: !!doc,
    isLeader: String(team.leaderId) === String(user._id),
    teamName: team.name,
    isCompleted: done,
    isExpired: done && doc.state.index < doc.state.puzzles.length,
    session: doc
      ? {
          id: doc._id,
          revision: doc.revision,
          status: doc.status,
          score: doc.score,
          currentPuzzleIndex: doc.state.index,
          totalPuzzles: doc.state.puzzles.length,
          remainingSeconds: doc.testMode
            ? null
            : Math.max(0, Math.ceil((doc.state.expiresAt - Date.now()) / 1000)),
          expiresAt: doc.testMode ? null : new Date(doc.state.expiresAt),
          startTime: doc.startedAt,
          attemptsCount: doc.state.attempts.length,
          attempts: doc.state.attempts,
          board: doc.state.board || Array(p?.pieces?.length || 0).fill(null),
        }
      : null,
    currentPuzzle: p ? { ...p, correctOrder: undefined, pieces } : null,
    team: { id: team._id, name: team.name, code: team.code },
  };
}
export function detectiveView(doc, team, user) {
  const c = doc.state.case;
  return {
    success: true,
    isLeader: team && user ? String(team.leaderId) === String(user._id) : false,
    hasStarted: true,
    serverNow: Date.now(),
    caseAvailable: true,
    case: {
      id: c.id,
      title: c.title,
      description: c.description,
      difficulty: c.difficulty,
      maximumScore: doc.maximum,
      suspects: c.suspects || [],
    },
    clues: c.clues,
    questions: c.questions.map(
      ({ correctAnswerIndex: _correctAnswerIndex, ...q }) => ({
        ...q,
        _id: q.id,
      }),
    ),
    hints: c.hints.map(({ hintText, ...h }) => ({
      ...h,
      _id: h.id,
      isUsed: doc.state.hintsUsed.includes(h.id),
      hintText: doc.state.hintsUsed.includes(h.id) ? hintText : undefined,
    })),
    attempt: {
      id: doc._id,
      revision: doc.revision,
      selectedOption: doc.state.selectedOption ?? null,
      answers: doc.state.answers,
      testMode: Boolean(doc.testMode),
      score: doc.score,
      currentQuestionIndex: doc.state.index,
      status:
        doc.status === "COMPLETED" && doc.state.index < c.questions.length
          ? "TIME_EXPIRED"
          : doc.status,
      hintsUsed: doc.state.hintsUsed,
      expiresAt: doc.testMode ? null : new Date(doc.state.expiresAt),
      startedAt: doc.startedAt,
      completedAt: doc.completedAt,
    },
  };
}
