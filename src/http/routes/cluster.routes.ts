import express from "express";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { Mongodb, IS_NO_DB } from "../../database/db.js";
import { NodeService } from "../../services/node-service.js";

const router = express.Router();

// Admin-only System Health: backend instances + DB replica-set status + a
// managed-node summary. Each section is independently fault-isolated so one
// failing source doesn't blank the whole page.
router.get("/system-health", authenticateToken, async (req, res) => {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }

    const out: {
        instances: any[];
        instancesError?: string;
        replica: any;
        nodes: any;
    } = { instances: [], replica: null, nodes: null };

    // Backend instances (from the cluster_members heartbeats).
    try {
        const now = Date.now();
        const members = await Mongodb.getClusterMembersCollection()
            .find({})
            .toArray();
        out.instances = members
            .map((m) => {
                const lastSeenMs = m.lastSeen
                    ? now - new Date(m.lastSeen).getTime()
                    : null;
                return {
                    instanceId: m._id,
                    leader: !!m.leader,
                    uptimeSec: m.uptimeSec ?? null,
                    snapshotAgeMs: m.snapshotAgeMs ?? null,
                    lastSeenMs,
                    stale: lastSeenMs === null || lastSeenMs > 15_000,
                };
            })
            .sort((a, b) => Number(b.leader) - Number(a.leader));
    } catch (error) {
        out.instancesError = (error as Error).message;
    }

    // DB replica-set status. Requires the app DB user to have the clusterMonitor
    // role (see docs/CLUSTERING.md); otherwise this returns ok:false + the error.
    try {
        if (IS_NO_DB) {
            out.replica = { ok: false, error: "NO_DB mode" };
        } else {
            const rs: any = await Mongodb.getDB()
                .admin()
                .command({ replSetGetStatus: 1 });
            const primaryOptime = rs.members?.find(
                (m: any) => m.stateStr === "PRIMARY"
            )?.optimeDate;
            out.replica = {
                ok: true,
                set: rs.set,
                members: (rs.members || []).map((m: any) => ({
                    name: m.name,
                    state: m.stateStr,
                    health: m.health, // 1 = up, 0 = down
                    uptimeSec: m.uptime,
                    self: !!m.self,
                    lagSec:
                        m.stateStr === "PRIMARY" ||
                        !primaryOptime ||
                        !m.optimeDate
                            ? 0
                            : Math.max(
                                  0,
                                  (new Date(primaryOptime).getTime() -
                                      new Date(m.optimeDate).getTime()) /
                                      1000
                              ),
                })),
            };
        }
    } catch (error) {
        out.replica = { ok: false, error: (error as Error).message };
    }

    // Managed-node summary (already in memory from polling/snapshot).
    try {
        out.nodes = NodeService.getClusterNodesSummary();
    } catch (error) {
        out.nodes = null;
    }

    res.json(out);
});

export default router;
