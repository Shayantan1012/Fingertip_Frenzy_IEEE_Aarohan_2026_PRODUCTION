# Vercel and MongoDB deployment

No deployment has been performed by the coding task. Use the repository root as the Vercel project directory. Deploy the new platform rather than any of the three original project folders.

1. Create a MongoDB Atlas cluster and a dedicated `aarohan` database. Use a least-privilege database user with read/write access to this database. Atlas supplies the replica set required by team and scoring transactions.
2. Configure Atlas network access for your Vercel egress arrangement. Choose an appropriate deployment region near the Atlas region. Do not paste credentials into committed files or chat.
3. Add `MONGODB_URI`, `APP_ORIGIN` (the exact final HTTPS origin), and `NODE_ENV=production` to Vercel. Preview deployments need their own matching origin and a separate test database. No frontend API URL or Firebase credential is required; all browser APIs are same-origin.
4. Use Node 22 LTS or a supported newer Node runtime in Vercel. Run `npm ci` and `npm run build` locally. Root `vercel.json` defines a root workspace build, static output and Node API function.
5. Import the root repository into Vercel, or use the Vercel CLI: `vercel` for a preview and `vercel --prod` for production. Deployment was not executed here. Do not deploy the test data or `.cache` directory.
6. Before opening registration, run the administrator bootstrap locally against the intended database with privately set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (16+ characters). Run `npm run bootstrap`, then remove the bootstrap password. The script refuses to run when an admin already exists.
7. Normal participants use leader registration and five-field login; pre-import is unnecessary. If migrating historical participants, supply their full matching identity including email and team association. Optional legacy imports use `npm run import:students -- students.json` first, then `npm run import:students -- students.json --apply`. Input is a JSON array of `{name, rollNo, phoneNo, email?}`. Database conflicts roll back the entire import. Do not automatically run imports at deployment.
8. Review legacy data via `npm run migrate`, following `docs/migration.md`. Back up both source and target before applying.
9. Publish real Puzzle and Detective content. Configure each game's window, attempts, weights and game-specific controls from the admin page.
10. Verify HTTPS, `/api/health`, login/logout, cookie flags, direct URL refresh, all four games on real devices, leader registration, first-login teammate enrollment, ordered round unlocking, leaderboard updates and audited score corrections. Verify camera access inside the same-origin frames.

## Current Vercel configuration — single project

The latest repository commit switched to a single-project layout. This layout is now explicit and verified through the full local Vercel production build. Set Framework Preset to **Other**, Root Directory to the repository root (blank or `.`), and Node.js to **24.x**. Clear dashboard command/output overrides; root vercel.json defines them. The checked-in `framework: null` disables framework auto-detection and overrides a stale preset. Do not switch back to Services without restoring a services configuration and rechecking installation/output packaging together.

One root install explicitly selects both @aarohan/backend and @aarohan/frontend, includes dev dependencies and the workspace root, then npm run build compiles both applications. Static output is frontend/dist. api/index.js exports the backend Express application as the Node function. api/ must be included in uploads for this layout. Same-origin /api requests reach this function. No runtime service bindings are needed.

Only root package.json contains the pinned esbuild@0.25.12 allowScripts approval. Workspace-level fields are ignored by npm; frontend/package.json has no allowScripts field. Both private .env files and their templates are excluded from upload; configure runtime environment variables in Vercel. Original game repositories, documentation, tests, caches and local node_modules remain excluded. Backend/frontend sources, manifests, root lockfile, api and scripts remain included.

## Routing and connections

The /api/:path* rewrite targets /api/index, the exported Express function. SPA routes use index.html. The fallback excludes assets, file extensions and Calculator/Memory frames so JavaScript, CSS, favicon and game documents are served directly. Backend Express routes retain the /api prefix. backend/src/server.js is local development only.

MongoDB connection creation is cached per function instance; sessions, game state, rate limit windows, scores and audit records are MongoDB data. Instances have no shared in-memory production state. Authentication uses opaque random cookie tokens and stores only token hashes. Cookies are secure in production, HTTP-only and SameSite=Lax. Every state-changing request must match `APP_ORIGIN`. Keep frontend and API on one origin.

Indexes are declared in the models. Before the event, run `node scripts/indexes.mjs` against the database to create/verify indexes without destructive `syncIndexes` calls. MongoDB's leaderboard window function requires MongoDB 5.0 or newer.

Security headers include nosniff, referrer policy, same-origin framing and camera permissions scoped to self. Root vercel.json sets a route-specific CSP: the platform permits only same-origin scripts; game frames additionally permit retained inline handlers, WebAssembly and the MediaPipe CDN/model host. Both deny objects and restrict framing, forms and base URLs. Original inline game code requires this more permissive frame policy. Validate the policy on the deployed HTTPS origin and actual cameras before launch.

## Operations

- Login endpoints use persistent rate-limit counters. Origin checking is strict; a mismatched public domain returns 403.
- Team names cannot change after registration, including for administrators. Identity edits revoke existing sessions. Replace a leader before deleting that member, and reset active attempts before removing members. Team deletion abandons active attempts and revokes member sessions. Team/member deletion retains historical records. Score correction, invalidation and attempt reset require reasons and create audit records within the mutation transaction.
- CSV exports use the same page and filters as the displayed table (25 rows by default; optional `limit` up to 100). Pass `page`, `search`, `gameId`, or `completed` as appropriate. Formula-like values are escaped. There is no unbounded production export query.
- Game-state GET requests are read-only. Arenas use POST `/api/games/calculator/sync`, `/api/v1/game/r1/sync`, and `/api/v1/detective/sync` for heartbeats and expiry finalization. Detective entry explicitly posts to `/api/v1/detective/start`. Keep the frontend and backend on the same release when deploying this API change.
- New puzzle uploads use random asset IDs so URL order cannot disclose the solution. Audit older uploads with `node scripts/refresh-puzzle-assets.mjs`. If it reports legacy puzzles, finish/reset active Puzzle attempts and run the same command with `--apply` before the event. It clones tile assets, preserves piece identities and old URLs, and records an audit entry; active attempt snapshots are never rewritten. Back up the database before any operational migration.
- Leaderboard updates are derived from current valid results. Recalculation occurs on every request rather than maintaining a stale second leaderboard collection.
- Database errors return 503 with a safe diagnostic code and request ID. Vercel function logs contain the same code/ID without connection strings, passwords or participant details. The service never writes a fallback JSON file or manufactures results.

## Build-log troubleshooting

`Removed ... ignored files` is an informational upload-filter message. Private .env files, documentation, tests, cached builds and legacy game sources are intentionally excluded. Excluding .env.example does not remove runtime environment variables configured in Vercel.

Earlier deployment failures included npm EUSAGE from `npm ci --prefix ..` and “Project framework is set to services, but no services are declared.” The current single-project configuration uses Framework Preset Other, includes api/index.js, and installs both workspaces at the root. Keep dashboard settings aligned with the current configuration described above.

## Private standings

Global standings, rank information and leaderboard exports require administrator authentication. Participants use /api/teams/me/score; the server derives the team from the authenticated active roster rather than accepting a client-selected team. Dashboard and My team show only that team's game scores and weighted total. This endpoint returns no rank or other team rows.

## Install-script and audit warnings

The supplied Vercel logs show successful compilation. Funding notices and .vercelignore removals are informational. Dependency audit fixes are recorded in the committed manifests and package-lock.json: Sharp >=0.35.5, and a narrow Concurrently shell-quote override at 1.11.0. Commit the lockfile with the manifests so npm ci uses patched packages.

The esbuild@0.25.12 script is explicitly allowed only in the root package.json; npm ignores workspace-level allowScripts fields. Keep this declaration aligned with the exact locked esbuild version when updating Vite. Do not approve all scripts or suppress npm auditing to hide warnings. Sharp 0.35.5 has no install lifecycle check requiring approval. Run npm 12 install-scripts ls from the repository root to review this policy; that command does not support workspace selection. The root and per-service build commands remain unchanged.

## ENOENT while deploying outputs

The reported missing /vercel/path0/node_modules/cookie-parser/package.json was reproduced with Node 24 and npm 12: the backend install created cookie-parser, then the frontend install removed it. npm ci removes the existing shared node_modules tree, and an implicit current-workspace filter remains active even with --workspaces. Vercel had already traced backend dependencies before the frontend install, so final output packaging referenced a removed file.

The current single root install explicitly selects --workspace @aarohan/backend and --workspace @aarohan/frontend, along with --include-workspace-root and --include=dev. Do not replace those explicit selectors with --workspaces alone, and do not add a parent-prefix override. The isolated reproduction verified that cookie-parser, Vite and every backend runtime dependency remained available. .vercelignore correctly excludes local node_modules, which Vercel recreates during installation; it does not exclude backend/src, manifests, lockfile or build scripts.

## Full local packaging verification

The final isolated check ran Vercel CLI 62.5.0 with Node 24.19.0 and local-only project metadata, without private credentials or any deployment. It completed the root install/build and generated .vercel/output/static/index.html plus .vercel/output/functions/api/index.func/.vc-config.json (nodejs24.x, api/index.js handler). A test-only Windows shell lookup workaround was necessary for the CLI's Linux-oriented spawn environment; it is confined to .cache and is not application code or uploaded content. Cloud builds run on Linux and do not use that workaround.

Commit/push all configuration changes together, then deploy that new commit. An npm allowScripts warning mentioning frontend means a deployed manifest still contains a workspace-level field; check the deployment's exact Git commit against frontend/package.json. Do not redeploy an older commit expecting local edits to apply. Cloud runtime/Atlas connectivity and HTTPS camera checks still require verification on the actual deployed origin.

## Login/register return 503 after a successful build

The deployed site's `/api/health` returned the application's 503 response during the October 7 investigation. This endpoint connects to MongoDB before answering, so that observation identifies database initialization as the failing step. It does not identify the exact Atlas setting. A configured MONGODB_URI can still fail because the deployment has an older environment snapshot, the URI is malformed, database credentials are wrong, the cluster is paused, or Atlas does not allow the deployment's outbound IPs.

1. In Vercel, verify Production `MONGODB_URI` uses the Atlas Drivers connection string with the actual database username/password and intended database name. Paste the value without surrounding quotes. Encode reserved characters in credentials as required by MongoDB. A localhost URI points inside the Vercel function and cannot reach your computer's MongoDB.
2. In Atlas, verify the cluster is running, the database user has read/write access to the intended database, and Network Access allows Vercel's outbound connections. Allowing only your computer's IP is insufficient. Use your chosen static egress/private networking configuration where available; do not copy your laptop IP as the deployment IP.
3. Set Production `APP_ORIGIN=https://fingertipfrenzyieeeaarohan2026-fbq3.vercel.app` (no trailing slash) and `NODE_ENV=production`. Use the actual final origin if the domain changes. Origin mismatch returns 403; it does not explain the observed GET `/api/auth/me` database failure.
4. Deploy the latest fixed commit again after saving environment changes. Existing deployments retain their previous environment configuration. Local .env files are intentionally not uploaded.
5. Open `/api/health/live` to check that Express runs. Then open `/api/health/ready` to check MongoDB connection and a real database ping. Only readiness HTTP 200 with `database: connected` confirms database connectivity. The existing `/api/health` remains a readiness check.
6. If readiness returns 503, inspect the response code and the matching `api_unavailable` function log. Do not share connection strings or passwords. `DATABASE_CONFIGURATION_MISSING` means the deployed function has no URI; `DATABASE_CONFIGURATION_INVALID` means URI parsing failed; `DATABASE_AUTH_FAILED` means MongoDB rejected authentication; `DATABASE_NETWORK_ERROR` means a driver DNS/socket error; `DATABASE_UNAVAILABLE` requires checking Atlas access, cluster availability and connection settings. `APPLICATION_ORIGIN_MISSING` means APP_ORIGIN is missing from the deployed function. A later `DATABASE_PERMISSION_DENIED` means database operations lack permission. `DATABASE_TRANSACTIONS_UNSUPPORTED` means the database does not support the transactions required by registration; use an Atlas replica set.
7. Once readiness succeeds, verify leader registration, five-field login, refresh, logout and admin login on the final HTTPS origin. New databases need the separate administrator bootstrap described above.

The connection cache now keeps only in-flight connection attempts and clears after either success or failure. Warm functions reconnect after disconnection instead of reusing a permanently resolved promise. The Node 24 regression suite verifies missing/invalid URI responses, healthy readiness, concurrent connection attempts, reconnection, actual registration/login, and score privacy; all 20 tests pass. Lint and the production build also pass. These local checks do not establish live Atlas connectivity until the new commit is deployed and readiness succeeds.

References: [Atlas connection troubleshooting](https://www.mongodb.com/docs/atlas/troubleshoot-connection/) and [Vercel environment variables](https://vercel.com/docs/environment-variables).

### Atlas URI verification on October 7

The private local backend/.env and root .env contain the same Atlas URI. A read-only connection using Node 24 succeeded and returned a successful ping. This verifies the local URI/credentials and access from this computer; it does not verify the secret stored in Vercel or access from Vercel's outbound IPs. Local APP_ORIGIN is a development setting, so do not copy that value into Production.

Run `npm run db:check` to connect, ping, and check transaction-capable topology with the current environment. This command makes no writes and prints no credentials or hostnames. Vercel dashboard MONGODB_URI must contain the exact privately verified Atlas value. Save environment changes and create a new deployment.

Nested driver errors now distinguish `DATABASE_DNS_ERROR`, `DATABASE_TLS_ERROR`, `DATABASE_NETWORK_ERROR`, and `DATABASE_CONNECTION_TIMEOUT`. Timeout alone is not proof of an IP access-list problem: check Atlas Network Access, cluster status and Vercel's environment value. TLS errors must be investigated without disabling certificate validation. DNS errors require checking the Atlas hostname and whether the cluster is paused or deleted. The new classifications retain a safe fixed code rather than raw driver messages. Unit tests cover nested causes and ensure credentials never appear in diagnostic output.

## Multiplayer streaming update — October 9

Deploy the API and frontend from the same commit. Authenticated `/api/games/:game/events` endpoints now stream team-scoped state; `progress` supplies dashboard access and own-team scores. Keep the existing `/api` rewrite and 30-second API function duration. Connections renew after 25 seconds. No additional public service or binding is required by this single-API layout.

Atlas must permit database change streams on the application database as well as existing transactional reads/writes. Run `node scripts/check-realtime.mjs` in the private environment to check availability without writing data or printing credentials. Each stream opens a cursor; validate Atlas connections, Vercel streaming concurrency and function usage with the expected audience. A local capability check does not establish production-origin connectivity or event-scale capacity.

New Memory attempts use server-recorded guesses/deadlines. Old active attempts retain submission compatibility. Use a scheduled pause for the frontend/API rollout and reload arenas afterward. Verify real three-device camera sessions on HTTPS, reconnect/normal stream rollover, leaderboard ordering, and an admin reset that locks every dependent round. Do not disable TLS validation or put Atlas credentials into frontend variables. Full behavior and verification limits are recorded in `multiplayer-hardening.md`.

### Presence indexes

Before using the updated multiplayer Calculator in production, run `node scripts/indexes.mjs` from the repository root with your local private `MONGODB_URI` pointing at the intended Atlas database. This creates/verifies platform indexes, including the new `PlatformCalculatorPresence` unique `(sessionId, userId)` index and expiry cleanup index. It does not delete records or existing indexes. A database user must have permission to create indexes on the application's database.

Commit/push the code and redeploy the frontend and API together. Do not put database credentials in browser configuration. Verify three different roster members on separate devices: all appear online, each digit appears on every device, lowering a hand retains the saved digit, a real disconnect pauses after the 30-second grace period, and reconnecting resumes automatically. Keep the game arena open on each device; a suspended/closed browser cannot send heartbeats. A new question clears all previous digits intentionally.
