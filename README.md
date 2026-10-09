# Fingertip Frenzy

Organized by **IEEE SB NIT Durgapur** for **Aarohan 2026**. A unified four-round game platform with a responsive animated midnight, amber and mint interface, leader registration, shared teams, persisted game results and an administrator portal.

## Project structure

```text
frontend/              React/Vite application and retained game interfaces
frontend/.env          Public event branding only
backend/               Express/Mongoose API, models, validation and game engines
backend/.env           Private database, origin and administrator configuration
backend/test/          Scoring and isolated MongoDB integration tests
vercel.json            Static frontend and Express API deployment
scripts/               Bootstrap, indexes, migration and verification tools
```

The original uploaded game directories remain intact. Frontend and backend run separately and communicate through a same-origin `/api` proxy.

## Run locally

Use Node 22 LTS, npm and a MongoDB replica set or Atlas database. Multi-document transactions require a replica set.

```powershell
npm ci
# .env files have been created. Configure backend/.env privately.
# For a fresh checkout only:
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
# Set MONGODB_URI and APP_ORIGIN=http://127.0.0.1:5173 in backend/.env.
# Set ADMIN_EMAIL and ADMIN_PASSWORD for the initial bootstrap.
npm run bootstrap
node scripts/indexes.mjs
npm run dev
```

Do not copy templates over an already configured `.env`. Remove the bootstrap password after provisioning the administrator. The backend loads `backend/.env` first and uses the existing root `.env` as a fallback; process environment variables take precedence. Private values never belong in `VITE_` variables.

Frontend: `http://127.0.0.1:5173`. API: port 5000. `APP_ORIGIN` must match the browser origin exactly. You can run `npm run dev -w frontend` and `npm run dev -w backend` separately. An optional server-only `FF_API_PROXY` overrides Vite's API proxy for isolated local testing.

## Registration and login

1. The team leader visits `/register` and enters team name, leader name, roll number, phone number and email.
2. The backend creates the leader and team together in one transaction, generating a random unique `FF-` team code. The success page offers code copying and login.
3. Everyone logs in at `/login` with team code and their own name, roll number, phone number and email. A new teammate's first login joins the team; an existing participant must match all saved identity fields.
4. The default capacity is three. Add both teammates before starting a game. Active attempts lock membership; AI Calculator requires exactly three participants.

Duplicate roll/phone records, wrong identity details, wrong team codes and over-capacity joins are rejected. Sessions use HTTP-only cookies with persisted token hashes and expiration. Registration and login are rate-limited. This is knowledge-based event access; it does not verify email or phone ownership.

## Four rounds

The dashboard and backend enforce this sequence. Completing a valid result unlocks the next round for the team.

1. **Image Formation** — puzzle board, image pieces, timer and hints; leader starts.
2. **Detective Case** — evidence, questions and penalized hints; leader starts.
3. **AI Calculator** — three participants take X, Y and Z roles; shared state and presence govern the game.
4. **Number Memory** — each participant completes three sequence stages; results contribute to the team.

The server owns scoring, deadlines and progression. Best valid results feed the weighted leaderboard. Default weights are 25 each, yielding a 1,000-point maximum; Memory averages results across the whole roster, including missing results as zero.

Publish real Puzzle and Detective content before the event. See [content formats](docs/game-content.md). No fake scores or test identities are seeded in production.

## Administrator portal

Visit `/admin/login` with the privately provisioned email/password. The portal opens `/admin/leaderboard` and contains only the leaderboard and four ordered game sections.

The leaderboard provides standings, filters, exports and audited score review. Each game section controls availability, schedule, weight, attempts, game mechanics, content where relevant and scoped retries. Team and member management is embedded in the leaderboard, keeping the five-section navigation. Administrators can edit member identities, roster, leader, code and status, or delete teams/members. Registered team names are fixed for everyone. Identity edits revoke existing sessions; participants log in again with corrected details. Transfer leadership before deleting a leader, and reset active attempts before removing a member. Deletion retains historical results and audits.

## Verification and deployment

For **frontend and backend together on one EC2 instance**, follow the [EC2 Docker and GitHub Actions guide](docs/ec2-deployment.md). The root Dockerfile packages both, Caddy supplies HTTPS, and the pipeline copies the tested Docker image directly to EC2 over SSH, then runs Docker Compose. You configure the EC2 instance, DNS, Atlas and SSH access yourself; no AWS IAM deployment role or access keys are needed. The existing Vercel configuration remains an alternative.

```powershell
npm run build
npm run lint
npm test
```

Tests use an isolated real MongoDB replica set and cover leader registration, five-field login, concurrent joins, ordered round access, all four scoring paths, replay guards, authorization, uploads, leaderboard updates and audited resets. First run may download MongoDB to `.cache/mongodb`.

See [verification](docs/verification.md), [implementation report](docs/implementation-report.md), [Vercel/Atlas deployment](docs/deployment.md) and [migration safety](docs/migration.md). Existing imported participants need a complete matching name, roll, phone, email and team association to use the new login flow.

Production deployment and physical camera recognition require a real-device check. Cameras need HTTPS or loopback and user permission; MediaPipe assets require network access. A build confirms compilation, not production database connectivity or deployment.


## Score privacy

Only administrators can view the full leaderboard, rankings, other team scores and leaderboard exports. Participants see their own team's four game scores and weighted total on the dashboard and My team page, refreshed every 30 seconds. `/api/teams/me/score` selects the active roster from the authenticated user; URL parameters cannot select another team. Both the old `/api/leaderboard` alias and `/api/admin/leaderboard` require administrator authentication. Public and participant navigation no longer exposes standings.


//Lets begin
//1
//test
