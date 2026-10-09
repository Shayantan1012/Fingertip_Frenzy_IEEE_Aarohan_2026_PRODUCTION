import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise the provider's real async handlers without a DOM or JSX renderer.
const source = readFileSync(
  new URL("../../frontend/src/components/Auth.jsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const body = source.slice(
  source.indexOf("  const [user"),
  source.indexOf("  return (\n    <Context.Provider"),
);
function fixture() {
  const state = [],
    calls = [],
    effects = [],
    handlers = new Map();
  const context = {
    bumpAuthEpoch() {},
    useState(initial) {
      const i = state.length;
      state.push(initial);
      return [
        initial,
        (value) => {
          state[i] = value;
        },
      ];
    },
    useRef: (value) => ({ current: value }),
    useEffect: (fn) => effects.push(fn),
    request: (path) =>
      new Promise((resolve, reject) => calls.push({ path, resolve, reject })),
    window: {
      addEventListener: (name, fn) => handlers.set(name, fn),
      removeEventListener() {},
    },
  };
  runInNewContext(
    `this.auth = (() => { ${body} return {login,logout,refresh}; })();`,
    context,
  );
  effects[0]();
  return { state, calls, handlers, auth: context.auth };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Late session checks cannot sign out a newly logged-in user or restore a logged-out user", async () => {
  const f = fixture(),
    user = { id: "one", role: "STUDENT" };
  const check = f.calls.shift();
  const login = f.auth.login({});
  f.calls.shift().resolve({ user });
  await login;
  check.reject(Object.assign(new Error("Expired"), { status: 401 }));
  await flush();
  assert.deepEqual(f.state[0], user);
  assert.equal(f.state[1], false);
  const refresh = f.auth.refresh(),
    late = f.calls.shift();
  const logout = f.auth.logout();
  f.calls.shift().resolve({ success: true });
  await logout;
  late.resolve({ user });
  await refresh;
  assert.equal(f.state[0], null);
});

test("A protected request from an older login cannot expire the new session", async () => {
  const api = readFileSync(
    new URL("../../frontend/src/services/api.js", import.meta.url),
    "utf8",
  ).replaceAll("export ", "");
  const calls = [],
    events = [];
  const context = {
    AbortSignal,
    Event,
    fetch: () => new Promise((resolve) => calls.push(resolve)),
    window: { dispatchEvent: (e) => events.push(e) },
  };
  runInNewContext(
    api + ";this.fetchApi=apiFetch;this.bump=bumpAuthEpoch;",
    context,
  );
  const old = context.fetchApi("/api/teams/me");
  context.bump();
  calls.shift()({ status: 401 });
  await old;
  assert.equal(events.filter((e) => e.type === "session-expired").length, 0);
  const fresh = context.fetchApi("/api/teams/me");
  calls.shift()({ status: 401 });
  await fresh;
  assert.equal(events.filter((e) => e.type === "session-expired").length, 1);
});

test("Temporary session failures offer retry without discarding authentication; only 401 expires it", async () => {
  const f = fixture(),
    user = { id: "one" };
  f.calls.shift().resolve({ user });
  await flush();
  const failed = f.auth.refresh();
  f.calls
    .shift()
    .reject(Object.assign(new Error("Server unavailable"), { status: 503 }));
  await failed;
  assert.deepEqual(f.state[0], user);
  assert.equal(f.state[3], "Server unavailable");
  const retry = f.auth.refresh();
  f.calls.shift().resolve({ user });
  await retry;
  assert.equal(f.state[3], "");
  const expired = f.auth.refresh();
  f.calls.shift().reject(Object.assign(new Error("Expired"), { status: 401 }));
  await expired;
  assert.equal(f.state[0], null);
});

test("Rejected login finishes loading and an expiry event invalidates pending session reads", async () => {
  const f = fixture();
  const initial = f.calls.shift();
  const login = f.auth.login({});
  f.calls.shift().reject(new Error("Invalid credentials"));
  await assert.rejects(login, /Invalid credentials/);
  assert.equal(f.state[1], false);
  initial.resolve({ user: { id: "old" } });
  await flush();
  assert.equal(f.state[0], null);
  const check = f.auth.refresh(),
    pending = f.calls.shift();
  f.handlers.get("session-expired")();
  pending.resolve({ user: { id: "old" } });
  await check;
  assert.equal(f.state[0], null);
  assert.equal(f.state[2], true);
});

test("Intentional logout ignores concurrent stream expiry and does not overwrite a newer login", async () => {
  const f = fixture();
  f.calls.shift().resolve({ user: { id: "old" } });
  await flush();
  const logout = f.auth.logout(),
    pending = f.calls.shift();
  f.handlers.get("session-expired")();
  assert.equal(f.state[2], false);
  const login = f.auth.login({});
  f.calls.shift().resolve({ user: { id: "new" } });
  await login;
  pending.resolve({ success: true });
  await logout;
  assert.equal(f.state[0].id, "new");
  assert.equal(f.state[2], false);
});

test("Live arena connections close on auth changes and ignore late state or expiry events", () => {
  const listeners = new Map(),
    target = new EventTarget(),
    events = [];
  target.Event = Event;
  target.addEventListener("session-expired", () => events.push("expired"));
  let closed = false;
  const context = {
    window: { parent: target },
    EventSource: class {
      addEventListener(n, fn) {
        listeners.set(n, fn);
      }
      close() {
        closed = true;
      }
    },
  };
  runInNewContext(
    readFileSync(
      new URL(
        "../../frontend/public/game-assets/shared/realtime.js",
        import.meta.url,
      ),
      "utf8",
    ),
    context,
  );
  const stop = context.window.ArenaRealtime.connect(
    "puzzle",
    () => events.push("state"),
    () => events.push("access"),
  );
  target.dispatchEvent(new Event("auth-changing"));
  assert.equal(closed, true);
  listeners.get("state")({ data: "{}" });
  listeners.get("access")({ data: '{"status":401}' });
  assert.deepEqual(events, []);
  stop();
});

test("Failed logout offers session recovery after retiring live streams", async () => {
  const f = fixture();
  f.calls.shift().resolve({ user: { id: "one" } });
  await flush();
  const logout = f.auth.logout();
  f.calls.shift().reject(new Error("Network unavailable"));
  await assert.rejects(logout, /Network/);
  assert.equal(f.state[0].id, "one");
  assert.equal(f.state[3], "Network unavailable");
  const recovery = f.auth.refresh();
  f.calls.shift().resolve({ user: { id: "one" } });
  await recovery;
  assert.equal(f.state[3], "");
});
