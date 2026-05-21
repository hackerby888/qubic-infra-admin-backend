import express from "express";
import { isIP } from "net";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { NodeService } from "../../services/node-service.js";

const router = express.Router();

// Accept either an array of IPs or a single string with IPs separated by
// commas / whitespace / newlines (e.g. "ip1,ip2,ip3"). Returns deduped, trimmed list.
function parseIps(input: unknown): string[] {
    let raw: string[] = [];
    if (Array.isArray(input)) {
        raw = input.map((v) => String(v));
    } else if (typeof input === "string") {
        raw = input.split(/[\s,]+/);
    }
    return [...new Set(raw.map((s) => s.trim()).filter((s) => s.length > 0))];
}

function requireAdmin(req: express.Request, res: express.Response): boolean {
    if (!req.user || req.user.role !== "admin") {
        res.status(403).json({ error: "Admin access required" });
        return false;
    }
    return true;
}

router.get("/blacklisted-peers", authenticateToken, async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;

        let peers = await Mongodb.getBlacklistedPeersCollection()
            .find({}, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ peers });
    } catch (error) {
        logger.error(
            `Error fetching blacklisted peers: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch blacklisted peers " + error,
        });
    }
});

router.post("/blacklisted-peers", authenticateToken, async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;

        let operator = req.user?.username || "admin";
        let note = typeof req.body?.note === "string" ? req.body.note : undefined;
        let candidates = parseIps(req.body?.ips);

        if (candidates.length === 0) {
            res.status(400).json({ error: "No IPs provided" });
            return;
        }

        let valid: string[] = [];
        let invalid: string[] = [];
        for (let ip of candidates) {
            if (isIP(ip) !== 0) {
                valid.push(ip);
            } else {
                invalid.push(ip);
            }
        }

        // upsert is idempotent: re-adding an existing IP succeeds (no error),
        // it just matches instead of inserting.
        let added = 0;
        let alreadyPresent = 0;
        if (valid.length > 0) {
            let now = Date.now();
            // only overwrite note when one was supplied (don't wipe it on re-add)
            let noteSet = note !== undefined ? { note } : {};
            let results = await Promise.all(
                valid.map((ip) =>
                    Mongodb.getBlacklistedPeersCollection().updateOne(
                        { ip },
                        {
                            $set: { ip, ...noteSet },
                            $setOnInsert: { operator, createdAt: now },
                        },
                        { upsert: true }
                    )
                )
            );
            for (let r of results) {
                if (r.upsertedCount > 0) added++;
                else alreadyPresent++;
            }
            await NodeService.refreshBlacklistedPeers();
        }

        res.json({
            message: "Blacklist updated",
            added,
            alreadyPresent,
            invalid,
        });
    } catch (error) {
        logger.error(
            `Error adding blacklisted peers: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to add blacklisted peers " + error,
        });
    }
});

router.delete("/blacklisted-peers", authenticateToken, async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;

        // accept a single { ip } or multiple { ips } (array or comma-separated string)
        let ips = parseIps(req.body?.ips ?? req.body?.ip);
        if (ips.length === 0) {
            res.status(400).json({ error: "ip or ips is required" });
            return;
        }

        let result = await Mongodb.getBlacklistedPeersCollection().deleteMany({
            ip: { $in: ips },
        });
        await NodeService.refreshBlacklistedPeers();
        res.json({
            message: "Blacklisted peer(s) removed",
            deleted: result.deletedCount,
        });
    } catch (error) {
        logger.error(
            `Error deleting blacklisted peer: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to delete blacklisted peer " + error,
        });
    }
});

export default router;
