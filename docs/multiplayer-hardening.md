# Multiplayer hardening — 9 October 2026

Reproduced before fixes: Detective participant hint unlock returns 200 instead of 403; reset leaves score 100 instead of zero; no puzzle-board persistence endpoint (404); leaderboard has no averageTime or sort validation. Source inspection confirms Detective starts on entry, answer selection is local, only the immediate predecessor gates start and existing attempts bypass dependency gates, reset invalidates only one result, Puzzle moves/clear are local-only, and Calculator uses a serialized POST queue plus 750ms polling rather than push delivery. Memory timeout advances without persistent timeout identity or explicit red struck-out feedback.

## Repairs and verification

| Root cause | Repair | Verification |
| --- | --- | --- |
| Puzzle placement existed only in local React state. | Persist board IDs transactionally; reject member writes, duplicate/unknown pieces, old puzzle/session IDs and stale revisions. | Three independent authenticated clients receive identical moves; reconnect restores the saved board; another team's data stays isolated. |
| Reset left older valid results and nonzero attempt state. | Atomically invalidate all selected-round results, abandon/zero attempts, clear state/completion/presence and grant retry. Preserve other rounds. | Reset score becomes zero. Tests cover team and individual/whole-team Memory reset scopes. |
| Gates checked only one predecessor and existing attempts bypassed checks. | Check every prerequisite on reads, starts and mutations. Push access changes and disable locked dashboard cards even for completed attempts. | Reset Detective; Calculator and Memory APIs reject entry while unrelated round data survives. |
| Detective started on entry, selection was local, and permissions were incomplete. | Explicit pre-start briefing; database-leader-only start/select/answer/hint controls; shared read-only member views. | Three live streams receive selection, hint and completion. Member writes and previous-question replay fail. |
| Completion navigation had duplicate/unverified controls. | One completed-only Proceed to Round 3 action verifies access through the server. | Browser transition to Calculator succeeds after completion. Actual Calculator countdown remains leader-only. |
| Leaderboard lacked completed-round averages and selectable ordering. | Aggregate valid server result durations; add four score/time sorts with secondary tie ranking and matching CSV order. | All four orders, missing-time placement and authoritative average calculation tested. |
| Calculator used 750 ms polling alongside serialized commands and detection smoothing. | Committed-change push delivery; separate 8-second presence heartbeat; preserve accepted digits, coalesce queued gestures and display stable candidates. | Three clients converge without gameplay polling. Existing concurrent-role, offline/recovery and stale-question tests pass. |
| Busy refreshes could discard timer callbacks. | Retain pending clock transitions during serialized refresh. Drive transitions from stored deadlines. | Calculator countdown advances without polling; Memory timeout is recorded automatically. |
| Memory timeout had no persistent timeout identity. | Server-owned ordered guesses/deadlines, idempotent delivery, timeout-aware scoring, red strike-through history/current/review and reconnect restoration. | Matching late guesses cannot score; timeout UI and gesture-only input are tested. |
| Stream revocation raced intentional logout/new login. | Retire streams on auth changes; ignore late callbacks; guard logout generations and offer failed-logout recovery. | Dedicated auth tests reject stale expiry/state and late logout responses. |

## Realtime architecture

Authenticated HTTP commands commit MongoDB state before it is observable. `GET /api/games/:game/events` delivers SSE snapshots derived from committed database change streams. The `progress` stream supplies only the authenticated team's game cards and scores. There is no process-local authoritative room state and no client-selected team routing key.

Filters select the team, current user/session and relevant content/settings. Payloads are reconstructed using redacted game views, never raw change documents. Individual Memory sequences stay private. Stream refreshes revalidate authentication and membership; account revocation ends access. Operation time captured before cursor creation bridges the startup/snapshot race. Refreshes serialize and deduplicate snapshots; revisions reject older same-attempt updates. Reconnect loads current state rather than replaying browser-local history.

Events are `state`, `access` and `renew`. Normal connections renew after 25 seconds, inside the existing 30-second function limit, without a false connection error. Server deadlines govern transitions; clients render countdowns with server clock offsets. Clock processing does not renew Calculator player presence. A truly suspended browser can still become offline after the existing 30-second lease grace period.

This uses [MongoDB change streams](https://www.mongodb.com/docs/drivers/node/v6.x/monitoring-and-logging/change-streams/) and [Vercel streaming functions](https://vercel.com/docs/functions/streaming-functions). Each connection opens a database cursor; the command pool is 40 with bounded queue wait. Actual event-sized concurrency needs load testing against the chosen Atlas/Vercel tiers.

## Permissions, reset and timing

- Puzzle and Detective: members observe; only the database team leader changes shared gameplay, answers and hints.
- Calculator: each member supplies their assigned variable; only the leader starts the countdown. Competition roles lock after starting.
- Memory: each member plays an individual gesture-only attempt; teammates do not receive each other's secret sequences.
- Admin practice remains private and untimed, contributes no leaderboard results, and retains separate reset controls.
- Standings remain admin-only; students receive only their own team's score.

Average time uses the best valid result per shared round. Memory contributes the mean of current members' best durations once all current members complete it. Divide the sum of these round durations by completed rounds; no completions display a dash. New Memory timing excludes inter-stage briefing gaps; new Calculator timing excludes recorded offline pauses. Historical result durations are not rewritten.

Reset clears all attempts/results in its selected scope. Later results are preserved but dependent rounds stay inaccessible until prerequisites are completed again. Memory candidate reset clears that candidate's round; Reset team round clears every member's Memory attempts/results. Team writes fence reset/start/mutation races.

## Test evidence and limits

- Final regression: all 73 tests passed across authentication, database diagnostics, scoring, API integration and arena runtime logic. Three independent authenticated clients and SSE connections represent leader/member 1/member 2, backed by a disposable MongoDB replica set.
- Coverage includes shared Puzzle moves/clear, revision rejection, role rejection, reconnect, team isolation, shared Detective selection/hint/completion, account revocation, Calculator digit delivery and downstream locking, Memory timeout, progression, score privacy, duplicate/out-of-order submission, admin practice and all sorting modes.
- The final full local regression run measured Calculator command-dispatch-to-SSE receipt at 161/160/162 ms across three clients. Separate runs were roughly 0.2–0.6 seconds. This excludes physical inference, WAN latency and Vercel cold starts.
- Browser checks confirmed disabled participant Detective controls with visible clues/hints/selection, completion navigation, restored read-only Puzzle placement, admin average-time sorting and Memory controls without a crash. Puzzle document dimensions matched the 390×844 viewport exactly. Screenshots are saved beside this report.
- Production frontend build, backend/arena syntax checks and lint passed. A read-only check confirmed change-stream availability through the configured local Atlas connection. No production records were changed, and no code was pushed or deployed.

The reported 6–7-second physical-camera delay was not reproduced across physical devices. Inspection identified polling, serialized requests, stabilization and a separate configured five-second solution-confirmation hold. That hold is scoring behavior, not a requirement to delay publishing accepted digits. No fixed production latency is claimed. Three physical camera devices, live Vercel rollover/reconnect, constrained networks and event-sized concurrency still require deployment validation.

## Important files and deployment

`backend/src/services/realtime.js` owns authenticated snapshots and deadline transitions. `services/games.js` and `routes/games.js` enforce state, access and permissions. `routes/admin.js` owns transactional reset. `services/leaderboard.js` calculates averages/ranking. Calculator/Memory game services own timing and recorded guesses.

Frontend Puzzle, Detective, Student, Leaderboard and Admin pages consume the updated state. `frontend/public/game-assets/shared/realtime.js` provides common stream/auth cleanup. Calculator HTML and Memory runtime/CSS handle live digits and timeout feedback. Integration, auth UI, Memory UI and scoring tests provide executable regressions.

Deploy frontend and API together, retaining same-origin `/api` routing, authenticated cookies, the 30-second API duration and Atlas change-stream permissions. Run `node scripts/check-realtime.mjs` for a read-only capability check. Existing Memory attempts retain legacy submission compatibility; new attempts use recorded guesses. Schedule an event pause/rollout boundary and reload arenas after deployment. See `deployment.md` for operational details.
