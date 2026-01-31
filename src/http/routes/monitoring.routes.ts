import express from "express";
import { NodeService } from "../../services/node-service.js";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { checkLink, lastCheckinMap } from "../../utils/common.js";
import { getLastWednesdayTimestamp } from "../../utils/time.js";
import { MapService } from "../../services/map-service.js";
import { Checkin } from "../../services/logic/checkin.js";

const router = express.Router();

router.get("/random-peers", (req, res) => {
    try {
        let expectedLitePeersLength =
            parseInt(req.query.litePeers as string) || 2;
        let expectedBobPeersLength =
            parseInt(req.query.bobPeers as string) || 2;
        let service = req.query.service as MongoDbTypes.ServiceType;
        if (service == MongoDbTypes.ServiceType.LiteNode) {
            let peers = NodeService.getRandomLiteNode(
                expectedLitePeersLength
            ).map((peer) => peer.server);
            res.json({ peers: peers });
        } else if (service == MongoDbTypes.ServiceType.BobNode) {
            let litePeers = NodeService.getRandomLiteNode(
                expectedLitePeersLength,
                true
            ).map((peer) => peer.server);
            let bobPeers = NodeService.getRandomBobNode(
                expectedBobPeersLength
            ).map((peer) => peer.server);
            res.json({
                litePeers: litePeers,
                bobPeers: bobPeers,
            });
        } else {
            res.status(400).json({ error: "Invalid service type" });
        }
    } catch (error) {
        logger.error(
            `Error fetching random peers: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch random peers " + error,
        });
    }
});

router.post("/checkin", async (req, res) => {
    try {
        let body = req.body;
        let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
        // check if body is object (valid json)
        if (typeof body !== "object") {
            res.status(400).json({ error: "Invalid JSON body" });
            return;
        }
        if (Array.isArray(body)) {
            res.status(400).json({ error: "Invalid JSON body" });
            return;
        }
        // these field must be exists: type, version, uptime, operator, signature, timestamp
        const requiredFields = [
            "type",
            "version",
            "uptime",
            "operator",
            "signature",
            "timestamp",
        ];
        for (let field of requiredFields) {
            if (!(field in body)) {
                res.status(400).json({
                    error: `Missing required field: ${field}`,
                });
                return;
            }
        }
        // rate limit: only allow checkin once every 30 minutes per ip+type+operator
        let rateLimitKey = `${ip}-${body.type}-${body.operator}`;
        let now = Date.now();
        if (
            lastCheckinMap[rateLimitKey] &&
            now - lastCheckinMap[rateLimitKey] < 30 * 60 * 1000
        ) {
            res.status(429).json({
                error: "Too many checkins. Please wait before checking in again.",
            });
            return;
        }
        lastCheckinMap[rateLimitKey] = now;
        // insert to mongodb
        await Mongodb.getCheckinsCollection().insertOne({
            ...body,
            ip: ip,
            lastCheckinAt: Date.now(),
        });
        MapService.enqueueServerForIpLookup(ip as string);
        res.json({ message: "Checkin successful" });
    } catch (error) {
        logger.error(`Error in checkin: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to checkin " + error,
        });
    }
});

router.get("/checkins", async (req, res) => {
    try {
        let type = req.query.type as string | undefined;
        let operator = req.query.operator as string | undefined;
        let ipv4 = req.query.ip as string | undefined;
        let normalized =
            req.query.normalized === "true" || req.query.normalized === "1";
        let epoch = parseInt(req.query.epoch as string) || 0;
        let excludeDefaultOp = req.query.excludeDefaultOp === "true";

        let checkins;
        try {
            checkins = await Checkin.getCheckins({
                type,
                operator,
                ipv4,
                normalized,
                epoch,
                excludeDefaultOp,
            });
        } catch (error) {
            res.status(400).json({
                error: (error as Error).message,
            });
            return;
        }

        res.json({ checkins });
    } catch (error) {
        logger.error(`Error fetching checkins: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to fetch checkins " + error,
        });
    }
});

router.get("/currenttick", (_, res) => {
    try {
        let { tick, epoch } = NodeService.getNetworkStatus();
        res.json({ tick, epoch });
    } catch (error) {
        logger.error(
            `Error fetching current tick: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch current tick " + error,
        });
    }
});

export default router;
