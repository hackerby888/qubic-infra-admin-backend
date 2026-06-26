import { MongoClient, Db, Collection } from "mongodb";
import { logger } from "../utils/logger.js";
import type { IpInfo } from "../utils/ip.js";

const uri = process.env.MONGO_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGO_DB_NAME || "qubic_nodes";

export const IS_NO_DB =
    process.env.NO_DB === "true" || process.env.NO_DB === "1";

let client: MongoClient;
let db: Db;

function createStubCursor(): any {
    const cursor: any = {
        toArray: async () => [],
        sort: () => cursor,
        limit: () => cursor,
        skip: () => cursor,
        project: () => cursor,
        map: () => cursor,
        forEach: async () => {},
        next: async () => null,
        hasNext: async () => false,
        close: async () => {},
        [Symbol.asyncIterator]: async function* () {},
    };
    return cursor;
}

const stubCollectionCache: Record<string, any> = {};

function createStubCollection<T extends Record<string, any>>(
    name: string
): Collection<T> {
    if (stubCollectionCache[name]) return stubCollectionCache[name];
    const handler: ProxyHandler<any> = {
        get(_target, prop) {
            // Avoid making the proxy look like a thenable — would hang `await`.
            if (prop === "then" || prop === "catch" || prop === "finally")
                return undefined;
            if (typeof prop === "symbol") return undefined;
            switch (prop) {
                case "collectionName":
                    return name;
                case "find":
                case "aggregate":
                case "listIndexes":
                case "listSearchIndexes":
                    return () => createStubCursor();
                case "findOne":
                case "findOneAndUpdate":
                case "findOneAndReplace":
                case "findOneAndDelete":
                    return async () => null;
                case "insertOne":
                    return async () => ({
                        acknowledged: false,
                        insertedId: null,
                    });
                case "insertMany":
                    return async () => ({
                        acknowledged: false,
                        insertedCount: 0,
                        insertedIds: {},
                    });
                case "updateOne":
                case "updateMany":
                case "replaceOne":
                    return async () => ({
                        acknowledged: false,
                        matchedCount: 0,
                        modifiedCount: 0,
                        upsertedCount: 0,
                        upsertedId: null,
                    });
                case "deleteOne":
                case "deleteMany":
                    return async () => ({
                        acknowledged: false,
                        deletedCount: 0,
                    });
                case "countDocuments":
                case "estimatedDocumentCount":
                    return async () => 0;
                case "distinct":
                    return async () => [];
                case "createIndex":
                case "createIndexes":
                    return async () => "";
                case "dropIndex":
                case "dropIndexes":
                case "drop":
                    return async () => true;
                case "bulkWrite":
                    return async () => ({
                        ok: 1,
                        insertedCount: 0,
                        matchedCount: 0,
                        modifiedCount: 0,
                        deletedCount: 0,
                        upsertedCount: 0,
                        insertedIds: {},
                        upsertedIds: {},
                    });
                default:
                    return async () => null;
            }
        },
    };
    const proxy = new Proxy({}, handler) as Collection<T>;
    stubCollectionCache[name] = proxy;
    return proxy;
}

let stubDb: Db | null = null;
function getStubDb(): Db {
    if (stubDb) return stubDb;
    const handler: ProxyHandler<any> = {
        get(_target, prop) {
            if (prop === "then" || prop === "catch" || prop === "finally")
                return undefined;
            if (typeof prop === "symbol") return undefined;
            if (prop === "collection") {
                return (name: string) => createStubCollection(name);
            }
            return async () => null;
        },
    };
    stubDb = new Proxy({}, handler) as Db;
    return stubDb;
}

export namespace MongoDbTypes {
    export type NodeStatus =
        | "setting_up"
        | "active"
        | "error"
        | "stopped"
        | "restarting";
    export type CommandStatus = "pending" | "completed" | "failed";

    export interface Checkin {
        type: string;
        version: string;
        uptime: number;
        operator: string;
        signature: string;
        timestamp: number;
        ip: string;
        lastCheckinAt: number;
    }

    export interface CronJob {
        operator: string;
        cronId: string;
        name: string;
        schedule: string;
        command: string;
        type: "system" | "custom";
        lastRun: number | null;
        status: "success" | "failed" | "running" | "idle";
        isEnabled: boolean;
    }

    export interface ServerIpInfo {
        server: string;
        ipInfo: IpInfo;
    }

    export interface ShortcutCommand {
        operator: string;
        name: string;
        command: string;
    }

    export interface LiteNode {
        server: string;
        operator?: string;
        ids?: string[];
        // groupId represents the operator group the lite node belongs to (like a cluster of Main/aux nodes)
        groupId?: string;
        isPrivate: boolean;
        passcode?: string;
        customParameter?: string;
    }

    export interface BobNode {
        server: string;
        operator?: string;
        isPrivate: boolean;
    }

    export interface CommandLog {
        operator: string;
        // A command may run a mutilple servers
        servers?: string[];
        command: string;
        // standard command indicates if the command is one of the predefined commands like shutdown or restart
        isStandardCommand: boolean;
        stdout: string;
        stderr: string;
        timestamp: number;
        status: CommandStatus;
        uuid: string;
        duration: number;
        errorServers?: string[];
        // Clear, classified reason when status === "failed" (e.g. SSH connect
        // refused, command timeout, or watchdog-detected stuck-pending).
        errorMessage?: string;
    }

    export enum ServiceType {
        LiteNode = "liteNode",
        BobNode = "bobNode",
        null = "null",
    }

    export interface Server {
        server: string;
        sshPort?: number; // default to 22
        ipInfo?: IpInfo;
        alias?: string;
        note?: string;
        skipBulkSelect?: boolean; // exclude from "Select Lite/Bob Nodes" bulk select (e.g. runs a separate binary)
        operator: string;
        username: string;
        password: string;
        services: ServiceType[];
        cpu?: string;
        os?: string;
        ram?: string;
        status: NodeStatus;
        setupLogs?: {
            stdout: string;
            stderr: string;
        };
        deployStatus?: {
            liteNode?: NodeStatus;
            bobNode?: NodeStatus;
        };
        // Epoch-ms when each service last entered a transient state
        // ("setting_up"/"restarting"). The stuck-deploy watchdog uses this to
        // measure how long a deploy/restart has been pending.
        deployStatusAt?: {
            liteNode?: number;
            bobNode?: number;
        };
        deployLogs?: {
            liteNode?: {
                stdout: string;
                stderr: string;
            };
            bobNode?: {
                stdout: string;
                stderr: string;
            };
        };
        sshPrivateKey: string;
        ttyd?: {
            token: string;
            port: number;
        };
    }

    export interface User {
        username: string;
        passwordHash: string;
        role: "admin" | "operator";
        currentsshPrivateKey?: string;
        insertedAt: number;
    }

    export interface CrashReport {
        ip: string;
        type: string;
        logs: string;
        timestamp: number;
    }

    export interface BlacklistedPeer {
        ip: string;
        note?: string;
        operator: string; // admin username who added it (audit)
        createdAt: number;
    }

    // Generic single-value app settings, keyed by `key`. Used for fleet-wide
    // config like the global lite-node custom parameter.
    export interface Setting {
        key: string;
        value: string;
    }

    // ---- Multi-instance clustering coordination (see docs/CLUSTERING.md) ----

    // Single-doc (`_id:"leader"`) Mongo TTL lease. Whichever instance owns the
    // unexpired lease is the leader and runs polling + SSH automation.
    export interface LeaderElection {
        _id: string; // always "leader"
        instanceId: string;
        acquiredAt: number;
        renewedAt: number;
        expiresAt: Date; // TTL-indexed (crash backstop) + lease comparison
    }

    // Distributed per-host SSH lock (`_id:"<host>"`). Serializes mutating SSH
    // across instances so a deploy/command never collides with another.
    export interface SshLock {
        _id: string; // host
        instanceId: string;
        acquiredAt: number;
        expiresAt: Date; // TTL-indexed reap if the holder crashes
    }

    // Cross-instance checkin rate-limit window (`_id:"<ip>-<type>-<operator>"`).
    export interface CheckinRateLimit {
        _id: string;
        createdAt: number;
        expiresAt: Date; // TTL-reaped at the end of the window
    }

    // Realtime node-status snapshot the leader publishes (`_id:"system"` and
    // `_id:"checkin"`); non-leaders read it to serve identical realtime data.
    export interface RealtimeStatusSnapshot {
        _id: string; // "system" | "checkin"
        liteServers: Record<string, any>;
        bobServers: Record<string, any>;
        updatedAt: number;
        writerInstanceId: string;
    }

    // Per-instance heartbeat (`_id:"<instanceId>"`) for the System Health admin
    // view. TTL on `lastSeen` reaps a dead instance ~30s after its last beat.
    export interface ClusterMember {
        _id: string; // instanceId
        leader: boolean;
        uptimeSec: number;
        snapshotAgeMs: number | null;
        lastSeen: Date;
    }
}

export namespace Mongodb {
    const LITE_NODE_COLLECTION = "lite_nodes";
    const BOB_NODE_COLLECTION = "bob_nodes";

    export async function connectDB(): Promise<Db> {
        if (IS_NO_DB) {
            logger.info(
                "🔌 NO_DB mode enabled — skipping MongoDB connection"
            );
            return getStubDb();
        }

        if (db) return db; // reuse existing connection

        // Replica-set-aware client. retryWrites/retryReads ride out a primary
        // step-down; primaryPreferred keeps reads up during an election.
        // High-frequency regenerable writes (snapshot/locks/rate-limit) override
        // to { w: 1 } per-op so they don't pay majority-ack latency.
        client = new MongoClient(uri, {
            retryWrites: true,
            retryReads: true,
            w: "majority",
            readPreference: "primaryPreferred",
            serverSelectionTimeoutMS: 10_000,
            maxPoolSize: 50,
            minPoolSize: 5,
        });

        // The initial connect can race a replica-set election on cold start;
        // retry with backoff instead of crashing. The driver auto-reconnects
        // after the first successful connect.
        const MAX_ATTEMPTS = 10;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                logger.info(
                    `🔌 Connecting to MongoDB (attempt ${attempt}/${MAX_ATTEMPTS})...`
                );
                await client.connect();
                await client.db(dbName).command({ ping: 1 });
                break;
            } catch (err: any) {
                if (attempt === MAX_ATTEMPTS) {
                    logger.error(
                        `❌ MongoDB connect failed after ${MAX_ATTEMPTS} attempts: ${err.message}`
                    );
                    throw err;
                }
                const backoff = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
                logger.warn(
                    `⚠️ MongoDB connect failed (${err.message}); retrying in ${backoff}ms`
                );
                await new Promise((r) => setTimeout(r, backoff));
            }
        }

        db = client.db(dbName);
        logger.info("🔌 Connected to MongoDB");

        await setupIndexes();
        return db;
    }

    // Idempotent index setup. Each build is wrapped so a transient error or a
    // pre-existing duplicate (on a unique build) can't crash boot, and so
    // concurrent identical builds across instances are harmless.
    async function setupIndexes() {
        const idx = async (label: string, fn: () => Promise<unknown>) => {
            try {
                await fn();
            } catch (err: any) {
                logger.warn(
                    `⚠️ Index setup (${label}) skipped: ${err.message}`
                );
            }
        };

        await idx("lite_nodes.server", () =>
            getLiteNodeCollection().createIndex({ server: 1 }, { unique: true })
        );
        await idx("bob_nodes.server", () =>
            getBobNodeCollection().createIndex({ server: 1 }, { unique: true })
        );
        await idx("users.username", () =>
            getUsersCollection().createIndex({ username: 1 }, { unique: true })
        );
        await idx("servers.server", () =>
            getServersCollection().createIndex({ server: 1 }, { unique: true })
        );
        await idx("blacklisted_peers.ip", () =>
            getBlacklistedPeersCollection().createIndex(
                { ip: 1 },
                { unique: true }
            )
        );

        // Clustering coordination — TTL on `expiresAt` (a Date) reaps a crashed
        // holder's lease/lock/rate-limit doc even if app-side cleanup is skipped.
        await idx("leader_election.ttl", () =>
            getLeaderElectionCollection().createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            )
        );
        await idx("ssh_locks.ttl", () =>
            getSshLocksCollection().createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            )
        );
        await idx("checkin_rate_limit.ttl", () =>
            getCheckinRateLimitCollection().createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            )
        );
        // Reap a dead instance's heartbeat ~30s after its last beat.
        await idx("cluster_members.ttl", () =>
            getClusterMembersCollection().createIndex(
                { lastSeen: 1 },
                { expireAfterSeconds: 30 }
            )
        );
    }

    export async function disconnectDB() {
        if (client) {
            await client.close();
            console.log("🔌 Disconnected from MongoDB");
        }
    }

    export function getDB(): Db {
        if (IS_NO_DB) {
            return getStubDb();
        }
        if (!db) {
            throw new Error("Database not connected. Call connectDB first.");
        }
        return db;
    }

    export function getCrashReportsCollection() {
        return getDB().collection<MongoDbTypes.CrashReport>("crash_reports");
    }

    export function getBlacklistedPeersCollection() {
        return getDB().collection<MongoDbTypes.BlacklistedPeer>(
            "blacklisted_peers"
        );
    }

    export function getCheckinsCollection() {
        return getDB().collection<MongoDbTypes.Checkin>("checkins");
    }

    export function getCronJobsCollection() {
        return getDB().collection<MongoDbTypes.CronJob>("cron_jobs");
    }

    export function getServerIpInfoCollection() {
        return getDB().collection<MongoDbTypes.ServerIpInfo>("server_ip_info");
    }

    export function getShortcutCommandsCollection() {
        return getDB().collection<MongoDbTypes.ShortcutCommand>(
            "shortcut_commands"
        );
    }

    export function getLiteNodeCollection() {
        return getDB().collection<MongoDbTypes.LiteNode>(LITE_NODE_COLLECTION);
    }

    export function getBobNodeCollection() {
        return getDB().collection<MongoDbTypes.BobNode>(BOB_NODE_COLLECTION);
    }

    export function getServersCollection() {
        return getDB().collection<MongoDbTypes.Server>("servers");
    }

    export function getUsersCollection() {
        return getDB().collection<MongoDbTypes.User>("users");
    }

    export function getCommandLogsCollection() {
        return getDB().collection<MongoDbTypes.CommandLog>("command_logs");
    }

    export function getSettingsCollection() {
        return getDB().collection<MongoDbTypes.Setting>("settings");
    }

    export function getLeaderElectionCollection() {
        return getDB().collection<MongoDbTypes.LeaderElection>(
            "leader_election"
        );
    }

    export function getSshLocksCollection() {
        return getDB().collection<MongoDbTypes.SshLock>("ssh_locks");
    }

    export function getCheckinRateLimitCollection() {
        return getDB().collection<MongoDbTypes.CheckinRateLimit>(
            "checkin_rate_limit"
        );
    }

    export function getRealtimeStatusCollection() {
        return getDB().collection<MongoDbTypes.RealtimeStatusSnapshot>(
            "realtime_status"
        );
    }

    export function getClusterMembersCollection() {
        return getDB().collection<MongoDbTypes.ClusterMember>(
            "cluster_members"
        );
    }

    export async function addLiteNode(node: MongoDbTypes.LiteNode) {
        const collection = getLiteNodeCollection();
        await collection.insertOne(node);
    }

    export async function addBobNode(node: MongoDbTypes.BobNode) {
        const collection = getBobNodeCollection();
        await collection.insertOne(node);
    }

    export async function removeLiteNode(server: string) {
        const collection = getLiteNodeCollection();
        await collection.deleteOne({ server });
    }

    export async function removeBobNode(server: string) {
        const collection = getBobNodeCollection();
        await collection.deleteOne({ server });
    }

    export async function tryLogin(
        username: string,
        passwordHash: string
    ): Promise<MongoDbTypes.User | null> {
        const collection = getUsersCollection();
        const user = await collection.findOne({ username, passwordHash });
        return user || null;
    }

    export async function createUser(user: MongoDbTypes.User): Promise<void> {
        const collection = getUsersCollection();
        await collection.insertOne(user);
    }

    export async function getLiteNodes() {
        const collection = getLiteNodeCollection();
        return await collection.find({}).toArray();
    }

    export async function getBobNodes() {
        const collection = getBobNodeCollection();
        return await collection.find({}).toArray();
    }
}
