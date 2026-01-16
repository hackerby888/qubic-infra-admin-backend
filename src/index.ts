import "dotenv/config";
import { GithubService } from "./services/github-service.js";
import { HttpServer } from "./http/http-server.js";
import { NodeService } from "./services/node-service.js";
import { Mongodb } from "./database/db.js";
import { SocketServer } from "./http/socket-server.js";
import { MapService } from "./services/map-service.js";
import { lastCheckinMap } from "./utils/common.js";
import fs from "fs/promises";
import { logger } from "./utils/logger.js";

const LAST_CHECKIN_MAP_FILE = `${process.cwd()}/data/lastCheckinMap.json`;

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
    ];

    requiredVars.forEach((varName) => {
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
    // load lastCheckinMap from file
    try {
        const data = await fs.readFile(LAST_CHECKIN_MAP_FILE, "utf-8");
        const parsedMap: Record<string, number> = JSON.parse(data);
        Object.assign(lastCheckinMap, parsedMap);
        logger.info("💾 lastCheckinMap loaded.");
    } catch (err) {
        logger.info("No existing lastCheckinMap found, starting fresh.");
    }
}

// catch when crash/shutdown/restart
process.on("SIGINT", async () => {
    try {
        await fs.writeFile(
            LAST_CHECKIN_MAP_FILE,
            JSON.stringify(lastCheckinMap, null, 2)
        );
        logger.info("💾 lastCheckinMap saved.");
    } catch (err: any) {
        logger.error("❌ Error saving lastCheckinMap:", err.message);
    }
    logger.info("👋 Shutting down...");
    process.exit(0);
});

async function main() {
    await dataSetup();
    checkEnvVariables();
    await Mongodb.connectDB();
    await MapService.start();
    await GithubService.start();
    await NodeService.start();
    const server = await HttpServer.start();
    SocketServer.start(server);
}

main();
