import express from "express";
import { Mongodb, IS_NO_DB } from "../../database/db.js";
import { LeaderService } from "../../services/leader-service.js";
import { NodeService } from "../../services/node-service.js";

const router = express.Router();

// Health check endpoint
router.get("/", (req, res) => {
    res.send("Qubic iz da bes', homie!");
});

// Cluster-aware health for the Cloudflare Load Balancer monitor + ops.
// Returns 200 on ANY healthy instance — reads are active-active, so this must
// NOT be leader-gated. `leader`/`instanceId` are observability only.
router.get("/health", async (req, res) => {
    const base = {
        instanceId: LeaderService.getInstanceId(),
        leader: LeaderService.isLeader(),
        snapshotAgeMs: NodeService.getRealtimeSnapshotAgeMs(),
        uptime: Math.round(process.uptime()),
    };
    if (IS_NO_DB) {
        res.json({ status: "ok", mongo: "skipped", ...base });
        return;
    }
    try {
        await Mongodb.getDB().command({ ping: 1 });
        res.json({ status: "ok", mongo: "up", ...base });
    } catch (error) {
        // Mongo unreachable → this instance can't serve fresh data; let the LB
        // route elsewhere. If Mongo is fully down, all instances report this.
        res.status(503).json({ status: "degraded", mongo: "down", ...base });
    }
});

export default router;
