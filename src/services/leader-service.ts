import { randomUUID } from "crypto";
import { Mongodb, IS_NO_DB } from "../database/db.js";
import { logger } from "../utils/logger.js";

/**
 * Single-leader election over MongoDB (see docs/CLUSTERING.md).
 *
 * Every instance runs this. Exactly one holds an unexpired lease in the
 * `leader_election` collection and is the leader. Only the leader runs node
 * polling + SSH automation, so those never double-fire across instances. All
 * instances still serve HTTP/Socket reads.
 *
 * NO_DB mode is always-leader (single instance) — behavior unchanged.
 */
export namespace LeaderService {
    const instanceId = randomUUID();
    const LEASE_MS = Number(process.env.LEADER_LEASE_MS) || 15_000;
    const RENEW_MS = Number(process.env.LEADER_RENEW_MS) || 5_000;
    const LEADER_DOC_ID = "leader";

    let _isLeader = false;
    let _started = false;
    const _onBecomeLeaderCbs: Array<() => void | Promise<void>> = [];

    export function isLeader(): boolean {
        return IS_NO_DB ? true : _isLeader;
    }

    export function getInstanceId(): string {
        return instanceId;
    }

    /**
     * Register a callback fired each time THIS instance transitions to leader
     * (false → true), including the first acquisition and every re-election
     * after a failover. Use for one-shot leader work (e.g. reconcile stale
     * states) that must run on whichever instance currently leads.
     */
    export function onBecomeLeader(cb: () => void | Promise<void>) {
        _onBecomeLeaderCbs.push(cb);
        // Fire immediately if we're already leader when a late subscriber joins.
        if (_isLeader) runCb(cb);
    }

    function runCb(cb: () => void | Promise<void>) {
        try {
            Promise.resolve(cb()).catch((err) =>
                logger.error(`👑 onBecomeLeader callback error: ${err.message}`)
            );
        } catch (err: any) {
            logger.error(`👑 onBecomeLeader callback error: ${err.message}`);
        }
    }

    function setLeader(won: boolean) {
        const wasLeader = _isLeader;
        _isLeader = won;
        if (won && !wasLeader) {
            logger.info(`👑 This instance (${instanceId}) is now LEADER`);
            for (const cb of _onBecomeLeaderCbs) runCb(cb);
        } else if (!won && wasLeader) {
            logger.warn(`👑 This instance (${instanceId}) lost leadership`);
        }
    }

    async function acquire() {
        const now = Date.now();
        const expiresAt = new Date(now + LEASE_MS);
        try {
            // Take the lease if it's free (expired) or already ours (renew).
            // Atomic on the single `_id:"leader"` doc, so concurrent acquirers
            // are serialized and exactly one wins.
            const res =
                await Mongodb.getLeaderElectionCollection().findOneAndUpdate(
                    {
                        _id: LEADER_DOC_ID,
                        $or: [
                            { expiresAt: { $lt: new Date(now) } },
                            { instanceId },
                        ],
                    },
                    {
                        $set: { instanceId, renewedAt: now, expiresAt },
                        $setOnInsert: { acquiredAt: now },
                    },
                    { upsert: true, returnDocument: "after" }
                );
            setLeader(res?.instanceId === instanceId);
        } catch (err: any) {
            // E11000: the doc exists and is held by a live other instance, so
            // our filter matched nothing and the upsert tried to insert a second
            // `_id:"leader"` → duplicate key. Means: not leader.
            if (err?.code !== 11000) {
                logger.error(`👑 Leader election error: ${err.message}`);
            }
            setLeader(false);
        }
    }

    export async function start() {
        if (_started) return;
        _started = true;

        if (IS_NO_DB) {
            setLeader(true);
            logger.info("👑 NO_DB mode — single instance is always leader");
            return;
        }

        await acquire(); // resolve initial status before loops spawn
        setInterval(() => {
            acquire().catch((err) =>
                logger.error(`👑 Leader renew error: ${err.message}`)
            );
        }, RENEW_MS);
        logger.info(
            `👑 Leader election started (instance ${instanceId}, lease ${LEASE_MS}ms, renew ${RENEW_MS}ms)`
        );
    }

    /**
     * Best-effort lease release on graceful shutdown so a standby takes over
     * within one renew tick instead of waiting out a full lease.
     */
    export async function resign() {
        if (IS_NO_DB || !_isLeader) return;
        try {
            await Mongodb.getLeaderElectionCollection().deleteOne({
                _id: LEADER_DOC_ID,
                instanceId,
            });
            _isLeader = false;
            logger.info("👑 Released leadership on shutdown");
        } catch (err: any) {
            logger.error(`👑 Failed to release leadership: ${err.message}`);
        }
    }
}
