import { Result, Team, GameSetting } from "../models/index.js";
import { defaults } from "../game-services/config.js";
export const normalized = (score, maximum, weight) =>
  maximum > 0 ? Math.min(1, Math.max(0, score / maximum)) * weight * 10 : 0;
export function rankRows(rows) {
  const sorted = rows.sort(
    (a, b) =>
      b.total - a.total ||
      b.completed - a.completed ||
      a.completionTime - b.completionTime ||
      String(a._id).localeCompare(String(b._id)),
  );
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}
export async function leaderboard({
  search = "",
  game = null,
  page = 1,
  limit = 25,
  completedOnly = false,
  teamId = null,
  sort = "score-desc",
} = {}) {
  const settings = Object.fromEntries(
    (await GameSetting.find().lean()).map((s) => [s.gameId, s.config]),
  );
  const pipeline = [
    { $match: { status: "ACTIVE", ...(teamId ? { _id: teamId } : {}) } },
    {
      $lookup: {
        from: Result.collection.name,
        let: { team: "$_id", members: "$memberIds" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$teamId", "$$team"] },
                  { $eq: ["$valid", true] },
                  {
                    $or: [
                      { $ne: ["$gameId", "memory"] },
                      { $in: ["$userId", "$$members"] },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { score: -1, completionTime: 1 } },
          {
            $group: {
              _id: {
                game: "$gameId",
                user: {
                  $cond: [{ $eq: ["$gameId", "memory"] }, "$userId", null],
                },
              },
              score: { $first: "$score" },
              maximum: { $first: "$maximum" },
              time: { $first: "$completionTime" },
            },
          },
          {
            $group: {
              _id: "$_id.game",
              score: { $sum: "$score" },
              maximum: { $sum: "$maximum" },
              time: { $sum: "$time" },
              count: { $sum: 1 },
              ratios: {
                $sum: {
                  $cond: [
                    { $gt: ["$maximum", 0] },
                    {
                      $min: [
                        1,
                        { $max: [0, { $divide: ["$score", "$maximum"] }] },
                      ],
                    },
                    0,
                  ],
                },
              },
            },
          },
        ],
        as: "results",
      },
    },
    {
      $set: {
        scores: {
          $arrayToObject: {
            $map: {
              input: "$results",
              as: "r",
              in: { k: "$$r._id", v: "$$r.score" },
            },
          },
        },
        completed: {
          $sum: {
            $map: {
              input: "$results",
              as: "r",
              in: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$$r._id", "memory"] },
                      { $lt: ["$$r.count", { $size: "$memberIds" }] },
                    ],
                  },
                  0,
                  1,
                ],
              },
            },
          },
        },
        completionTime: { $sum: "$results.time" },
        timingRounds: {
          $filter: {
            input: "$results",
            as: "r",
            cond: {
              $or: [
                { $ne: ["$$r._id", "memory"] },
                { $eq: ["$$r.count", { $size: "$memberIds" }] },
              ],
            },
          },
        },
      },
    },
  ];
  pipeline.push({
    $set: {
      averageTime: {
        $cond: [
          { $gt: [{ $size: "$timingRounds" }, 0] },
          {
            $divide: [
              {
                $sum: {
                  $map: {
                    input: "$timingRounds",
                    as: "r",
                    in: {
                      $cond: [
                        { $eq: ["$$r._id", "memory"] },
                        { $divide: ["$$r.time", { $max: [1, "$$r.count"] }] },
                        "$$r.time",
                      ],
                    },
                  },
                },
              },
              { $size: "$timingRounds" },
            ],
          },
          null,
        ],
      },
    },
  });
  // Average each current member's normalized result against its own configuration snapshot.
  pipeline.push({
    $set: {
      total: {
        $sum: {
          $map: {
            input: "$results",
            as: "r",
            in: {
              $multiply: [
                {
                  $cond: [
                    { $eq: ["$$r._id", "memory"] },
                    {
                      $divide: [
                        "$$r.ratios",
                        { $max: [1, { $size: "$memberIds" }] },
                      ],
                    },
                    {
                      $cond: [
                        { $gt: ["$$r.maximum", 0] },
                        {
                          $min: [
                            1,
                            {
                              $max: [
                                0,
                                { $divide: ["$$r.score", "$$r.maximum"] },
                              ],
                            },
                          ],
                        },
                        0,
                      ],
                    },
                  ],
                },
                {
                  $switch: {
                    branches: Object.keys(defaults).map((id) => ({
                      case: { $eq: ["$$r._id", id] },
                      // oxlint-disable-next-line unicorn/no-thenable
                      then:
                        (Number.isFinite(settings[id]?.weight) &&
                        settings[id].weight >= 0 &&
                        settings[id].weight <= 100
                          ? settings[id].weight
                          : defaults[id].weight) * 10,
                    })),
                    default: 0,
                  },
                },
              ],
            },
          },
        },
      },
    },
  });
  if (game)
    pipeline.push({ $set: { total: { $ifNull: [`$scores.${game}`, 0] } } });
  // Participant scores are filtered before aggregation and never ranked against other teams.
  if (!teamId)
    pipeline.push(
      {
        $set: {
          ranking: {
            primary: sort.startsWith("time")
              ? {
                  $ifNull: [
                    {
                      $multiply: [
                        sort === "time-desc" ? -1 : 1,
                        "$averageTime",
                      ],
                    },
                    Number.MAX_SAFE_INTEGER,
                  ],
                }
              : { $multiply: [sort === "score-asc" ? 1 : -1, "$total"] },
            secondary: sort.startsWith("time")
              ? { $multiply: [-1, "$total"] }
              : { $ifNull: ["$averageTime", Number.MAX_SAFE_INTEGER] },
            negativeCompleted: { $multiply: [-1, "$completed"] },
            completionTime: "$completionTime",
            team: "$_id",
          },
        },
      },
      {
        $setWindowFields: {
          sortBy: { ranking: 1 },
          output: { rank: { $documentNumber: {} } },
        },
      },
    );
  if (search)
    pipeline.push({
      $match: {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { code: { $regex: search, $options: "i" } },
        ],
      },
    });
  if (completedOnly) pipeline.push({ $match: { completed: 4 } });
  pipeline.push({
    $facet: {
      rows: [
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            name: 1,
            code: 1,
            scores: 1,
            total: { $round: ["$total", 2] },
            ...(teamId ? {} : { rank: 1 }),
            completed: 1,
            completionTime: 1,
            averageTime: 1,
          },
        },
      ],
      count: [{ $count: "total" }],
    },
  });
  const [result] = await Team.aggregate(pipeline);
  return { rows: result.rows, total: result.count[0]?.total || 0, page, limit };
}
