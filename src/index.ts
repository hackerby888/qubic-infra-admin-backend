import "dotenv/config";
import { GithubService } from "./services/github-service.js";
import { HttpServer } from "./http/http-server.js";
import { NodeService } from "./services/node-service.js";
import { Mongodb, IS_NO_DB } from "./database/db.js";
import { SocketServer } from "./http/socket-server.js";
import { MapService } from "./services/map-service.js";
import { LeaderService } from "./services/leader-service.js";
import fs from "fs/promises";
import { logger } from "./utils/logger.js";
import { Gmail } from "./utils/gmail.js";

function checkEnvVariables() {
    const requiredVars = [
        "GITHUB_LITE_NODE_USER",
        "GITHUB_LITE_NODE_REPO",
        "GITHUB_BOB_NODE_USER",
        "GITHUB_BOB_NODE_REPO",
        "GITHUB_TOKEN",
        "JWT_SECRET",
        "PORT",
        "MONGO_URI",
        "MONGO_DB_NAME",
        "GMAIL_USER",
        "GMAIL_APP_PASSWORD",
        "ALERT_EMAIL_RECIPIENTS",
    ];

    const filtered = IS_NO_DB
        ? requiredVars.filter(
              (v) => v !== "MONGO_URI" && v !== "MONGO_DB_NAME"
          )
        : requiredVars;

    filtered.forEach((varName) => {
        if (!process.env[varName]) {
            console.error(
                `Error: Missing required environment variable ${varName}`
            );
            process.exit(1);
        }
    });
}

async function dataSetup() {
    const dir = `${process.cwd()}/data`;
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (err: any) {
        logger.error("❌ Error creating data directory:", err.message);
    }
    // Checkin rate-limit state now lives in Mongo (TTL collection) so it's
    // shared across instances; no file to load. NO_DB uses an in-memory map.
}

let shuttingDown = false;
async function handleShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    // Release leadership first so a standby takes over within a renew tick.
    await LeaderService.resign();
    try {
        await Promise.race([
            Gmail.sendServerStoppedEmail({ reason: signal }),
            new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
    } catch (err: any) {
        logger.error("📧 Failed to send shutdown email:", err.message);
    }
    logger.info(`👋 Shutting down (${signal})...`);
    process.exit(0);
}

// catch when crash/shutdown/restart
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

async function main() {
    await dataSetup();
    checkEnvVariables();
    await Mongodb.connectDB();
    await LeaderService.start();
    // Don't block boot on SMTP — production firewalls may block egress.
    Gmail.verify().catch(() => {});
    await MapService.start();
    await GithubService.start();
    await NodeService.start();
    const server = await HttpServer.start();
    SocketServer.start(server);
    Gmail.sendServerStartedEmail({
        port: process.env.PORT || "unknown",
    }).catch(() => {});
}

main();
