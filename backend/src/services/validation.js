import { z } from "zod";
export const leaderboardSort = z
  .enum(["score-desc", "score-asc", "time-asc", "time-desc"])
  .default("score-desc");
export const roll = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/-]{1,29}$/);
export const phone = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/);
export const name = z.string().trim().min(2).max(60);
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
export const email = z.string().trim().email().max(254).toLowerCase();
export const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(?:FF-[A-F0-9]{12}|AAROHAN-[A-F0-9]{8})$/);
export const identity = z.object({ name, rollNo: roll, phoneNo: phone, email });
export const login = identity.extend({ teamCode: code }).strict();
export const registration = identity.extend({ teamName: name }).strict();
export const student = z
  .object({
    name,
    rollNo: roll,
    phoneNo: phone,
    email: email.optional(),
  })
  .strict();
export const gameId = z.enum(["calculator", "memory", "puzzle", "detective"]);
export const pagination = (q) => ({
  page: z.coerce.number().int().min(1).max(10000).default(1).parse(q.page),
  limit: z.coerce.number().int().min(1).max(100).default(25).parse(q.limit),
});
export const search = (q) =>
  typeof q === "string"
    ? q.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "";
