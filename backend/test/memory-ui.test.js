import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const cameraHelper = readFileSync(
  new URL(
    "../../frontend/public/game-assets/shared/camera.js",
    import.meta.url,
  ),
  "utf8",
);
test("Camera startup times out, retires late streams/trackers and permits retry", async () => {
  const timers = new Map();
  let id = 0,
    resolveStream,
    stopped = 0;
  const context = {
    window: {},
    setTimeout: (fn) => {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout: (key) => timers.delete(key),
    navigator: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            resolveStream = resolve;
          }),
      },
    },
  };
  runInNewContext(cameraHelper, context);
  const camera = context.window.ArenaCamera;
  const opening = camera.open({ video: true });
  const timeout = [...timers.values()][0];
  timers.clear();
  timeout();
  await assert.rejects(opening, /Camera permission timed out/);
  resolveStream({ getTracks: () => [{ stop: () => stopped++ }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    stopped,
    1,
    "A late permission grant must not keep the camera on",
  );
  const retry = camera.open({ video: true });
  const stream = { getTracks: () => [] };
  resolveStream(stream);
  assert.equal(await retry, stream);
  assert.equal(timers.size, 0);
  let resolveTracker,
    closed = 0;
  const tracker = camera.wait(
    new Promise((resolve) => {
      resolveTracker = resolve;
    }),
    20000,
    "Tracker timed out",
    (model) => model.close(),
  );
  [...timers.values()][0]();
  await assert.rejects(tracker, /Tracker timed out/);
  resolveTracker({ close: () => closed++ });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});
const source = readFileSync(
  new URL(
    "../../frontend/public/game-assets/memory/js/game.js",
    import.meta.url,
  ),
  "utf8",
);

test("Calculator ignores late polling responses and serializes gesture writes", async () => {
  const html = readFileSync(
    new URL(
      "../../frontend/public/game-assets/calculator/index.html",
      import.meta.url,
    ),
    "utf8",
  );
  const connect = html.slice(
    html.indexOf("async function connect()"),
    html.indexOf("const send ="),
  );
  const requests = [],
    renders = [];
  let poll;
  const context = {
    AbortSignal,
    window: {
      ArenaRealtime: { connect: () => () => {} },
      addEventListener() {},
      removeEventListener() {},
    },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: (path, options) =>
      new Promise((resolve) => requests.push({ path, options, resolve })),
    setInterval: (fn) => {
      poll = fn;
      return 1;
    },
    clearInterval() {},
    show() {},
    startCamera() {},
    $: () => ({}),
    render: () => renders.push(context.state().revision),
  };
  runInNewContext(
    `let S=null, ws=null, rem0=0, t0=0; ${connect}; this.start=connect; this.state=()=>S; this.event=(value='{}')=>ws.send(value);`,
    context,
  );
  const respond = (request, revision) =>
    request.resolve({
      ok: true,
      json: async () => ({ sessionId: "one", revision, remaining: 30 }),
    });
  const start = context.start();
  respond(requests.shift(), 1);
  await start;
  const pendingPoll = poll();
  const pendingEvent = context.event();
  await context.event();
  assert.equal(requests.length, 2); // One poll and one mutation, despite the repeated event.
  respond(requests[1], 3);
  await pendingEvent;
  respond(requests[0], 2);
  await pendingPoll;
  assert.equal(context.state().revision, 3);
  assert.deepEqual(renders, [1, 3]);
  requests.length = 0;
  const first = context.event('{"type":"digit","digit":1}');
  await context.event('{"type":"digit","digit":2}');
  await context.event('{"type":"digit","digit":3}');
  assert.equal(requests.length, 1);
  respond(requests.shift(), 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    JSON.parse(requests[0].options.body).digit,
    3,
    "Send the newest queued gesture after the in-flight write",
  );
  respond(requests.shift(), 5);
  await first;
});

test("Calculator keeps an accepted digit through hand loss and limits inference work", async () => {
  const html = readFileSync(
    new URL(
      "../../frontend/public/game-assets/calculator/index.html",
      import.meta.url,
    ),
    "utf8",
  );
  const camera = html
    .slice(
      html.indexOf("async function startCamera()"),
      html.indexOf("addEventListener('pagehide'"),
    )
    .replace(
      "import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm')",
      "Promise.resolve(model)",
    );
  const frames = [],
    sent = [],
    nodes = new Map();
  let now = 0,
    detections = 0,
    handVisible = true;
  const video = {
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 480,
    play: async () => {},
  };
  const state = {
    phase: "PLAYING",
    paused: false,
    you: { role: "X" },
    values: {},
    question: { question_id: "Q1" },
  };
  const lm = {
    detectForVideo: () => {
      detections++;
      return handVisible
        ? {
            landmarks: [Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }))],
            handednesses: [[{ categoryName: "Left", score: 0.99 }]],
          }
        : { landmarks: [], handednesses: [] };
    },
  };
  const context = {
    running: false,
    window: {},
    setTimeout,
    clearTimeout,
    cameraRun: 0,
    landmarker: null,
    H: {},
    cal: null,
    S: state,
    TUNE: runInNewContext(
      "(" + html.match(/const TUNE = (\{[^;]+\});/)[1] + ")",
    ),
    TH: { on: [1, 1, 1, 1, 1], off: [0.5, 0.5, 0.5, 0.5, 0.5] },
    performance: { now: () => now },
    requestAnimationFrame: (fn) => frames.push(fn),
    navigator: {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    },
    model: {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      HandLandmarker: { createFromOptions: async () => lm },
    },
    $: (key) => {
      if (key === "#cam") return video;
      if (!nodes.has(key))
        nodes.set(key, { classList: { add() {}, remove() {} }, style: {} });
      return nodes.get(key);
    },
    D: () => 0.2,
    feats: () => [0, 2, 2, 0, 0],
    draw() {},
    stopCamera() {},
    send: (event) => {
      sent.push({ ...event, at: now });
      state.values.X = event.digit;
    },
  };
  runInNewContext(cameraHelper, context);
  runInNewContext(camera + ";this.start=startCamera", context);
  await context.start();
  for (let i = 1; i <= 30; i++) {
    now = i * 34;
    video.currentTime = i / 30;
    frames.shift()();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].digit, 2);
  assert.ok(
    sent[0].at <= 300,
    "A stable gesture should be published without the old 400 ms emission gate",
  );
  assert.ok(
    detections <= 16,
    "Do not run synchronous inference on every video frame",
  );
  handVisible = false;
  for (let i = 31; i <= 150; i++) {
    now = i * 34;
    video.currentTime = i / 30;
    frames.shift()();
  }
  assert.equal(
    sent.length,
    1,
    "Brief or sustained hand loss must never erase a saved digit",
  );
  assert.equal(state.values.X, 2);
});

test("Memory rejects ten fingers and clears old detections when the camera stops", () => {
  const vision = readFileSync(
    new URL(
      "../../frontend/public/game-assets/memory/js/vision.js",
      import.meta.url,
    ),
    "utf8",
  );
  const window = {};
  runInNewContext(vision, { window, console, Date });
  const engine = window.visionEngine;
  const noop = () => {};
  engine.canvasElement = { width: 640, height: 480 };
  engine.canvasCtx = {
    save: noop,
    clearRect: noop,
    drawImage: noop,
    restore: noop,
  };
  engine.drawHandMesh = noop;
  engine.countFingers = () => ({ count: 5, fingers: [] });
  engine.isRunning = true;
  engine.processResults({
    image: {},
    multiHandLandmarks: [[], []],
    multiHandedness: [{ label: "Left" }, { label: "Right" }],
  });
  assert.equal(engine.currentDigit, null);
  engine.currentDigit = 7;
  engine.recentDetections = [7];
  engine.stopCamera();
  assert.equal(engine.currentDigit, null);
  assert.equal(engine.recentDetections.length, 0);
});

test("Memory previews the camera while tracking loads and retires old frame loops", async () => {
  const vision = readFileSync(
    new URL(
      "../../frontend/public/game-assets/memory/js/vision.js",
      import.meta.url,
    ),
    "utf8",
  );
  const window = {},
    frames = [];
  let script,
    played = false,
    previewReady;
  const preview = new Promise((resolve) => {
    previewReady = resolve;
  });
  const stream = { getTracks: () => [{ stop() {} }] };
  const context = {
    window,
    console,
    Date,
    setTimeout: () => 1,
    clearTimeout() {},
    requestAnimationFrame: (fn) => frames.push(fn),
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    document: {
      createElement: () => (script = { remove() {} }),
      head: { appendChild() {} },
    },
  };
  runInNewContext(cameraHelper, context);
  runInNewContext(vision, context);
  const engine = window.visionEngine;
  const video = {
    videoWidth: 640,
    videoHeight: 480,
    readyState: 2,
    play: async () => {
      played = true;
      previewReady();
    },
  };
  await engine.init(video, { getContext: () => ({ clearRect() {} }) });
  const start = engine.startCamera();
  await preview;
  assert.equal(played, true);
  assert.equal(engine.isRunning, false); // Preview is open, but no countdown readiness yet.
  window.Hands = class {
    setOptions() {}
    onResults() {}
    async send() {}
  };
  script.onload();
  assert.equal(await start, true);
  const oldFrame = frames[0];
  engine.stopCamera();
  await engine.startCamera();
  const scheduled = frames.length;
  await oldFrame();
  assert.equal(frames.length, scheduled);
  engine.stopCamera();
});
function fixture(cameraReady) {
  const calls = [],
    nodes = new Map(),
    listeners = new Map();
  const node = (key) => {
    if (!nodes.has(key))
      nodes.set(key, {
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        textContent: "",
        disabled: false,
      });
    return nodes.get(key);
  };
  const document = {
    getElementById: node,
    querySelector: node,
    querySelectorAll: () => [],
    addEventListener: (event, fn) => listeners.set(event, fn),
  };
  const window = {
    soundEngine: { init() {}, playCountdownTick() {} },
    app: { showToast: (message) => calls.push(message) },
    visionEngine: {
      init: async () => true,
      startCamera: async () => {
        calls.push("camera");
        return cameraReady;
      },
    },
    platformApi: async (path) => {
      calls.push(path);
      return {
        sequence: [2, 4],
        config: {
          numbersCount: 2,
          displayIntervalSeconds: 1,
          responseIntervalSeconds: 3,
        },
      };
    },
  };
  runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: () => null },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    console,
  });
  const engine = window.gameEngine;
  engine.renderMemorizeSlotsStrip = () => {};
  engine.renderStageSequenceGrid = () => {};
  const startAnswer = engine.startAnswerStep.bind(engine);
  engine.startAnswerStep = () => {};
  return { engine, calls, listeners, startAnswer, node, window };
}
test("Memory briefing does not consume a stage; camera refusal cannot start the server clock", async () => {
  const { engine, calls } = fixture(false);
  await engine.startStage(1);
  assert.deepEqual(calls, []);
  await engine.beginCountdown();
  assert.equal(calls.filter((c) => c.startsWith("/games/")).length, 0);
  assert.match(calls.at(-1), /Hand gestures are required/);
  assert.equal(engine._countdownPending, false);
});
test("Memory starts its stage after camera readiness and answering binds no keyboard input", async () => {
  const { engine, calls, listeners } = fixture(true);
  await engine.startStage(1);
  await engine.beginCountdown();
  assert.deepEqual(calls, [
    "camera",
    "/games/memory/stage/start",
    "/games/memory/stage/countdown",
  ]);
  assert.deepEqual(Array.from(engine.activeSequence), [2, 4]);
  await engine.openOpenCVOutputBox();
  assert.equal(listeners.has("keydown"), false);
});

test("Memory admin practice never starts an answer timeout and still has no keyboard input", async () => {
  const { engine, startAnswer, node, listeners } = fixture(true);
  engine.testMode = true;
  engine.activeSequence = [2, 4];
  await startAnswer(0);
  assert.equal(engine.inputTimer, null);
  assert.match(node("central-status-text").innerHTML, /Unlimited practice/);
  assert.equal(node("central-countdown-text").textContent, "\u221e");
  assert.equal(listeners.has("keydown"), false);
});

test("Memory timeout feedback uses the server result, red strike-through and separate sequence history", async () => {
  const { engine, window, node } = fixture(true);
  engine.activeSequence = [7, 2];
  engine.currentInputIndex = 0;
  window.platformApi = async () => ({
    digit: 7,
    correct: false,
    timedOut: true,
  });
  window.soundEngine.playLockIn = () => {};
  const classes = new Set();
  node("central-detected-card").classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
  };
  const slotClasses = new Set();
  node("stage-slot-0").classList = {
    add: (c) => slotClasses.add(c),
    remove: (c) => slotClasses.delete(c),
  };
  await engine.handleDigitLocked(7, true);
  assert.equal(node("central-detected-digit").textContent, 7);
  assert.ok(classes.has("match-timeout"));
  assert.ok(!classes.has("match-correct"));
  assert.ok(slotClasses.has("slot-timeout"));
  assert.ok(slotClasses.has("slot-wrong"));
  assert.match(
    node("central-status-text").textContent,
    /Timed out.*next number/,
  );
  assert.deepEqual(Array.from(engine.userSequence), [7]);
  const css = readFileSync(
    new URL(
      "../../frontend/public/game-assets/memory/css/viewport.css",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(css, /match-timeout[^}]+line-through/);
});

test("Memory keeps wrong gestures pending and awards the corrected gesture without waiting for expiry", async () => {
  const { engine, calls, window, node } = fixture(true);
  engine.expectedDigit = 7;
  engine.activeSequence = [7, 2];
  engine.isStepLocked = false;
  engine.currentInputIndex = 0;
  const frame = (digit) => ({
    detectedDigit: digit,
    handDetails: [],
    totalExtended: digit,
  });
  engine.updateHudOverlay(frame(4));
  await engine.handleDigitLocked(4, false, false);
  assert.equal(calls.length, 0);
  assert.equal(engine.userSequence.length, 0);
  assert.equal(engine.isStepLocked, false);
  assert.match(
    node("central-status-text").innerHTML,
    /Keep trying until timeout/,
  );
  window.platformApi = async () => ({
    digit: 7,
    correct: true,
    timedOut: false,
  });
  window.soundEngine.playLockIn = () => {};
  engine.correctHoldStartTime = Date.now() - 1100;
  engine.currentHoldDigit = 7;
  engine.updateHudOverlay(frame(7));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.guessResults[0].correct, true);
  assert.match(node("central-status-text").textContent, /Correct.*\+1 point/);
  engine.updateHudOverlay(frame(4));
  assert.equal(
    node("central-detected-digit").textContent,
    7,
    "Pending transition must keep the saved result visible",
  );
});
