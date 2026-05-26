import express from "express";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get("/crash-reports", authenticateToken, async (req, res) => {
    try {
        const query: any = {};

        if (typeof req.query.type === "string" && req.query.type.length > 0) {
            query.type = req.query.type;
        }
        if (typeof req.query.ip === "string" && req.query.ip.length > 0) {
            query.ip = req.query.ip;
        }

        const timestampFilter: { $gte?: number; $lte?: number } = {};
        const sinceDays = Number(req.query.sinceDays);
        if (!Number.isNaN(sinceDays) && sinceDays > 0) {
            timestampFilter.$gte =
                Date.now() - sinceDays * 24 * 60 * 60 * 1000;
        }
        const since = Number(req.query.since);
        if (!Number.isNaN(since) && since > 0) {
            timestampFilter.$gte = since;
        }
        const until = Number(req.query.until);
        if (!Number.isNaN(until) && until > 0) {
            timestampFilter.$lte = until;
        }
        if (Object.keys(timestampFilter).length > 0) {
            query.timestamp = timestampFilter;
        }

        let limit = Number(req.query.limit);
        if (Number.isNaN(limit) || limit <= 0) limit = 500;
        limit = Math.min(limit, 5000);

        const cursor = Mongodb.getCrashReportsCollection()
            .find(query, { projection: { _id: 0 } })
            .sort({ timestamp: -1 })
            .limit(limit);

        const [items, total] = await Promise.all([
            cursor.toArray(),
            Mongodb.getCrashReportsCollection().countDocuments(query),
        ]);

        res.status(200).json({ items, total, limit });
    } catch (error) {
        res.status(500).json({ message: "Failed to retrieve crash reports" });
    }
});

router.post("/crash-reports", async (req, res) => {
    try {
        const crashReport: object = req.body;
        const xff = req.headers["x-forwarded-for"];
        const xffFirst = Array.isArray(xff)
            ? xff[0]
            : typeof xff === "string"
                ? xff.split(",")[0]?.trim()
                : undefined;
        let ip = xffFirst || req.socket.remoteAddress || req.ip || "unknown";
        ip = ip.replace("::ffff:", ""); // Handle IPv4-mapped IPv6 addresses
        let type: string = "unknown";
        if (crashReport.hasOwnProperty("type")) {
            const reportType = (crashReport as any).type;
            type = reportType;
        }
        await Mongodb.getCrashReportsCollection().insertOne({
            ip,
            logs: JSON.stringify(crashReport),
            timestamp: Date.now(),
            type,
        });
        res.status(200).json({ message: "Crash report received successfully" });
    } catch (error) {
        res.status(500).json({ message: "Failed to process crash report" });
    }
});

export default router;
