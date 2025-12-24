import "dotenv/config";
import { GithubService } from "./services/github-service.js";
import { HttpServer } from "./http/http-server.js";
import { NodeService } from "./services/node-service.js";
import { Mongodb } from "./database/db.js";
import { SocketServer } from "./http/socket-server.js";
import { MapService } from "./services/map-service.js";

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

async function main() {
    checkEnvVariables();
    await Mongodb.connectDB();
    await MapService.start();
    await GithubService.start();
    await NodeService.start();
    const server = await HttpServer.start();
    SocketServer.start(server);
}

main();
