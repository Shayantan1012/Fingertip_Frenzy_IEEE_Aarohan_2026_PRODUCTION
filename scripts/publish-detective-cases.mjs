import mongoose from "mongoose";
import {
  connectDB,
  transaction,
  connectionErrorCode,
} from "../backend/src/config/db.js";
import { Content } from "../backend/src/models/index.js";
import { detectiveData } from "../backend/src/services/content.js";
import { repairContentOrders } from "../backend/src/services/content-order.js";

// Publish valid saved cases without changing any active attempt or score.
try {
  await connectDB();
  const repairedOrders = {
    detective: await repairContentOrders("detective"),
    puzzle: await repairContentOrders("puzzle"),
  };
  const result = await transaction(async (session) => {
    const drafts = await Content.find({
      gameId: "detective",
      published: { $ne: true },
    })
      .session(session)
      .lean();
    const valid = drafts.filter((c) => detectiveData.safeParse(c.data).success);
    const invalid = drafts.filter(
      (c) => !detectiveData.safeParse(c.data).success,
    );
    const updated = await Content.updateMany(
      {
        _id: { $in: valid.map((c) => c._id) },
        gameId: "detective",
        published: { $ne: true },
      },
      { $set: { published: true } },
      { session },
    );
    return {
      published: updated.modifiedCount,
      incompleteCases: invalid.map((c) => String(c._id)),
    };
  });
  console.log(JSON.stringify({ status: "ok", ...result, repairedOrders }));
  if (result.incompleteCases.length)
    console.warn(
      "Incomplete Detective cases remain unpublished. Correct them in the admin editor and save to publish.",
    );
} catch (error) {
  console.error(
    JSON.stringify({
      status: "unavailable",
      code: error.publicCode || connectionErrorCode(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
