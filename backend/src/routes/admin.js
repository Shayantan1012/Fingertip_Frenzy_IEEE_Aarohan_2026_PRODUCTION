import { Router } from "express";
import { z } from "zod";
import {
  User,
  Team,
  GameSession,
  Result,
  Content,
  Setting,
  GameSetting,
  Audit,
  AuthSession,
  CalculatorPresence,
} from "../models/index.js";
import { transaction } from "../config/db.js";
import {
  requireAuth,
  requireAdmin,
  rateLimit,
} from "../middleware/security.js";
import { asyncRoute, fail } from "../services/errors.js";
import {
  student,
  name,
  objectId,
  pagination,
  search,
  gameId,
  leaderboardSort,
} from "../services/validation.js";
import { publicUser } from "../services/auth.js";
import { schemas, names } from "../game-services/config.js";
import { platformSettings, gameSettings } from "../services/settings.js";
import {
  prepareContentOrder,
  nextContentOrder,
} from "../services/content-order.js";
import { teamCode } from "../services/teams.js";
import { contentSchema } from "../services/content.js";
import { leaderboard } from "../services/leaderboard.js";
import { cropPuzzle } from "../services/images.js";
const router = Router();
router.use(requireAuth, requireAdmin, rateLimit("admin", 240));
function recordFilter(entity, query) {
  if (entity === "results")
    return query.gameId ? { gameId: gameId.parse(query.gameId) } : {};
  const q = search(query.search);
  return {
    status: { $ne: "DELETED" },
    ...(entity === "students" ? { role: { $ne: "ADMIN" } } : {}),
    ...(q
      ? {
          $or: (entity === "students"
            ? ["name", "rollNo", "phoneNo"]
            : ["name", "code"]
          ).map((k) => ({ [k]: { $regex: q, $options: "i" } })),
        }
      : {}),
  };
}
const standingsOptions = (query) => ({
  sort: leaderboardSort.parse(query.sort),
  ...pagination(query),
  search: search(query.search),
  game: query.gameId ? gameId.parse(query.gameId) : null,
  completedOnly: query.completed === "true",
});
async function audited(req, action, type, id, fn) {
  let output;
  await transaction(async (tx) => {
    const change = await fn(tx);
    await Audit.create(
      [
        {
          adminId: req.user._id,
          action,
          entityType: type,
          entityId: String(id),
          oldValue: change.old,
          newValue: change.new,
        },
      ],
      { session: tx },
    );
    output = change.new;
  });
  return output;
}
async function list(Model, req, filter = {}) {
  const { page, limit } = pagination(req.query);
  const [rows, total] = await Promise.all([
    Model.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Model.countDocuments(filter),
  ]);
  const [teams, users] = await Promise.all([
    Team.find({ _id: { $in: rows.map((r) => r.teamId).filter(Boolean) } })
      .select("name")
      .lean(),
    User.find({
      _id: { $in: rows.flatMap((r) => [r.userId, r.leaderId]).filter(Boolean) },
    })
      .select("name rollNo")
      .lean(),
  ]);
  const teamNames = new Map(teams.map((t) => [String(t._id), t.name]));
  const userNames = new Map(
    users.map((u) => [String(u._id), u.name + " · " + u.rollNo]),
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      teamName: teamNames.get(String(r.teamId)),
      userName: userNames.get(String(r.userId)),
      leaderName: userNames.get(String(r.leaderId)),
    })),
    total,
    page,
    limit,
  };
}
router.get(
  "/dashboard",
  asyncRoute(async (req, res) => {
    const [students, teams, activeTeams, submissions, stats, participation] =
      await Promise.all([
        User.countDocuments({
          role: { $ne: "ADMIN" },
          status: { $ne: "DELETED" },
        }),
        Team.countDocuments({ status: { $ne: "DELETED" } }),
        Team.countDocuments({ status: "ACTIVE" }),
        Result.countDocuments({ valid: true }),
        Result.aggregate([
          { $match: { valid: true } },
          {
            $group: {
              _id: null,
              average: { $avg: "$score" },
              highest: { $max: "$score" },
            },
          },
        ]),
        GameSession.aggregate([
          { $match: { testMode: { $ne: true } } },
          {
            $group: {
              _id: "$gameId",
              attempts: { $sum: 1 },
              completed: {
                $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
              },
            },
          },
        ]),
      ]);
    res.json({
      students,
      teams,
      activeTeams,
      submissions,
      average: stats[0]?.average || 0,
      highest: stats[0]?.highest || 0,
      participation,
    });
  }),
);
router.get(
  "/students",
  asyncRoute(async (req, res) => {
    const q = search(req.query.search);
    res.json(
      await list(User, req, {
        role: { $ne: "ADMIN" },
        status: { $ne: "DELETED" },
        ...(q
          ? {
              $or: ["name", "rollNo", "phoneNo"].map((k) => ({
                [k]: { $regex: q, $options: "i" },
              })),
            }
          : {}),
      }),
    );
  }),
);
router.post(
  "/students",
  asyncRoute(async (req, res) => {
    const b = student.parse(req.body);
    const data = await audited(
      req,
      "CREATE_STUDENT",
      "User",
      "new",
      async (tx) => {
        const [doc] = await User.create([b], { session: tx });
        return { old: null, new: publicUser(doc) };
      },
    );
    res.status(201).json(data);
  }),
);
router.patch(
  "/students/:id",
  asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id),
      b = student
        .partial()
        .extend({
          status: z.enum(["ACTIVE", "INACTIVE"]),
          role: z.enum(["STUDENT", "TEAM_LEADER"]),
        })
        .partial()
        .strict()
        .parse(req.body);
    res.json(
      await audited(req, "EDIT_STUDENT", "User", id, async (tx) => {
        const doc = await User.findOne({
          _id: id,
          role: { $ne: "ADMIN" },
          status: { $ne: "DELETED" },
        }).session(tx);
        if (!doc) fail(404, "Student not found.");
        if (b.role) {
          const team =
            doc.teamId && (await Team.findById(doc.teamId).session(tx));
          const isLeader = team && String(team.leaderId) === id;
          if ((b.role === "TEAM_LEADER") !== !!isLeader)
            fail(409, "Change the leader from team management.");
        }
        const old = publicUser(doc);
        Object.assign(doc, b);
        await doc.save({ session: tx });
        await AuthSession.deleteMany({ userId: id }, { session: tx });
        return { old, new: publicUser(doc) };
      }),
    );
  }),
);
router.delete(
  "/students/:id",
  asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id);
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    res.json(
      await audited(req, "DELETE_STUDENT", "User", id, async (tx) => {
        const doc = await User.findOne({
          _id: id,
          role: { $ne: "ADMIN" },
        }).session(tx);
        if (!doc) fail(404, "Student not found.");
        if (doc.teamId) {
          const team = await Team.findById(doc.teamId).session(tx);
          if (team && String(team.leaderId) === id)
            fail(
              409,
              "Assign another leader or delete the team before deleting its leader.",
            );
          if (
            await GameSession.exists({
              teamId: doc.teamId,
              status: "IN_PROGRESS",
            }).session(tx)
          )
            fail(409, "Reset active attempts before removing a team member.");
          if (team) {
            team.memberIds = team.memberIds.filter(
              (memberId) => String(memberId) !== id,
            );
            await team.save({ session: tx });
          }
        }
        const old = publicUser(doc);
        doc.status = "DELETED";
        doc.teamId = null;
        doc.role = "STUDENT";
        await doc.save({ session: tx });
        await AuthSession.deleteMany({ userId: id }, { session: tx });
        return { old, new: publicUser(doc) };
      }),
    );
  }),
);
router.get(
  "/teams",
  asyncRoute(async (req, res) => {
    const q = search(req.query.search);
    res.json(
      await list(Team, req, {
        status: { $ne: "DELETED" },
        ...(q
          ? {
              $or: [
                { name: { $regex: q, $options: "i" } },
                { code: { $regex: q, $options: "i" } },
              ],
            }
          : {}),
      }),
    );
  }),
);
router.get(
  "/teams/:id",
  asyncRoute(async (req, res) => {
    const team = await Team.findById(objectId.parse(req.params.id)).lean();
    if (!team) fail(404, "Team not found.");
    res.json({
      ...team,
      members: await User.find({ _id: { $in: team.memberIds } })
        .select("name rollNo phoneNo email role status")
        .lean(),
    });
  }),
);
router.patch(
  "/teams/:id",
  asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id),
      b = z
        .object({
          status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
          leaderId: objectId.optional(),
          memberIds: z.array(objectId).min(1).max(12).optional(),
          regenerateCode: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
    res.json(
      await audited(req, "EDIT_TEAM", "Team", id, async (tx) => {
        const doc = await Team.findOne({
          _id: id,
          status: { $ne: "DELETED" },
        }).session(tx);
        if (!doc) fail(404, "Team not found.");
        if (
          await GameSession.exists({
            teamId: id,
            status: "IN_PROGRESS",
          }).session(tx)
        )
          fail(
            409,
            "Abandon active attempts before modifying membership or status.",
          );
        const old = doc.toObject(),
          members = b.memberIds || doc.memberIds.map(String),
          leader = b.leaderId || String(doc.leaderId);
        if (
          new Set(members).size !== members.length ||
          !members.includes(leader)
        )
          fail(400, "The leader must be a unique team member.");
        const cfg = await platformSettings(tx);
        if (members.length > cfg.maxTeamSize)
          fail(409, "This team is already full.");
        const users = await User.find({
          _id: { $in: members },
          role: { $ne: "ADMIN" },
          status: "ACTIVE",
        }).session(tx);
        if (
          users.length !== members.length ||
          users.some((u) => u.teamId && String(u.teamId) !== id)
        )
          fail(
            409,
            "All members must be active students without another team.",
          );
        await User.updateMany(
          { teamId: id, _id: { $nin: members } },
          { $set: { teamId: null, role: "STUDENT" } },
          { session: tx },
        );
        await User.updateMany(
          { _id: { $in: members } },
          { $set: { teamId: id, role: "STUDENT" } },
          { session: tx },
        );
        await User.updateOne(
          { _id: leader },
          { $set: { role: "TEAM_LEADER" } },
          { session: tx },
        );
        doc.memberIds = members;
        doc.leaderId = leader;
        if (b.status) doc.status = b.status;
        if (b.regenerateCode) doc.code = teamCode();
        await doc.save({ session: tx });
        return { old, new: doc.toObject() };
      }),
    );
  }),
);
router.delete(
  "/teams/:id",
  asyncRoute(async (req, res) => {
    const id = objectId.parse(req.params.id);
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    res.json(
      await audited(req, "DELETE_TEAM", "Team", id, async (tx) => {
        const doc = await Team.findOne({
          _id: id,
          status: { $ne: "DELETED" },
        }).session(tx);
        if (!doc) fail(404, "Team not found.");
        const old = doc.toObject();
        doc.status = "DELETED";
        await doc.save({ session: tx });
        await AuthSession.deleteMany(
          { userId: { $in: doc.memberIds } },
          { session: tx },
        );
        await User.updateMany(
          { teamId: id },
          { $set: { teamId: null, role: "STUDENT" } },
          { session: tx },
        );
        await GameSession.updateMany(
          { teamId: id, status: "IN_PROGRESS" },
          { $set: { status: "ABANDONED" } },
          { session: tx },
        );
        return { old, new: doc.toObject() };
      }),
    );
  }),
);
router.get(
  "/settings",
  asyncRoute(async (req, res) => res.json(await platformSettings())),
);
router.patch(
  "/settings",
  asyncRoute(async (req, res) => {
    const b = z
      .object({ maxTeamSize: z.number().int().min(3).max(12) })
      .strict()
      .parse(req.body);
    res.json(
      await audited(
        req,
        "PLATFORM_SETTINGS",
        "Setting",
        "platform",
        async (tx) => {
          if (
            await Team.exists({
              status: "ACTIVE",
              $expr: { $gt: [{ $size: "$memberIds" }, b.maxTeamSize] },
            }).session(tx)
          )
            fail(409, "An existing team exceeds this size.");
          const old = await platformSettings(tx);
          await Setting.updateOne(
            { key: "platform" },
            { $set: { value: b } },
            { upsert: true, session: tx },
          );
          return { old, new: b };
        },
      ),
    );
  }),
);
router.get(
  "/games/:gameId",
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId),
      filter = { gameId: game };
    const [settings, sessions, content, stats] = await Promise.all([
      gameSettings(game),
      list(GameSession, req, { ...filter, testMode: { $ne: true } }),
      Content.find(filter).sort({ order: 1 }).limit(100).lean(),
      Result.aggregate([
        { $match: { gameId: game, valid: true } },
        {
          $group: {
            _id: null,
            average: { $avg: "$score" },
            highest: { $max: "$score" },
            lowest: { $min: "$score" },
            averageTime: { $avg: "$completionTime" },
            completed: { $sum: 1 },
          },
        },
      ]),
    ]);
    res.json({
      name: names[game],
      settings,
      sessions,
      content,
      stats: stats[0] || { completed: 0 },
    });
  }),
);
router.post(
  "/games/:gameId/test/reset",
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId);
    await GameSession.updateMany(
      {
        gameId: game,
        userId: req.user._id,
        testMode: true,
        status: "IN_PROGRESS",
      },
      {
        $set: {
          status: "ABANDONED",
          completedAt: new Date(),
          retryGranted: true,
        },
      },
    );
    res.json({ success: true });
  }),
);
router.patch(
  "/games/:gameId/settings",
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId),
      b = schemas[game].parse(req.body);
    if (b.startAt && b.endAt && +new Date(b.startAt) >= +new Date(b.endAt))
      fail(400, "The end time must follow the start time.");
    res.json(
      await audited(req, "GAME_SETTINGS", "GameSetting", game, async (tx) => {
        const old = await gameSettings(game, tx);
        await GameSetting.updateOne(
          { gameId: game },
          { $set: { config: b } },
          { upsert: true, session: tx },
        );
        return { old, new: b };
      }),
    );
  }),
);
router.post(
  "/games/puzzle/upload",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        image: z.string().max(1400000),
        title: name,
        gridRows: z.number().int().min(2).max(8),
        gridCols: z.number().int().min(2).max(8),
        points: z.number().int().min(0).max(10000),
      })
      .strict()
      .parse(req.body);
    await prepareContentOrder("puzzle");
    res.status(201).json(
      await audited(req, "UPLOAD_PUZZLE", "Content", "new", async (tx) => {
        const images = await cropPuzzle(b.image, b.gridRows, b.gridCols, tx);
        const [doc] = await Content.create(
          [
            {
              gameId: "puzzle",
              title: b.title,
              published: false,
              order: await nextContentOrder("puzzle", tx),
              data: {
                ...images,
                description: "",
                hint: "",
                gridRows: b.gridRows,
                gridCols: b.gridCols,
                points: b.points,
                timeLimitSeconds: 300,
              },
            },
          ],
          { session: tx },
        );
        return { old: null, new: doc.toObject() };
      }),
    );
  }),
);
router.post(
  "/games/:gameId/content",
  asyncRoute(async (req, res) => {
    const game = z.enum(["puzzle", "detective"]).parse(req.params.gameId),
      b = contentSchema(game).parse(req.body);
    if (game === "detective") b.published = true;
    await prepareContentOrder(game);
    res.status(201).json(
      await audited(req, "CREATE_CONTENT", "Content", "new", async (tx) => {
        const order = await nextContentOrder(game, tx);
        const [doc] = await Content.create([{ gameId: game, ...b, order }], {
          session: tx,
        });
        return { old: null, new: doc.toObject() };
      }),
    );
  }),
);
router.put(
  "/games/:gameId/content/:id",
  asyncRoute(async (req, res) => {
    const game = z.enum(["puzzle", "detective"]).parse(req.params.gameId),
      id = objectId.parse(req.params.id),
      b = contentSchema(game).parse(req.body);
    if (game === "detective") b.published = true;
    res.json(
      await audited(req, "EDIT_CONTENT", "Content", id, async (tx) => {
        const doc = await Content.findOne({ _id: id, gameId: game }).session(
          tx,
        );
        if (!doc) fail(404, "Content not found.");
        const old = doc.toObject();
        Object.assign(doc, b, { order: doc.order });
        await doc.save({ session: tx });
        return { old, new: doc.toObject() };
      }),
    );
  }),
);
router.delete(
  "/games/:gameId/content/:id",
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId),
      id = objectId.parse(req.params.id);
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    res.json(
      await audited(req, "DELETE_CONTENT", "Content", id, async (tx) => {
        const old = await Content.findOne({ _id: id, gameId: game })
          .session(tx)
          .lean();
        if (!old) fail(404, "Content not found.");
        await Content.deleteOne({ _id: id }, { session: tx });
        return { old, new: null };
      }),
    );
  }),
);
router.post(
  "/games/:gameId/sessions/:id/reset",
  asyncRoute(async (req, res) => {
    const game = gameId.parse(req.params.gameId),
      id = objectId.parse(req.params.id);
    const resetBody = z
      .object({
        reason: z.string().trim().min(5).max(500),
        scope: z.enum(["team", "participant"]).optional(),
      })
      .strict()
      .parse(req.body);
    const participantOnly = game === "memory" && resetBody.scope !== "team";
    res.json(
      await audited(req, "RESET_ATTEMPT", "GameSession", id, async (tx) => {
        const doc = await GameSession.findOne({
          _id: id,
          gameId: game,
        }).session(tx);
        if (!doc) fail(404, "Attempt not found.");
        const old = doc.toObject();
        if (doc.testMode) fail(400, "Use the private practice reset control.");
        const filter = {
          teamId: doc.teamId,
          gameId: game,
          ...(participantOnly ? { userId: doc.userId } : {}),
          testMode: { $ne: true },
        };
        const related = await GameSession.find(filter)
          .select("_id")
          .session(tx);
        await Result.updateMany(
          {
            teamId: doc.teamId,
            gameId: game,
            ...(participantOnly ? { userId: doc.userId } : {}),
          },
          { $set: { valid: false } },
          { session: tx },
        );
        await GameSession.updateMany(
          { _id: { $in: related.map((d) => d._id) } },
          {
            $set: {
              status: "ABANDONED",
              score: 0,
              state: {},
              completedAt: null,
              retryGranted: true,
            },
            $inc: { revision: 1 },
          },
          { session: tx },
        );
        await CalculatorPresence.deleteMany(
          { sessionId: { $in: related.map((d) => d._id) } },
          { session: tx },
        );
        // Serialize against game start/membership edits; unrelated rounds retain their data.
        await Team.updateOne(
          { _id: doc.teamId },
          { $set: { updatedAt: new Date() } },
          { session: tx },
        );
        const updated = await GameSession.findById(id).session(tx);
        return { old, new: { ...updated.toObject(), reason: req.body.reason } };
      }),
    );
  }),
);
router.get(
  "/results",
  asyncRoute(async (req, res) =>
    res.json(
      await list(
        Result,
        req,
        req.query.gameId ? { gameId: gameId.parse(req.query.gameId) } : {},
      ),
    ),
  ),
);
router.patch(
  "/results/:id",
  asyncRoute(async () => {
    fail(
      405,
      "Scores are checked automatically. Reset the attempt to grant a retry.",
    );
  }),
);
router.get(
  "/audit-logs",
  asyncRoute(async (req, res) => res.json(await list(Audit, req))),
);
router.get(
  "/leaderboard",
  asyncRoute(async (req, res) =>
    res.json(await leaderboard(standingsOptions(req.query))),
  ),
);
router.get(
  "/export/:entity",
  asyncRoute(async (req, res) => {
    const entity = z
      .enum(["students", "teams", "leaderboard", "results"])
      .parse(req.params.entity);
    let rows;
    if (entity === "leaderboard")
      rows = (await leaderboard(standingsOptions(req.query))).rows;
    else
      rows = (
        await list(
          { students: User, teams: Team, results: Result }[entity],
          req,
          recordFilter(entity, req.query),
        )
      ).rows;
    const keys = {
      students: [
        "name",
        "rollNo",
        "phoneNo",
        "email",
        "role",
        "status",
        "teamId",
      ],
      teams: ["name", "code", "leaderId", "status"],
      results: [
        "teamId",
        "userId",
        "gameId",
        "score",
        "maximum",
        "valid",
        "completedAt",
      ],
      leaderboard: [
        "rank",
        "name",
        "code",
        "scores",
        "total",
        "averageTime",
        "completed",
      ],
    }[entity];
    const cell = (v) => {
      let s = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        `attachment; filename="aarohan-${entity}-page.csv"`,
      )
      .send(
        "\uFEFF" +
          [
            keys.join(","),
            ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
          ].join("\r\n"),
      );
  }),
);
export default router;
