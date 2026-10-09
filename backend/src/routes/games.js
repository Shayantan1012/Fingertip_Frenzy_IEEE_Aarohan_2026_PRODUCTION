import { Router } from "express";
import { z } from "zod";
import { requireAuth, rateLimit } from "../middleware/security.js";
import { asyncRoute, fail } from "../services/errors.js";
import { gameId } from "../services/validation.js";
import { gameSettings } from "../services/settings.js";
import {
  startGame,
  mutateGame,
  getCurrent,
  puzzleView,
  detectiveView,
  calculatorState,
  calculatorReadState,
  gameCards,
  assertLeader,
} from "../services/games.js";
import {
  beginStage,
  beginMemoryCountdown,
  finishStage,
  beginGuess,
  recordGuess,
} from "../game-services/memory.js";
import { streamArena } from "../services/realtime.js";
const router = Router();
router.use(requireAuth);
router.get(
  "/:gameId/events",
  rateLimit("arena-stream", 90),
  asyncRoute(async (req, res) => {
    const game = z
      .union([gameId, z.literal("progress")])
      .parse(req.params.gameId);
    await streamArena(req, res, game);
  }),
);
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const games = await gameCards(req.user);
    res.json({ games });
  }),
);
router.post(
  "/:gameId/start",
  rateLimit("start", 30),
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId);
    const doc = await startGame(game, req.user);
    res.json({ sessionId: doc._id, status: doc.status });
  }),
);
router.get(
  "/calculator/state",
  rateLimit("calculator-state", 180),
  asyncRoute(async (req, res) => res.json(await calculatorReadState(req.user))),
);
router.post(
  "/calculator/sync",
  rateLimit("calculator-state", 180),
  asyncRoute(async (req, res) => res.json(await calculatorState(req.user))),
);
router.post(
  "/calculator/event",
  rateLimit("calculator-event", 240),
  asyncRoute(async (req, res) => {
    const b = z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("digit"),
          digit: z.number().int().min(0).max(9).nullable(),
          conf: z.number().min(0).max(1),
          questionId: z.string().optional(),
        }),
        z.object({ type: z.literal("start") }),
        z.object({ type: z.literal("role"), role: z.enum(["X", "Y", "Z"]) }),
      ])
      .and(z.object({ sessionId: z.string().optional() }))
      .parse(req.body);
    res.json(await calculatorState(req.user, b));
  }),
);
router.get(
  "/memory/config",
  asyncRoute(async (req, res) => {
    const { doc } = await getCurrent("memory", req.user);
    res.json({
      testMode: req.user.role === "ADMIN",
      stages: (doc?.config || (await gameSettings("memory"))).stages,
    });
  }),
);
router.get(
  "/memory/state",
  asyncRoute(async (req, res) => {
    const { doc } = await getCurrent("memory", req.user);
    res.json({
      stage: doc?.state.stage || 0,
      sessionId: doc?._id,
      active: doc?.state.active
        ? {
            stage: doc.state.active.stage,
            started: Boolean(doc.state.active.answerFrom),
            guesses: doc.state.active.guesses || [],
            guessIndex: doc.state.active.guessIndex,
            guessDeadline: doc.state.active.guessDeadline,
            answerFrom: doc.state.active.answerFrom,
            sequence: doc.state.active.shown,
          }
        : null,
      stages:
        doc?.state.stages.map(({ stage, score }) => ({ stage, score })) || [],
      status: doc?.status || "NOT_STARTED",
      score: doc?.score || 0,
    });
  }),
);
router.post(
  "/memory/stage/start",
  rateLimit("memory-start", 30),
  asyncRoute(async (req, res) => {
    const b = z
      .object({ stage: z.number().int().min(1).max(3) })
      .strict()
      .parse(req.body);
    res.json(
      await mutateGame("memory", req.user, (doc) => ({
        ...beginStage(doc, b.stage),
        sessionId: String(doc._id),
      })),
    );
  }),
);
router.post(
  "/memory/stage/countdown",
  rateLimit("memory-countdown", 30),
  asyncRoute(async (req, res) => {
    const active = await mutateGame("memory", req.user, (doc) =>
      beginMemoryCountdown(doc),
    );
    res.json({
      success: true,
      answerFrom: active.answerFrom,
      serverNow: Date.now(),
    });
  }),
);
router.post(
  "/memory/guess/start",
  rateLimit("memory-guess", 120),
  asyncRoute(async (req, res) => {
    const b = z
      .object({ sessionId: z.string(), index: z.number().int().min(0).max(8) })
      .strict()
      .parse(req.body);
    res.json(
      await mutateGame("memory", req.user, (doc) => {
        if (String(doc._id) !== b.sessionId)
          fail(409, "This attempt was reset.");
        return beginGuess(doc, b.index);
      }),
    );
  }),
);
router.post(
  "/memory/guess",
  rateLimit("memory-guess", 120),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        sessionId: z.string(),
        index: z.number().int().min(0).max(8),
        digit: z.number().int().min(0).max(9),
      })
      .strict()
      .parse(req.body);
    res.json(
      await mutateGame("memory", req.user, (doc) => {
        if (String(doc._id) !== b.sessionId)
          fail(409, "This attempt was reset.");
        return recordGuess(doc, b.index, b.digit);
      }),
    );
  }),
);
router.post(
  "/memory/submit",
  rateLimit("memory-submit", 30),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        stage: z.number().int().min(1).max(3),
        digits: z.array(z.number().int().min(0).max(9)).max(9),
      })
      .strict()
      .parse(req.body);
    res.json(
      await mutateGame("memory", req.user, (doc) => ({
        success: true,
        score: finishStage(doc, b.stage, b.digits),
        total: doc.score,
      })),
    );
  }),
);
export const vortex = Router();
vortex.use(requireAuth);
vortex.get(
  "/game/r1/state",
  asyncRoute(async (req, res) => {
    const { doc, team } = await getCurrent("puzzle", req.user);
    res.json(puzzleView(doc, team, req.user));
  }),
);
vortex.post(
  "/game/r1/sync",
  rateLimit("puzzle-state", 90),
  asyncRoute(async (req, res) => {
    const { doc, team } = await getCurrent("puzzle", req.user, {
      finalize: true,
    });
    res.json(puzzleView(doc, team, req.user));
  }),
);
vortex.post(
  "/game/r1/start",
  rateLimit("puzzle-start", 30),
  asyncRoute(async (req, res) => {
    await startGame("puzzle", req.user);
    const { doc, team } = await getCurrent("puzzle", req.user);
    res.json(puzzleView(doc, team, req.user));
  }),
);
vortex.post(
  "/game/r1/board",
  rateLimit("puzzle-board", 240),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        sessionId: z.string(),
        puzzleId: z.string(),
        revision: z.number().int().min(0),
        board: z.array(z.string().max(100).nullable()).min(4).max(64),
      })
      .strict()
      .parse(req.body);
    await mutateGame("puzzle", req.user, (doc, team) => {
      assertLeader(team, req.user);
      const p = doc.state.puzzles[doc.state.index];
      if (
        String(doc._id) !== b.sessionId ||
        p.id !== b.puzzleId ||
        doc.revision !== b.revision
      )
        fail(
          409,
          "The puzzle changed. Synchronize before moving another tile.",
        );
      const ids = b.board.filter((id) => id !== null);
      if (
        b.board.length !== p.pieces.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !p.pieces.some((piece) => piece.pieceId === id))
      )
        fail(400, "Invalid puzzle arrangement.");
      doc.state.board = b.board;
    });
    const { doc, team } = await getCurrent("puzzle", req.user);
    res.json(puzzleView(doc, team, req.user));
  }),
);
vortex.post(
  "/game/r1/submit",
  rateLimit("puzzle-submit", 90),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        pieceOrder: z.array(z.string().max(100)).min(4).max(64),
        puzzleId: z.string(),
      })
      .strict()
      .parse(req.body);
    const data = await mutateGame("puzzle", req.user, (doc, team) => {
      if (String(team.leaderId) !== String(req.user._id))
        fail(403, "Only the team leader can submit.");
      const s = doc.state,
        p = s.puzzles[s.index];
      if (b.puzzleId !== p.id)
        fail(409, "This puzzle has already been submitted.");
      if (
        b.pieceOrder.length !== p.correctOrder.length ||
        new Set(b.pieceOrder).size !== b.pieceOrder.length ||
        b.pieceOrder.some((id) => !p.correctOrder.includes(id))
      )
        fail(400, "Include every puzzle piece exactly once.");
      const isCorrect = b.pieceOrder.every((id, i) => id === p.correctOrder[i]);
      const pointsAwarded = isCorrect ? p.points : 0;
      s.attempts.push({
        puzzleTitle: p.title,
        isCorrect,
        pointsAwarded,
        submittedAt: new Date(),
      });
      if (isCorrect) {
        doc.score += pointsAwarded;
        s.index++;
        s.board = [];
      } else {
        s.board = b.pieceOrder;
      }
      if (s.index === s.puzzles.length) {
        doc.status = "COMPLETED";
        doc.completedAt = new Date();
      }
      return {
        success: true,
        isCorrect,
        pointsAwarded,
        isRoundCompleted: doc.status === "COMPLETED",
        nextPuzzleUnlocked: isCorrect,
        currentPuzzleIndex: s.index,
        totalPuzzles: s.puzzles.length,
        message: isCorrect
          ? "Correct! Your score has been saved."
          : "Incorrect arrangement. Try again.",
      };
    });
    res.json(data);
  }),
);
vortex.get(
  "/detective/case",
  asyncRoute(async (req, res) => {
    const { doc, team } = await getCurrent("detective", req.user);
    res.json(
      doc
        ? detectiveView(doc, team, req.user)
        : {
            success: true,
            hasStarted: false,
            isLeader: String(team.leaderId) === String(req.user._id),
          },
    );
  }),
);
vortex.post(
  "/detective/start",
  rateLimit("detective-start", 30),
  asyncRoute(async (req, res) => {
    let { doc, team } = await getCurrent("detective", req.user, {
      finalize: true,
    });
    if (!doc) {
      await startGame("detective", req.user);
      ({ doc } = await getCurrent("detective", req.user));
    }
    res.json(detectiveView(doc, team, req.user));
  }),
);
vortex.post(
  "/detective/sync",
  rateLimit("detective-state", 90),
  asyncRoute(async (req, res) => {
    const { doc, team } = await getCurrent("detective", req.user, {
      finalize: true,
    });
    if (!doc) fail(409, "The attempt was reset. Reopen the arena to continue.");
    res.json(detectiveView(doc, team, req.user));
  }),
);
vortex.post(
  "/detective/selection",
  rateLimit("detective-selection", 120),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        sessionId: z.string(),
        caseId: z.string().max(100).optional(),
        questionId: z.string(),
        selectedOptionIndex: z.number().int().min(0).max(9).nullable(),
      })
      .strict()
      .parse(req.body);
    await mutateGame("detective", req.user, (doc, team) => {
      assertLeader(team, req.user);
      assertDetectiveCase(doc.state, b.caseId);
      const q = doc.state.case.questions[doc.state.index];
      if (String(doc._id) !== b.sessionId || q.id !== b.questionId)
        fail(409, "This question changed. Synchronize before answering.");
      if (
        b.selectedOptionIndex !== null &&
        b.selectedOptionIndex >= q.options.length
      )
        fail(400, "Invalid answer option.");
      doc.state.selectedOption = b.selectedOptionIndex;
    });
    const { doc, team } = await getCurrent("detective", req.user);
    res.json(detectiveView(doc, team, req.user));
  }),
);
vortex.post(
  "/detective/submit-answer",
  rateLimit("detective-answer", 60),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        caseId: z.string().max(100).optional(),
        questionId: z.string().max(100),
        selectedOptionIndex: z.number().int().min(0).max(9),
      })
      .strict()
      .parse(req.body);
    const payload = await mutateGame("detective", req.user, (doc, team) => {
      assertLeader(team, req.user);
      assertDetectiveCase(doc.state, b.caseId);
      const s = doc.state,
        q = s.case.questions[s.index];
      if (q.id !== b.questionId)
        fail(
          409,
          "This question has already been submitted or is out of order.",
        );
      if (b.selectedOptionIndex >= q.options.length)
        fail(400, "Invalid answer option.");
      const isCorrect = b.selectedOptionIndex === q.correctAnswerIndex,
        pointsAwarded = isCorrect ? q.points : 0;
      s.answers.push({
        questionId: q.id,
        selectedOptionIndex: b.selectedOptionIndex,
        isCorrect,
        pointsAwarded,
      });
      doc.score = detectiveScore(s);
      s.index++;
      s.selectedOption = null;
      const isCaseCompleted = s.index === s.case.questions.length;
      if (isCaseCompleted) {
        const next = s.cases?.[(s.caseIndex || 0) + 1];
        if (next) {
          s.completedCases.push({
            caseId: s.case.id,
            answers: s.answers,
            hintsUsed: s.hintsUsed,
          });
          s.caseIndex++;
          s.case = next;
          s.index = 0;
          s.answers = [];
          s.hintsUsed = [];
        } else {
          doc.status = "COMPLETED";
          doc.completedAt = new Date();
        }
      }
      return {
        success: true,
        isCorrect,
        pointsAwarded,
        newScore: doc.score,
        currentQuestionIndex: s.index,
        isCaseCompleted,
        status: doc.status,
      };
    });
    const { doc, team } = await getCurrent("detective", req.user);
    res.json({ ...payload, ...detectiveView(doc, team, req.user) });
  }),
);
vortex.post(
  "/detective/use-hint",
  rateLimit("hint", 60),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        hintId: z.string().max(100),
        caseId: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.body);
    const payload = await mutateGame("detective", req.user, (doc, team) => {
      assertLeader(team, req.user);
      assertDetectiveCase(doc.state, b.caseId);
      const s = doc.state,
        h = s.case.hints.find((h) => h.id === b.hintId);
      if (!h || h.enabled === false) fail(404, "Hint is unavailable.");
      if (h.questionId && h.questionId !== s.case.questions[s.index]?.id)
        fail(409, "This hint belongs to a different question.");
      const used = s.hintsUsed.includes(h.id);
      if (!used) {
        s.hintsUsed.push(h.id);
        doc.score = detectiveScore(s);
      }
      return {
        success: true,
        hintText: h.hintText,
        currentScore: doc.score,
        penaltyDeducted: used ? 0 : h.penalty,
      };
    });
    const { doc, team } = await getCurrent("detective", req.user);
    res.json({ ...payload, ...detectiveView(doc, team, req.user) });
  }),
);
export default router;

function assertDetectiveCase(state, caseId) {
  if (
    (caseId !== undefined || state.cases?.length > 1) &&
    caseId !== state.case.id
  )
    fail(409, "The case has changed. Refresh the arena before continuing.");
}

function detectiveScore(state) {
  const cases = state.cases || [state.case];
  const attempts = [
    ...(state.completedCases || []),
    {
      caseId: state.case.id,
      answers: state.answers,
      hintsUsed: state.hintsUsed,
    },
  ];
  let earned = 0,
    penalties = 0;
  for (const attempt of attempts) {
    earned += attempt.answers.reduce(
      (sum, answer) => sum + answer.pointsAwarded,
      0,
    );
    const content = cases.find((c) => c.id === attempt.caseId);
    penalties += content.hints.reduce(
      (sum, hint) =>
        sum + (attempt.hintsUsed.includes(hint.id) ? hint.penalty : 0),
      0,
    );
  }
  return Math.max(0, earned - penalties);
}
