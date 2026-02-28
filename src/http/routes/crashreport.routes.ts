import express from "express";
import { Mongodb, MongoDbTypes } from "../../database/db.js";

const router = express.Router();

router.get("/crash-reports", async (req, res) => {
    try {
        let query: any = {};
        for (const key in req.query) {
            query[key] = req.query[key];
        }
        const crashReports = await Mongodb.getCrashReportsCollection()
            .find(query as any)
            .sort({ timestamp: -1 })
            .toArray();
        res.status(200).json(crashReports);
    } catch (error) {
        res.status(500).json({ message: "Failed to retrieve crash reports" });
    }
});

router.post("/crash-reports", async (req, res) => {
    try {
        const crashReport: object = req.body;
        let ip = req.ip || req.socket.remoteAddress;
        ip = ip?.replace("::ffff:", "") || "unknown"; // Handle IPv4-mapped IPv6 addresses
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
