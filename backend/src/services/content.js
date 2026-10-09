import { z } from "zod";
const text = z.string().max(6000),
  points = z.number().int().min(0).max(10000),
  url = z
    .string()
    .refine(
      (v) =>
        v.startsWith("https://") || /^\/api\/assets\/[a-f0-9]{24}$/.test(v),
      "Use HTTPS or a platform asset URL.",
    );
export const puzzleData = z
  .object({
    description: text.default(""),
    imageUrl: url,
    gridRows: z.number().int().min(2).max(8),
    gridCols: z.number().int().min(2).max(8),
    points,
    timeLimitSeconds: z.number().int().min(10).max(7200),
    hint: text.default(""),
    pieces: z
      .array(
        z
          .object({ pieceId: z.string().min(1).max(100), imageUrl: url })
          .strict(),
      )
      .min(4)
      .max(64),
    correctOrder: z.array(z.string().min(1).max(100)).min(4).max(64),
  })
  .strict()
  .superRefine((p, c) => {
    if (
      p.pieces.length !== p.gridRows * p.gridCols ||
      p.correctOrder.length !== p.pieces.length ||
      new Set(p.correctOrder).size !== p.pieces.length ||
      new Set(p.pieces.map((x) => x.pieceId)).size !== p.pieces.length ||
      p.pieces.some((x) => !p.correctOrder.includes(x.pieceId))
    )
      c.addIssue({
        code: "custom",
        message: "Every grid slot needs one unique piece in the correct order.",
      });
  });
const hint = z
  .object({
    id: z.string().min(1).max(100),
    questionId: z.string().nullable().optional(),
    hintText: text,
    penalty: points,
    enabled: z.boolean().default(true),
  })
  .strict();
const question = z
  .object({
    id: z.string().min(1).max(100),
    question: text.trim().min(1),
    options: z.array(z.string().trim().min(1).max(400)).min(2).max(10),
    correctAnswerIndex: z.number().int().min(0).max(9),
    points,
    clueId: z.string().optional(),
  })
  .strict()
  .refine(
    (q) => q.correctAnswerIndex < q.options.length,
    "The correct option must exist.",
  );
export const detectiveData = z
  .object({
    description: text,
    difficulty: z.string().max(40),
    suspects: z
      .array(
        z.object({ name: z.string().max(100), role: text, statement: text }),
      )
      .max(20)
      .default([]),
    clues: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          title: z.string().max(200),
          description: text,
          evidence: text,
          evidenceType: z.enum(["text", "document", "image"]),
          classification: z.string().max(50).optional(),
        }),
      )
      .max(50),
    questions: z.array(question).min(1).max(100),
    hints: z.array(hint).max(50),
  })
  .strict()
  .superRefine((d, c) => {
    const clues = new Set(d.clues.map((clue) => clue.id));
    const questions = new Set(d.questions.map((question) => question.id));
    if (clues.size !== d.clues.length)
      c.addIssue({ code: "custom", message: "Clue IDs must be unique." });
    for (const question of d.questions)
      if (question.clueId && !clues.has(question.clueId))
        c.addIssue({
          code: "custom",
          message: "Each linked clue must exist in this case.",
        });
    for (const hint of d.hints)
      if (hint.questionId && !questions.has(hint.questionId))
        c.addIssue({
          code: "custom",
          message: "Each linked hint question must exist in this case.",
        });
    if (
      new Set(d.questions.map((q) => q.id)).size !== d.questions.length ||
      new Set(d.hints.map((h) => h.id)).size !== d.hints.length
    )
      c.addIssue({
        code: "custom",
        message: "Question and hint IDs must be unique.",
      });
    for (const clue of d.clues)
      if (
        clue.evidenceType === "image" &&
        !url.safeParse(clue.evidence).success
      )
        c.addIssue({
          code: "custom",
          message: "Image evidence needs an HTTPS URL.",
        });
  });
export const contentSchema = (game) =>
  z
    .object({
      title: z.string().trim().min(2).max(100),
      published: z.boolean(),
      order: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      data: game === "puzzle" ? puzzleData : detectiveData,
    })
    .strict();
