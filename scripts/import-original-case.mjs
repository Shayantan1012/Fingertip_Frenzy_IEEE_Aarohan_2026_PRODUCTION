import "dotenv/config";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import mongoose from "mongoose";
import { connectDB, transaction } from "../backend/src/config/db.js";
import { Content } from "../backend/src/models/index.js";
import { contentSchema } from "../backend/src/services/content.js";
import {
  prepareContentOrder,
  nextContentOrder,
} from "../backend/src/services/content-order.js";
const source = readFileSync(
  "vortex-main/server/src/services/detectiveService.js",
  "utf8",
);
const snippet = source.slice(
  source.indexOf("const DEFAULT_SEED_CASE"),
  source.indexOf("/**"),
);
const original = runInNewContext(
  snippet +
    ";({c:DEFAULT_SEED_CASE,clues:DEFAULT_SEED_CLUES,questions:DEFAULT_SEED_QUESTIONS,hints:DEFAULT_SEED_HINTS})",
  {},
  { timeout: 1000 },
);
const pick = (row, keys) =>
  Object.fromEntries(
    keys.map((k) => [k, row[k]]).filter(([, v]) => v !== undefined),
  );
const body = contentSchema("detective").parse({
  title: original.c.title,
  published: true,
  order: 0,
  data: {
    description: original.c.description,
    difficulty: original.c.difficulty,
    suspects: [],
    clues: original.clues.map((c) => ({
      id: c._id,
      ...pick(c, ["title", "description", "evidence", "evidenceType"]),
    })),
    questions: original.questions.map((q) => ({
      id: q._id,
      ...pick(q, ["question", "options", "correctAnswerIndex", "points"]),
      clueId: q.clueId,
    })),
    hints: original.hints.map((h) => ({
      id: h._id,
      ...pick(h, ["questionId", "hintText", "penalty", "enabled"]),
    })),
  },
});
if (!process.argv.includes("--apply")) {
  console.log(
    "Original Vortex detective case validates. Dry run; add --apply to import and publish it.",
  );
  process.exit(0);
}
await connectDB();
if (await Content.exists({ gameId: "detective", title: body.title }))
  throw new Error("This original case has already been imported.");
await prepareContentOrder("detective");
await transaction(async (session) => {
  const order = await nextContentOrder("detective", session);
  await Content.create([{ gameId: "detective", ...body, order }], { session });
});
console.log(
  "Original detective case imported and published. Review it in admin.",
);
await mongoose.disconnect();
