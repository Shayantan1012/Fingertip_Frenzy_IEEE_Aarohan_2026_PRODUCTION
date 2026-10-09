import { randomInt, createHash } from "node:crypto";
// Allow several missed polls/cold starts before freezing the shared clock.
export const CALCULATOR_PRESENCE_MS = 30000;
// Identical expression templates and constraints to the original Python generator.
const templates = {
  1: [
    "X+Y+Z",
    "X+Y-Z",
    "X-Y+Z",
    "X*Y+Z",
    "X+Y*Z",
    "X*Y-Z",
    "X*Z+Y",
    "Y*Z+X",
    "X*Z-Y",
    "Y*Z-X",
  ],
  2: [
    "X*Y+X*Z",
    "X*Y+Y*Z",
    "X*Z+Y*Z",
    "X*Y-X*Z",
    "X*X+Y*Z",
    "X*Y+X-Z",
    "X*Y-X+Z",
    "Y*Z+Y+X",
    "X*Z+X+Y",
  ],
  3: [
    "X*(Y+Z)+X",
    "(X+Y)*(X+Z)",
    "(X+Y)*(X-Z)",
    "(X+Y)*Z-X",
    "(X+Z)*Y+X",
    "X*(Y-Z)+Y",
    "(X+Y)*Z+Y",
    "(X+Y)*(Y+Z)",
    "(X+Y)*X+Z",
    "X*(X+Y)-Z",
    "(X-Y)*(X+Z)",
  ],
};
const constraints = {
  "X > Y": (x, y) => x > y,
  "Y < Z": (x, y, z) => y < z,
  "X is even": (x) => x % 2 === 0,
  "Z is odd": (x, y, z) => z % 2 === 1,
  "X > Y > Z": (x, y, z) => x > y && y > z,
  "X even, Y odd, Z > 2": (x, y, z) => x % 2 === 0 && y % 2 === 1 && z > 2,
  "Z odd, X > Y": (x, y, z) => z % 2 === 1 && x > y,
};
const byLevel = {
  2: Object.keys(constraints).slice(0, 4),
  3: Object.keys(constraints).slice(4),
};
// Compile only the closed, server-owned template set. Client expressions are never evaluated.
const functions = new Map(
  Object.values(templates)
    .flat()
    .map((expr) => [expr, new Function("X", "Y", "Z", `return ${expr}`)]),
);
export const evaluate = (expr, x, y, z) => functions.get(expr)?.(x, y, z);
export const satisfies = (q, x, y, z) =>
  evaluate(q.expr, x, y, z) === q.target &&
  (!q.con || constraints[q.con](x, y, z));
export function generateQuestion(level, n, history = [], cfg) {
  for (let i = 0; i < 900; i++) {
    const expr = templates[level][randomInt(templates[level].length)],
      list = byLevel[level],
      con = list ? list[randomInt(list.length)] : null;
    const digits = [randomInt(10), randomInt(10), randomInt(10)];
    if (
      new Set(digits).size === 1 ||
      digits.filter((v) => v > 0).length < 2 ||
      (con && !constraints[con](...digits))
    )
      continue;
    const target = evaluate(expr, ...digits);
    if (target < 3 || target > 200) continue;
    const hash = createHash("sha256")
      .update(`${expr}|${target}|${con}|${level}`)
      .digest("hex");
    if (history.includes(hash)) continue;
    let solutions = 0;
    for (let x = 0; x < 10; x++)
      for (let y = 0; y < 10; y++)
        for (let z = 0; z < 10; z++)
          if (satisfies({ expr, target, con }, x, y, z)) solutions++;
    const ranges = { 1: [10, 999], 2: [2, 30], 3: [1, 8] },
      relax = Math.floor(i / 200),
      [lo, hi] = ranges[level];
    if (
      solutions < Math.max(1, Math.floor(lo / (1 + relax))) ||
      solutions > hi * (1 + relax)
    )
      continue;
    return {
      id: `Q${n}`,
      expr,
      target,
      con,
      level,
      hash,
      time_limit: cfg.time[level],
    };
  }
  throw new Error("Question generation exhausted.");
}
export function initializeCalculator(members, _cfg) {
  return {
    phase: members.length === 3 ? "ASSIGN" : "LOBBY",
    roles: Object.fromEntries(members.map((id, i) => ["XYZ"[i], String(id)])),
    values: {},
    presence: {},
    history: [],
    log: [],
    n: 0,
    deadline: null,
    hold: null,
    last: null,
    changed: 0,
    checked: null,
    pausedMs: 0,
    pausedAt: null,
  };
}
function nextQuestion(s, cfg, now, last = null, untimed = false) {
  s.n++;
  s.values = {};
  s.checked = null;
  s.last = last;
  s.hold = null;
  if (s.n > cfg.sequence.length) {
    s.phase = "FINISHED";
    s.question = null;
    s.deadline = null;
    return;
  }
  s.question = generateQuestion(cfg.sequence[s.n - 1], s.n, s.history, cfg);
  s.history.push(s.question.hash);
  s.phase = s.n === 1 ? "ASSIGN" : "PLAYING";
  s.deadline = s.n === 1 || untimed ? null : now + s.question.time_limit * 1000;
  s.changed = now;
}
export function advanceCalculator(
  session,
  team,
  user,
  event = {},
  now = Date.now(),
  presence = null,
) {
  const s = session.state,
    cfg = session.config,
    uid = String(user._id);
  // Presence is a renewable lease, persisted in MongoDB and shared across function instances.
  const priorPresence = presence ? presence[uid] : s.presence[uid] || 0;
  if (presence) s.presence = presence;
  else s.presence[uid] = now + CALCULATOR_PRESENCE_MS;
  if (session.testMode) {
    for (const id of team.memberIds)
      s.presence[String(id)] = now + CALCULATOR_PRESENCE_MS;
  }
  const allOnline =
    team.memberIds.length === 3 &&
    team.memberIds.every((id) => (s.presence[String(id)] || 0) > now);
  if (s.phase === "LOBBY" && team.memberIds.length === 3) {
    s.roles = Object.fromEntries(
      team.memberIds.map((id, i) => ["XYZ"[i], String(id)]),
    );
    nextQuestion(s, cfg, now, null, session.testMode);
  }
  if (s.phase === "ASSIGN" && s.n === 0)
    nextQuestion(s, cfg, now, null, session.testMode);
  if (session.testMode && ["COUNTDOWN", "PLAYING"].includes(s.phase)) {
    s.phase = "PLAYING";
    s.deadline = null;
    s.hold = null;
  }
  const live = ["COUNTDOWN", "PLAYING"].includes(s.phase);
  // A request arriving after a presence lease lapses must pause at the lease boundary,
  // not at the later request time. Preserve elapsed time before that boundary.
  const onlineBoundary = Math.min(
    ...team.memberIds.map((id) =>
      String(id) === uid && priorPresence
        ? priorPresence
        : s.presence[String(id)] || 0,
    ),
  );
  // Advance a countdown that ended while everyone was still connected before
  // calculating the pause. Otherwise a late reconnect grants a fresh question timer.
  if (
    s.phase === "COUNTDOWN" &&
    s.hold === null &&
    s.deadline &&
    s.deadline <= Math.min(now, onlineBoundary || now)
  ) {
    s.phase = "PLAYING";
    s.deadline += s.question.time_limit * 1000;
    s.changed = now;
  }
  if (
    live &&
    !session.testMode &&
    s.hold === null &&
    s.deadline &&
    (!allOnline || onlineBoundary < now)
  ) {
    const freeze = Math.min(now, onlineBoundary || now);
    s.hold = Math.max(0, s.deadline - freeze);
    s.pausedAt = freeze;
    s.deadline = null;
  }
  if (s.hold !== null && allOnline) {
    s.pausedMs =
      (s.pausedMs || 0) + (s.pausedAt ? Math.max(0, now - s.pausedAt) : 0);
    s.pausedAt = null;
    s.deadline = now + s.hold;
    s.hold = null;
    s.changed = now;
  }
  const role = Object.keys(s.roles).find((key) => s.roles[key] === uid);
  if (
    event.type === "role" &&
    (s.phase === "ASSIGN" || session.testMode) &&
    ["X", "Y", "Z"].includes(event.role) &&
    role
  ) {
    const other = s.roles[event.role];
    s.roles[event.role] = uid;
    s.roles[role] = other;
  }
  if (
    event.type === "start" &&
    s.phase === "ASSIGN" &&
    String(team.leaderId) === uid &&
    allOnline
  ) {
    s.phase = session.testMode ? "PLAYING" : "COUNTDOWN";
    s.deadline = session.testMode ? null : now + cfg.countdown * 1000;
    session.startedAt = new Date(now);
  }
  if (
    event.type === "digit" &&
    (!event.questionId || event.questionId === s.question?.id) &&
    s.phase === "PLAYING" &&
    s.hold === null &&
    role
  ) {
    if (event.digit === null) {
      delete s.values[role];
      s.changed = now;
    } else if (
      Number.isInteger(event.digit) &&
      event.digit >= 0 &&
      event.digit <= 9 &&
      event.conf >= cfg.minConf &&
      s.values[role] !== event.digit
    ) {
      s.values[role] = event.digit;
      s.changed = now;
    }
  }
  if (s.hold === null && s.deadline <= now && s.deadline) {
    if (s.phase === "COUNTDOWN") {
      s.phase = "PLAYING";
      s.deadline += s.question.time_limit * 1000;
      s.changed = now;
    } else if (s.phase === "PLAYING") {
      s.log.push({ n: s.n, pts: 0, ok: false });
      nextQuestion(s, cfg, now, { ok: false, timeUp: true }, session.testMode);
    }
  }
  if (
    s.phase === "PLAYING" &&
    s.hold === null &&
    "XYZ".split("").every((k) => Number.isInteger(s.values[k])) &&
    now - s.changed >= cfg.lockSeconds * 1000
  ) {
    const digits = "XYZ".split("").map((k) => s.values[k]),
      key = digits.join(",");
    if (key !== s.checked) {
      s.checked = key;
      if (satisfies(s.question, ...digits)) {
        const bonus = session.testMode
            ? 0
            : Math.max(0, Math.ceil((s.deadline - now) / 1000)) * cfg.speed,
          pts = cfg.base[s.question.level] + bonus;
        s.log.push({ n: s.n, pts, ok: true });
        session.score += pts;
        nextQuestion(s, cfg, now, { ok: true, pts, bonus }, session.testMode);
      }
    }
  }
  if (s.phase === "FINISHED") {
    session.status = "COMPLETED";
    session.completedAt = new Date(now);
  }
  return session;
}
export function calculatorView(session, team, members, user, now = Date.now()) {
  const s = session.state,
    q = s.question;
  return {
    testMode: Boolean(session.testMode),
    serverNow: now,
    attempt: session.attempt || 1,
    sessionId: String(session._id),
    revision: session.revision || 0,
    team_id: String(team._id),
    team: team.name,
    code: team.code,
    phase: s.phase,
    score: session.score,
    minConfidence: session.config.minConf,
    log: s.log,
    attempts: 0,
    remaining: session.testMode
      ? null
      : Math.max(
          0,
          Math.ceil((s.hold ?? (s.deadline ? s.deadline - now : 0)) / 1000),
        ),
    values: s.values,
    res:
      q && "XYZ".split("").every((k) => Number.isInteger(s.values[k]))
        ? evaluate(q.expr, s.values.X, s.values.Y, s.values.Z)
        : null,
    solutionValid:
      q && "XYZ".split("").every((k) => Number.isInteger(s.values[k]))
        ? satisfies(q, s.values.X, s.values.Y, s.values.Z)
        : null,
    n: s.n,
    total: session.config.sequence.length,
    locking: "XYZ".split("").every((k) => k in s.values),
    last: s.last,
    paused: s.hold !== null,
    leader: String(team.leaderId),
    solved: s.log.filter((x) => x.ok).length,
    minutes:
      Math.round(
        ((session.completedAt ? +new Date(session.completedAt) : now) -
          +new Date(session.startedAt)) /
          6000,
      ) / 10,
    players: members.map((p) => ({
      id: String(p._id),
      name: p.name,
      online: (s.presence[String(p._id)] || 0) > now,
      role: Object.keys(s.roles).find((k) => s.roles[k] === String(p._id)),
      leader: String(p._id) === String(team.leaderId),
    })),
    you: {
      id: String(user._id),
      role: Object.keys(s.roles).find((k) => s.roles[k] === String(user._id)),
      leader: String(user._id) === String(team.leaderId),
    },
    question: q
      ? {
          question_id: q.id,
          expression: q.expr.replaceAll("*", "×"),
          target: q.target,
          difficulty: q.level,
          time_limit: q.time_limit,
          constraint: q.con,
        }
      : null,
  };
}
