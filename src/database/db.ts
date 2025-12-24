import { MongoClient, Db } from "mongodb";
import { logger } from "../utils/logger.js";
import type { IpInfo } from "../utils/ip.js";

const uri = process.env.MONGO_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGO_DB_NAME || "qubic_nodes";

let client: MongoClient;
let db: Db;

export namespace MongoDbTypes {
    export type NodeStatus =
        | "setting_up"
        | "active"
        | "error"
        | "stopped"
        | "restarting";
    export type CommandStatus = "pending" | "completed" | "failed";

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
    }

    export enum ServiceType {
        LiteNode = "liteNode",
        BobNode = "bobNode",
        null = "null",
    }

    export interface Server {
        server: string;
        ipInfo?: IpInfo;
        alias?: string;
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
    }

    export interface User {
        username: string;
        passwordHash: string;
        role: "admin" | "operator";
        currentsshPrivateKey?: string;
        insertedAt: number;
    }
}

export namespace Mongodb {
    const LITE_NODE_COLLECTION = "lite_nodes";
    const BOB_NODE_COLLECTION = "bob_nodes";

    export async function connectDB(): Promise<Db> {
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
        return db;
    }

    export async function disconnectDB() {
        if (client) {
            await client.close();
            console.log("🔌 Disconnected from MongoDB");
        }
    }

    export function getDB(): Db {
        if (!db) {
            throw new Error("Database not connected. Call connectDB first.");
        }
        return db;
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
