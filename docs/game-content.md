# Event content

Calculator and Memory generate their own challenges using validated game settings. Puzzle and Detective require event content from the organizer. Nothing is automatically populated into production.

Use each game's admin Content editor to create, update, publish or delete records. The visual forms use different fields for Puzzle and Detective. The following JSON schema describes the corresponding API payload for imports. An active attempt stores an immutable content/configuration snapshot; later organizer edits do not change its answers or score maximum.

## Puzzle

The record has `title`, `published`, `order` and `data`. Data has `description`, `imageUrl` (HTTPS), `gridRows`, `gridCols`, `points`, `timeLimitSeconds`, `hint`, `pieces` and `correctOrder`.

Each piece is `{ "pieceId": "opaque-unique-id", "imageUrl": "https://your-cdn/piece.png" }`. `correctOrder` lists piece IDs in row-major order. Every piece must appear once and grid dimensions must match the count. Keep piece IDs opaque; do not put grid position in the ID. Use the Puzzle image upload form to generate every crop with Sharp and store images in MongoDB, or provide HTTPS crop URLs from your existing CDN. Platform-generated /api/assets URLs are also accepted. Published content is validated on the backend. Only piece URLs and opaque IDs are returned to students; stored answers are never returned.

The round-wide duration is configured under Puzzle Settings. Per-puzzle `timeLimitSeconds` is retained as game content for the original UI contract; the server enforces the round-wide deadline, matching the original Vortex session behavior.

## Detective

Cases publish independently. New attempts include every published case in ascending `order` (then record ID for ties), and teams play through them sequentially. The existing Detective round timer covers all cases; scores and purchased hint penalties accumulate across the round. Calculator unlocks after the Detective attempt finishes.

Publishing or editing a case does not unpublish other cases. Republish any earlier cases that the previous single-case behavior changed to drafts. Existing attempts retain their saved cases and results; newly published cases appear in new attempts rather than being inserted into active play.

Data has `description`, `difficulty`, `suspects`, `clues`, `questions`, `hints`.

- Suspect: `{name, role, statement}`.
- Clue: `{id, title, description, evidence, evidenceType}`; type is `text`, `document` or `image`. Image evidence must use HTTPS.
- Question: `{id, question, options, correctAnswerIndex, points, clueId?}`. Answer index starts at zero; IDs must be unique.
- Hint: `{id, questionId?, hintText, penalty, enabled}`. IDs must be unique. Hint text becomes visible after unlocking; penalties apply once.

To import the original Vortex case as a draft:

```powershell
node scripts/import-original-case.mjs
node scripts/import-original-case.mjs --apply
```

The first command validates without writing. The second imports the original case, questions, clues and hint, and refuses a duplicate. Review and publish it from the Detective admin page. This is retained original game content, not generated leaderboard or user data.
