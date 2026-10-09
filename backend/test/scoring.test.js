import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sequence,
  memoryScore,
  beginStage,
  beginMemoryCountdown,
  finishStage,
  beginGuess,
  recordGuess,
} from "../src/game-services/memory.js";
import {
  generateQuestion,
  satisfies,
  initializeCalculator,
  advanceCalculator,
  evaluate,
  calculatorView,
} from "../src/game-services/calculator.js";
import { defaults, schemas } from "../src/game-services/config.js";
import { mergeSettings } from "../src/services/settings.js";
import { availabilityReason } from "../src/services/games.js";
test("Partial Memory settings retain organizer restrictions and recover missing stages", () => {
  const config = mergeSettings(defaults.memory, {
    enabled: false,
    stages: { stage1: { numbersCount: 3 } },
  });
  assert.equal(config.enabled, false);
  assert.equal(config.stages.stage1.numbersCount, 3);
  assert.equal(config.stages.stage1.responseIntervalSeconds, 5);
  assert.deepEqual(config.stages.stage2, defaults.memory.stages.stage2);
  assert.ok(availabilityReason(config));
  assert.deepEqual(
    mergeSettings(defaults.memory, { stages: null }).stages,
    defaults.memory.stages,
  );
});
test("Game entry reports paused, scheduled, closed and invalid schedules consistently", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(availabilityReason(defaults.memory, now), null);
  assert.match(
    availabilityReason({ ...defaults.memory, enabled: false }, now),
    /paused/,
  );
  assert.match(
    availabilityReason(
      { ...defaults.memory, startAt: "2026-10-08T12:00:00Z" },
      now,
    ),
    /opens/,
  );
  assert.match(
    availabilityReason(
      { ...defaults.memory, endAt: "2026-10-06T12:00:00Z" },
      now,
    ),
    /closed/,
  );
  assert.match(
    availabilityReason({ ...defaults.memory, startAt: "invalid" }, now),
    /correction/,
  );
});
import { normalized, rankRows } from "../src/services/leaderboard.js";
test("Memory preserves no-repeat digits, positional score and all three stages", () => {
  for (let n = 1; n <= 9; n++) {
    const s = sequence(n);
    assert.equal(s.length, n);
    assert.equal(new Set(s).size, n);
    assert.ok(s.every((d) => d >= 1 && d <= 9));
  }
  assert.equal(memoryScore([1, 2, 3], [1, 3, 2]), 1);
  const doc = {
    config: defaults.memory,
    state: { stage: 0, stages: [], active: null },
    score: 0,
  };
  const stage = beginStage(doc, 1);
  assert.throws(() => beginStage(doc, 2), /out of order/);
  assert.throws(() => finishStage(doc, 1, stage.sequence), /not started/);
  const now = 1000;
  beginMemoryCountdown(doc, now);
  finishStage(doc, 1, stage.sequence, doc.state.active.answerFrom + 1000);
  assert.equal(doc.score, 5);
  assert.throws(
    () => finishStage(doc, 1, stage.sequence),
    /already been submitted/,
  );
});
test("Calculator generates valid equations from all original difficulty templates", () => {
  for (let level = 1; level <= 3; level++) {
    for (let n = 1; n <= 8; n++) {
      const q = generateQuestion(level, n, [], defaults.calculator);
      let solved = false;
      for (let x = 0; x < 10 && !solved; x++)
        for (let y = 0; y < 10 && !solved; y++)
          for (let z = 0; z < 10 && !solved; z++)
            solved = satisfies(q, x, y, z);
      assert.ok(solved);
      assert.ok(q.target >= 3 && q.target <= 200);
    }
  }
  assert.equal(evaluate("X+Y*Z", 2, 3, 4), 14);
  assert.equal(evaluate("process.exit()", 1, 2, 3), undefined);
});
test("Calculator keeps leader-only start and pauses at an offline lease boundary", () => {
  const cfg = structuredClone(defaults.calculator),
    team = { memberIds: ["x", "y", "z"], leaderId: "x" },
    doc = {
      config: cfg,
      state: initializeCalculator(team.memberIds, cfg),
      startedAt: new Date(1000),
      score: 0,
    };
  for (const id of team.memberIds)
    advanceCalculator(doc, team, { _id: id }, {}, 1000);
  advanceCalculator(doc, team, { _id: "y" }, { type: "start" }, 1500);
  assert.equal(doc.state.phase, "ASSIGN");
  advanceCalculator(doc, team, { _id: "x" }, { type: "start" }, 1500);
  assert.equal(doc.state.phase, "COUNTDOWN");
  for (const id of team.memberIds)
    advanceCalculator(doc, team, { _id: id }, {}, 4500);
  assert.equal(doc.state.phase, "PLAYING");
  const deadline = doc.state.deadline;
  // Camera inference, cold starts and a missed poll must not interrupt play.
  advanceCalculator(doc, team, { _id: "x" }, {}, 12000);
  assert.equal(doc.state.hold, null);
  advanceCalculator(doc, team, { _id: "x" }, {}, 35000);
  assert.equal(doc.state.hold, deadline - 34500);
  assert.equal(doc.state.deadline, null);
  advanceCalculator(doc, team, { _id: "y" }, {}, 35100);
  advanceCalculator(doc, team, { _id: "z" }, {}, 35200);
  assert.equal(doc.state.hold, null);
  assert.equal(doc.state.deadline, 35200 + deadline - 34500);
});

test("Calculator preserves time elapsed after countdown when the next request arrives offline", () => {
  const team = { memberIds: ["x", "y", "z"], leaderId: "x" };
  const doc = {
    config: structuredClone(defaults.calculator),
    state: initializeCalculator(team.memberIds),
    score: 0,
  };
  for (const id of team.memberIds)
    advanceCalculator(doc, team, { _id: id }, {}, 1000);
  advanceCalculator(doc, team, { _id: "x" }, { type: "start" }, 1000);
  const questionDeadline =
    doc.state.deadline + doc.state.question.time_limit * 1000;
  advanceCalculator(doc, team, { _id: "x" }, {}, 32000);
  assert.equal(doc.state.phase, "PLAYING");
  assert.equal(doc.state.hold, questionDeadline - 31000);
});

test("Memory retries reuse an unstarted sequence but cannot replay a running stage", () => {
  const doc = {
    config: defaults.memory,
    state: { stage: 0, stages: [], active: null },
    score: 0,
  };
  const first = beginStage(doc, 1);
  assert.deepEqual(beginStage(doc, 1), first);
  beginMemoryCountdown(doc, 1000);
  assert.throws(() => beginStage(doc, 1), /already active/);
});

test("Calculator rejects stale gesture values and locks competition roles after starting", () => {
  const team = { memberIds: ["x", "y", "z"], leaderId: "x" };
  const doc = {
    config: structuredClone(defaults.calculator),
    state: initializeCalculator(team.memberIds),
    score: 0,
  };
  for (const id of team.memberIds)
    advanceCalculator(doc, team, { _id: id }, {}, 1000);
  advanceCalculator(doc, team, { _id: "x" }, { type: "start" }, 1000);
  for (const id of team.memberIds)
    advanceCalculator(doc, team, { _id: id }, {}, 4500);
  const roles = { ...doc.state.roles };
  advanceCalculator(doc, team, { _id: "x" }, { type: "role", role: "Z" }, 4600);
  assert.deepEqual(doc.state.roles, roles);
  advanceCalculator(
    doc,
    team,
    { _id: "x" },
    { type: "digit", digit: 8, conf: 1, questionId: "old" },
    4700,
  );
  assert.deepEqual(doc.state.values, {});
  advanceCalculator(
    doc,
    team,
    { _id: "x" },
    { type: "digit", digit: 8, conf: 1, questionId: doc.state.question.id },
    4800,
  );
  assert.equal(doc.state.values.X, 8);
});

test("Calculator output reflects operator precedence and constraints without awarding an invalid solution", () => {
  const team = { _id: "team", memberIds: ["x", "y", "z"], leaderId: "x" };
  const doc = {
    _id: "attempt",
    revision: 7,
    config: defaults.calculator,
    state: initializeCalculator(team.memberIds),
    score: 0,
    startedAt: new Date(1000),
  };
  doc.state.question = {
    id: "Q1",
    expr: "X+Y*Z",
    target: 14,
    con: "X > Y",
    level: 2,
  };
  doc.state.values = { X: 2, Y: 3, Z: 4 };
  const view = calculatorView(doc, team, [], { _id: "x" }, 2000);
  assert.equal(view.res, 14);
  assert.equal(view.solutionValid, false);
  assert.equal(view.revision, 7);
  assert.equal(view.sessionId, "attempt");
  delete doc.state.values.Z;
  assert.equal(calculatorView(doc, team, [], { _id: "x" }, 2000).res, null);
});
test("Normalized weights do not let the large raw-score games overwhelm Memory", () => {
  assert.equal(normalized(22, 22, 25), 250);
  assert.equal(normalized(1000, 1000, 25), 250);
  assert.equal(normalized(99999, 100, 25), 250);
  assert.equal(normalized(10, 0, 25), 0);
});
test("Rank ties use completed games, completion time, then stable identity", () => {
  const rows = rankRows([
    { _id: "c", total: 100, completed: 2, completionTime: 20 },
    { _id: "a", total: 100, completed: 3, completionTime: 10 },
    { _id: "b", total: 100, completed: 3, completionTime: 10 },
  ]);
  assert.deepEqual(
    rows.map((r) => r._id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    rows.map((r) => r.rank),
    [1, 2, 3],
  );
});
test("Game settings reject unsupported controls and unreasonable values", () => {
  assert.ok(schemas.memory.safeParse(defaults.memory).success);
  assert.equal(
    schemas.memory.safeParse({ ...defaults.memory, adminPassword: "secret" })
      .success,
    false,
  );
  assert.equal(
    schemas.calculator.safeParse({
      ...defaults.calculator,
      time: { 1: -5, 2: 60, 3: 80 },
    }).success,
    false,
  );
});

test("Admin practice has no answer deadlines; competition Memory still expires", () => {
  for (const testMode of [true, false]) {
    const doc = {
      testMode,
      config: defaults.memory,
      state: { stage: 0, stages: [], active: null },
      score: 0,
    };
    const { sequence: shown } = beginStage(doc, 1);
    beginMemoryCountdown(doc, 1000);
    assert.equal(doc.state.active.deadline === null, testMode);
    assert.equal(
      finishStage(doc, 1, shown, 10 ** 9),
      testMode ? shown.length : 0,
    );
  }
  const team = { memberIds: ["a", "b", "c"], leaderId: "a" };
  const doc = {
    testMode: true,
    state: initializeCalculator(team.memberIds),
    config: defaults.calculator,
    score: 0,
  };
  advanceCalculator(doc, team, { _id: "a" }, {}, 1000);
  advanceCalculator(doc, team, { _id: "a" }, { type: "start" }, 1000);
  assert.equal(doc.state.phase, "PLAYING");
  const id = doc.state.question.id;
  advanceCalculator(doc, team, { _id: "a" }, {}, 10 ** 9);
  assert.equal(doc.state.question.id, id);
  assert.equal(doc.state.deadline, null);
  assert.equal(doc.state.log.length, 0);
});

test("Memory wrong gestures wait for expiry, corrected gestures earn a point and timed-out matches earn zero", () => {
  const doc = {
    config: structuredClone(defaults.memory),
    state: {
      stage: 0,
      stages: [],
      active: {
        stage: 1,
        shown: [7, 2],
        answerFrom: 1000,
        deadline: 20000,
        guesses: [],
      },
    },
    score: 0,
    startedAt: new Date(1000),
  };
  beginGuess(doc, 0, 1000);
  assert.throws(
    () => recordGuess(doc, 0, 4, 1100),
    /only when the timer expires/,
  );
  assert.equal(doc.state.active.guesses.length, 0);
  const correct = recordGuess(doc, 0, 7, 1200);
  assert.equal(correct.correct, true);
  const timing = beginGuess(doc, 1, 1300);
  assert.throws(
    () => recordGuess(doc, 1, 9, 1400),
    /only when the timer expires/,
  );
  const expired = recordGuess(doc, 1, 2, timing.deadline);
  assert.equal(expired.correct, false);
  assert.equal(expired.timedOut, true);
  assert.equal(finishStage(doc, 1, [7, 2], timing.deadline + 10), 1);
  assert.equal(doc.score, 1);
});
