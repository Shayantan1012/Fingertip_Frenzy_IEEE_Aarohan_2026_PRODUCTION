import { randomInt } from "node:crypto";
import { fail } from "../services/errors.js";
export function sequence(count) {
  const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = 8; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
export const memoryScore = (shown, entered) =>
  shown.reduce((sum, d, i) => sum + (d === entered[i] ? 1 : 0), 0);
export function beginStage(session, stage) {
  // A lost response must not strand a stage before memorization has begun.
  if (session.state.active?.stage === stage && !session.state.active.answerFrom)
    return {
      sequence: session.state.active.shown,
      config: session.config.stages[`stage${stage}`],
    };
  if (stage !== session.state.stage + 1 || stage > 3 || session.state.active)
    fail(409, "This stage is already active or out of order.");
  const cfg = session.config.stages[`stage${stage}`];
  const shown = sequence(cfg.numbersCount);
  session.state.active = {
    stage,
    shown,
    answerFrom: null,
    deadline: null,
    ...(session.state.guessProtocol ? { guesses: [] } : {}),
  };
  return { sequence: shown, config: cfg };
}
export function beginMemoryCountdown(session, now = Date.now()) {
  const active = session.state.active;
  if (!active) fail(409, "Start a stage first.");
  if (active.answerFrom) return active;
  const cfg = session.config.stages[`stage${active.stage}`];
  active.startedAt = now;
  if (session.state.stage === 0) session.startedAt = new Date(now);
  active.answerFrom =
    now + 3000 + cfg.numbersCount * cfg.displayIntervalSeconds * 1000;
  active.deadline = session.testMode
    ? null
    : active.answerFrom +
      cfg.numbersCount * (cfg.responseIntervalSeconds * 1000 + 500) +
      15000;
  return active;
}
export function finishStage(session, stage, entered, now = Date.now()) {
  const active = session.state.active;
  if (!active || active.stage !== stage)
    fail(409, "This stage has already been submitted or is out of order.");
  if (!active.answerFrom || now < active.answerFrom)
    fail(409, "The answering phase has not started.");
  if (
    !Array.isArray(entered) ||
    entered.length !== active.shown.length ||
    entered.some((d) => !Number.isInteger(d) || d < 0 || d > 9)
  )
    fail(400, "Invalid digit sequence.");
  const points =
    !session.testMode && now > active.deadline
      ? 0
      : active.guesses
        ? active.guesses.reduce((sum, g) => sum + (g.correct ? 1 : 0), 0)
        : memoryScore(active.shown, entered);
  if (
    active.guesses &&
    (active.guesses.length !== active.shown.length ||
      active.guesses.some((g, i) => g.digit !== entered[i]))
  )
    fail(409, "Submit the authoritative recorded guesses.");
  session.state.stages.push({
    stage,
    score: points,
    shown: active.shown,
    entered,
    guesses: active.guesses || [],
    durationSeconds: Math.max(
      0,
      (now - (active.startedAt || +session.startedAt)) / 1000,
    ),
  });
  session.state.stage = stage;
  session.state.active = null;
  session.score += points;
  if (stage === 3) {
    session.status = "COMPLETED";
    session.completedAt = new Date(now);
  }
  return points;
}
export function beginGuess(session, index, now = Date.now()) {
  const a = session.state.active;
  if (!a?.answerFrom || now < a.answerFrom)
    fail(409, "The answering phase has not started.");
  a.guesses ||= [];
  if (index !== a.guesses.length || index >= a.shown.length)
    fail(409, "This guess is out of order.");
  if (a.guessIndex !== index) {
    a.guessIndex = index;
    a.guessDeadline = session.testMode
      ? null
      : Math.min(
          a.deadline,
          (index === 0 ? a.answerFrom : now) +
            session.config.stages[`stage${a.stage}`].responseIntervalSeconds *
              1000,
        );
  }
  return { index, deadline: a.guessDeadline, serverNow: now };
}
export function recordGuess(session, index, digit, now = Date.now()) {
  const a = session.state.active;
  const recorded = a?.guesses?.[index];
  if (recorded) return recorded;
  if (!a || a.guessIndex !== index || index !== a.guesses?.length)
    fail(409, "This guess is out of order or was already recorded.");
  const timedOut = !session.testMode && now >= a.guessDeadline;
  if (!timedOut && digit !== a.shown[index])
    fail(
      409,
      "Keep trying. An incorrect gesture is recorded only when the timer expires.",
    );
  const guess = {
    index,
    digit,
    timedOut,
    correct: !timedOut && digit === a.shown[index],
    recordedAt: now,
  };
  a.guesses.push(guess);
  a.guessDeadline = null;
  return guess;
}
