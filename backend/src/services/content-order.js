import { Content, Setting } from "../models/index.js";
import { transaction } from "../config/db.js";

const counterKey = (game) => `content-order:${game}`;

// Initialize before the content transaction; simultaneous first uploads may upsert.
export async function prepareContentOrder(game) {
  const last = await Content.findOne({ gameId: game })
    .sort({ order: -1 })
    .select("order")
    .lean();
  const highest = Number.isSafeInteger(last?.order)
    ? Math.max(-1, last.order)
    : -1;
  const update = { $max: { "value.lastOrder": highest } };
  try {
    await Setting.updateOne({ key: counterKey(game) }, update, {
      upsert: true,
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    await Setting.updateOne({ key: counterKey(game) }, update);
  }
}

// Allocate inside the same transaction as the content write. Conflicting uploads retry.
export async function nextContentOrder(game, session) {
  const counter = await Setting.findOneAndUpdate(
    { key: counterKey(game) },
    { $inc: { "value.lastOrder": 1 } },
    { new: true, session },
  );
  if (!counter || !Number.isSafeInteger(counter.value.lastOrder))
    throw new Error("Content order counter is unavailable.");
  return counter.value.lastOrder;
}

export async function repairContentOrders(game) {
  await prepareContentOrder(game);
  return transaction(async (session) => {
    const contents = await Content.find({ gameId: game })
      .sort({ order: 1, _id: 1 })
      .session(session);
    const seen = new Set();
    let repaired = 0;
    for (const content of contents) {
      if (
        !Number.isSafeInteger(content.order) ||
        content.order < 0 ||
        seen.has(content.order)
      ) {
        content.order = await nextContentOrder(game, session);
        await content.save({ session });
        repaired++;
      }
      seen.add(content.order);
    }
    return repaired;
  });
}
