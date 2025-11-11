import "dotenv/config";
import { GithubService } from "./services/github-service.js";
import { HttpServer } from "./http/http-server.js";
import { NodeService } from "./services/node-service.js";
import { Mongodb } from "./database/db.js";
import { SSHService } from "./services/ssh-service.js";
import fs from "fs";

function checkEnvVariables() {
    const requiredVars = [
        "GITHUB_USER",
        "GITHUB_REPO",
        "GITHUB_TOKEN",
        "JWT_SECRET",
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
    // let out = await SSHService.setupNode(
    //     "194.34.238.128",
    //     "root",
    //     fs.readFileSync("/home/kali/.ssh/id_ed25519", "utf-8"),
    //     "lite"
    // );
    // console.log(out);
    // console.log(SSHService.getSetupCommands("lite"));
    checkEnvVariables();
    await Mongodb.connectDB();
    await GithubService.start();
    await NodeService.start();
    await HttpServer.start();
}

main();
