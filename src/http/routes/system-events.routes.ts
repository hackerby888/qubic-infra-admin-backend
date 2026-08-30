import express from "express";
import { ObjectId } from "mongodb";
import { Mongodb } from "../../database/db.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { logger } from "../../utils/logger.js";

const router = express.Router();

// Admin-only: the log spans every operator's nodes, so it is gated like /system-health.
function requireAdmin(req: express.Request, res: express.Response): boolean {
    if (!req.user || req.user.role !== "admin") {
        res.status(403).json({ error: "Admin access required" });
        return false;
    }

    return true;
}

// Shared by GET and by the "clear this range" DELETE, so the button can never
// delete a different set than the one on screen.
function buildEventQuery(source: any): Record<string, unknown> {
    const query: any = {};

    if (typeof source.type === "string" && source.type.length > 0) {
        query.type = source.type;
    }
    if (typeof source.server === "string" && source.server.length > 0) {
        query.server = source.server;
    }
    if (typeof source.severity === "string" && source.severity.length > 0) {
        query.severity = source.severity;
    }

    const timestampFilter: { $gte?: number; $lte?: number } = {};

    // `sinceMs` is a DURATION ("last 30 minutes") resolved per request, so a page left open
    // keeps polling a sliding window. `since` (absolute epoch ms) stays for scripted use.
    const sinceMs = Number(source.sinceMs);
    if (!Number.isNaN(sinceMs) && sinceMs > 0) {
        timestampFilter.$gte = Date.now() - sinceMs;
    }

    const since = Number(source.since);
    if (!Number.isNaN(since) && since > 0) {
        timestampFilter.$gte = since;
    }

    const until = Number(source.until);
    if (!Number.isNaN(until) && until > 0) {
        timestampFilter.$lte = until;
    }

    if (Object.keys(timestampFilter).length > 0) {
        query.timestamp = timestampFilter;
    }

    return query;
}

router.get("/system-events", authenticateToken, async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const query = buildEventQuery(req.query);

        let limit = Number(req.query.limit);
        if (Number.isNaN(limit) || limit <= 0) limit = 500;
        limit = Math.min(limit, 5000);

        // `_id` is kept (unlike /crash-reports) — it is the delete key.
        const collection = Mongodb.getSystemEventsCollection();
        const [items, total] = await Promise.all([
            collection.find(query as any).sort({ timestamp: -1 }).limit(limit).toArray(),
            collection.countDocuments(query as any),
        ]);

        res.status(200).json({ items, total, limit });
    } catch (error) {
        logger.error(`Failed to retrieve system events: ${(error as Error).message}`);
        res.status(500).json({ error: "Failed to retrieve system events" });
    }
});

// One DELETE route with ids in the body: `{ ids: [...] }` removes those rows, otherwise the
// same filter as the GET is cleared. A path-param variant would not fit the frontend's
// useGeneralPost, which binds its path once per hook.
router.delete("/system-events", authenticateToken, async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const ids = req.body?.ids;
        let filter: Record<string, unknown>;

        if (Array.isArray(ids) && ids.length > 0) {
            if (!ids.every((id) => ObjectId.isValid(id))) {
                res.status(400).json({ error: "Invalid event id" });
                return;
            }

            filter = { _id: { $in: ids.map((id) => new ObjectId(id)) } };
        } else {
            filter = buildEventQuery(req.body ?? {});

            if (Object.keys(filter).length === 0) {
                res.status(400).json({ error: "Refusing to delete every event — pass ids or a filter" });
                return;
            }
        }

        const result = await Mongodb.getSystemEventsCollection().deleteMany(filter as any);
        res.status(200).json({ message: "System event(s) deleted", deletedCount: result.deletedCount });
    } catch (error) {
        logger.error(`Failed to delete system events: ${(error as Error).message}`);
        res.status(500).json({ error: "Failed to delete system events" });
    }
});

export default router;
