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

        logger.info("🔌 Connecting to MongoDB...");
        client = new MongoClient(uri);
        await client.connect();

        db = client.db(dbName);
        logger.info("🔌 Connected to MongoDB");

        // Setup indexes
        await getLiteNodeCollection().createIndex(
            { server: 1 },
            { unique: true }
        );
        await getBobNodeCollection().createIndex(
            { server: 1 },
            { unique: true }
        );
        await getUsersCollection().createIndex(
            { username: 1 },
            { unique: true }
        );
        await getServersCollection().createIndex(
            { server: 1 },
            { unique: true }
        );
        await getBlacklistedPeersCollection().createIndex(
            { ip: 1 },
            { unique: true }
        );
        return db;
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
