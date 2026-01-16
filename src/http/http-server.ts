import express from "express";
import cors from "cors";
import { GithubService } from "../services/github-service.js";
import { NodeService } from "../services/node-service.js";
import { logger } from "../utils/logger.js";
import jwt from "jsonwebtoken";
import { Mongodb, MongoDbTypes } from "../database/db.js";
import { SSHService } from "../services/ssh-service.js";
import {
    checkLink,
    lastCheckinMap,
    mongodbOperatorSelection,
} from "../utils/common.js";
import { v4 as uuidv4 } from "uuid";
import { getLastWednesdayTimestamp, millisToSeconds } from "../utils/time.js";
import { lookupIp, type IpInfo } from "../utils/ip.js";
import { calcGroupIdFromIds } from "../utils/node.js";
import { hashSHA256 } from "../utils/crypto.js";
import { MapService } from "../services/map-service.js";
import fs from "fs";
import https from "https";

declare global {
    namespace Express {
        interface Request {
            user?: {
                username?: string;
                role?: string;
            };
        }
    }
}

namespace MiddleWare {
    // Middleware to verify JWT token
    export function authenticateToken(
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
    ) {
        const authHeader = req.headers["authorization"];
        const token = authHeader && authHeader.split(" ")[1];

        if (!token) {
            return res.status(401).json({ error: "Missing token" });
        }

        jwt.verify(
            token,
            process.env.JWT_SECRET as string,
            (err, user: any) => {
                if (err) {
                    return res.status(403).json({ error: "Invalid token" });
                }
                req.user = user;
                next();
            }
        );
    }
}

namespace HttpServer {
    export async function start() {
        const app = express();
        app.use(express.json());
        app.use(cors());
        const port = process.env.PORT || 3000;

        app.get("/", (req, res) => {
            res.send("Qubic iz da bes’, homie!");
        });

        app.get("/servers", (req, res) => {
            let servers: string[] =
                GithubService.getVariable("SERVERS").split(" ");
            for (let i = 0; i < servers.length; i++) {
                if (!servers[i]) continue;

                servers[i] = servers[i]!.trim().split("@")[1] as string;
            }

            res.json({ servers });
        });

        app.get("/servers-status", async (req, res) => {
            let operator = req.query.operator as string | undefined;
            let needPlainIp = req.query.plainIp === "true";
            let needAll = req.query.all === "true";
            let statuses = NodeService.getStatus();

            if (needPlainIp) {
                let token = req.headers["authorization"]?.split(" ")[1];
                // verify token
                if (!token) {
                    return res.status(401).json({ error: "Missing token" });
                }
                try {
                    jwt.verify(token, process.env.JWT_SECRET as string);
                } catch (err) {
                    return res.status(403).json({ error: "Invalid token" });
                }
            }

            if (operator && !needAll) {
                // Filter statuses by operator
                statuses.liteNodes = statuses.liteNodes.filter(
                    (status) => status.operator === operator
                );
                statuses.bobNodes = statuses.bobNodes.filter(
                    (status) => status.operator === operator
                );
            }

            let liteNodesServer: string[] = statuses.liteNodes.map(
                (node) => node.server
            );
            let bobNodesServer: string[] = statuses.bobNodes.map(
                (node) => node.server
            );

            let liteNodesFromDb = await Mongodb.getLiteNodeCollection()
                .find({ server: { $in: liteNodesServer } })
                .toArray();
            let bobNodesFromDb = await Mongodb.getBobNodeCollection()
                .find({ server: { $in: bobNodesServer } })
                .toArray();

            // If no operator is provided, filter out private nodes
            if (!operator) {
                // Only return if isPrivate is false
                statuses.liteNodes = statuses.liteNodes.filter((status) => {
                    let nodeDoc = liteNodesFromDb.find(
                        (node) => node.server === status.server
                    );
                    return nodeDoc ? !nodeDoc.isPrivate : true;
                });

                statuses.bobNodes = statuses.bobNodes.filter((status) => {
                    let nodeDoc = bobNodesFromDb.find(
                        (node) => node.server === status.server
                    );
                    return nodeDoc ? !nodeDoc.isPrivate : true;
                });
            }

            let serverHash: Record<string, string> = {};
            for (let status of statuses.liteNodes) {
                if (!serverHash[status.server]) {
                    serverHash[status.server] = !needPlainIp
                        ? await hashSHA256(status.server)
                        : status.server;
                }
            }
            for (let status of statuses.bobNodes) {
                if (!serverHash[status.server]) {
                    serverHash[status.server] = !needPlainIp
                        ? await hashSHA256(status.server)
                        : status.server;
                }
            }

            statuses.liteNodes = statuses.liteNodes.map((status) => {
                let nodeDoc = liteNodesFromDb.find(
                    (node) => node.server === status.server
                );
                return {
                    ...status,
                    isPrivate: nodeDoc ? nodeDoc.isPrivate : false,
                    server: serverHash[status.server] as string,
                };
            });
            statuses.bobNodes = statuses.bobNodes.map((status) => {
                let nodeDoc = bobNodesFromDb.find(
                    (node) => node.server === status.server
                );
                return {
                    ...status,
                    isPrivate: nodeDoc ? nodeDoc.isPrivate : false,
                    server: serverHash[status.server] as string,
                };
            });

            res.json({ ...statuses });
        });

        app.post(
            "/change-visibility",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let server: string = req.body.server;
                    let service: MongoDbTypes.ServiceType = req.body.service;
                    let isPrivate: boolean = req.body.isPrivate;
                    let operator = req.user!.username;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!server) {
                        res.status(400).json({ error: "Missing server" });
                        return;
                    }
                    if (service === MongoDbTypes.ServiceType.LiteNode) {
                        await Mongodb.getLiteNodeCollection().updateOne(
                            { server: server },
                            { $set: { isPrivate: !!isPrivate } }
                        );
                    } else if (service === MongoDbTypes.ServiceType.BobNode) {
                        await Mongodb.getBobNodeCollection().updateOne(
                            { server: server },
                            { $set: { isPrivate: !!isPrivate } }
                        );
                    } else {
                        res.status(400).json({ error: "Invalid service type" });
                        return;
                    }
                    res.json({ message: "Visibility updated successfully" });
                } catch (error) {
                    logger.error(
                        `Error changing visibility: ${(error as Error).message}`
                    );
                    res.status(500).json({ error: "Internal server error" });
                }
            }
        );

        app.get("/request-shudown", async (req, res) => {
            let server = req.query.server as string;
            if (!server) {
                res.status(400).json({
                    error: "Missing 'server' query parameter",
                });
                return;
            }

            let ok = await NodeService.requestShudownLiteNode(server);
            if (ok) {
                res.json({ message: `Shutdown request sent to ${server}` });
            } else {
                res.status(500).json({
                    error: `Failed to send shutdown request to ${server}`,
                });
            }
        });

        app.get("/request-shutdown-all", async (req, res) => {
            let result = await NodeService.requestShutdownAllLiteNodes();
            res.json(result);
        });

        app.post("/command", MiddleWare.authenticateToken, async (req, res) => {
            try {
                let command: "shutdown" | "restart" = req.body.command;
                let services: MongoDbTypes.ServiceType[] = req.body.services;
                let servers: string[] = req.body.servers;

                let operator = req.user!.username;
                if (!operator) {
                    res.status(400).json({ error: "No operator found" });
                    return;
                }

                // Get server details from DB
                let serverDocs = (
                    await Mongodb.getServersCollection()
                        .find({ server: { $in: servers } })
                        .toArray()
                ).filter((s) => s.username && s.username.length > 0);

                if (servers.length === 0) {
                    res.status(404).json({
                        error: "No matching servers found in the database",
                    });
                    return;
                }

                let currentUUID = uuidv4();
                await Mongodb.getCommandLogsCollection().insertOne({
                    operator: operator,
                    servers: servers,
                    command: `${command}:${services.join(", ").toLowerCase()}`,
                    stdout: "",
                    stderr: "",
                    timestamp: Date.now(),
                    status: "pending",
                    uuid: currentUUID,
                    isStandardCommand: true,
                    duration: 0,
                });

                const updateCommandLogToDb = ({
                    stdout,
                    stderr,
                    status,
                    duration,
                }: {
                    stdout: string;
                    stderr: string;
                    status: "pending" | "completed" | "failed";
                    duration: number;
                }) => {
                    Mongodb.getCommandLogsCollection()
                        .updateOne(
                            {
                                uuid: currentUUID,
                            },
                            {
                                $set: {
                                    stdout: stdout,
                                    stderr: stderr,
                                    status: status,
                                },
                                $inc: {
                                    duration: duration,
                                },
                            }
                        )
                        .then()
                        .catch((error) => {
                            logger.error(
                                `Error updating command log: ${
                                    (error as Error).message
                                }`
                            );
                        });
                };

                const updateNodeDeloyStatusToDb = ({
                    server,
                    service,
                    status,
                }: {
                    server: string;
                    service: MongoDbTypes.ServiceType;
                    status: MongoDbTypes.NodeStatus;
                }) => {
                    Mongodb.getServersCollection()
                        .updateOne({ server: server }, [
                            {
                                $set: {
                                    deployStatus: {
                                        $mergeObjects: [
                                            "$deployStatus",
                                            { [service]: status },
                                        ],
                                    },
                                },
                            },
                        ])
                        .then()
                        .catch(() => {});
                };

                let currentStdout = "";
                let currentStderr = "";
                let totalCommandsExecuted = 0;
                const totalCommandsToExecute =
                    services.length * serverDocs.length;

                if (command == "shutdown") {
                    for (let service of services) {
                        for (let serverObject of serverDocs) {
                            if (!serverObject.services.includes(service)) {
                                totalCommandsExecuted++;
                                continue;
                            }
                            SSHService.shutdownNode(
                                serverObject.server,
                                serverObject.username,
                                serverObject.password,
                                serverObject.sshPrivateKey,
                                service
                            )
                                .then(
                                    async ({
                                        stdouts,
                                        stderrs,
                                        isSuccess,
                                        duration,
                                    }) => {
                                        totalCommandsExecuted++;
                                        if (isSuccess) {
                                            currentStdout +=
                                                "\n" +
                                                `---------- Shutdown log for ${service} on ${serverObject.server} ----------- \n\n`;
                                            currentStdout += "Okay\n";
                                            currentStderr +=
                                                Object.values(stderrs).join(
                                                    "\n"
                                                );
                                            updateCommandLogToDb({
                                                stdout: currentStdout,
                                                stderr: currentStderr,
                                                status:
                                                    totalCommandsExecuted ===
                                                    totalCommandsToExecute
                                                        ? "completed"
                                                        : "pending",
                                                duration: duration,
                                            });
                                            updateNodeDeloyStatusToDb({
                                                server: serverObject.server,
                                                service: service,
                                                status: "stopped",
                                            });
                                        } else {
                                            updateCommandLogToDb({
                                                stdout: Object.values(
                                                    stdouts
                                                ).join("\n"),
                                                stderr: Object.values(
                                                    stderrs
                                                ).join("\n"),
                                                status: "failed",
                                                duration: duration,
                                            });
                                            updateNodeDeloyStatusToDb({
                                                server: serverObject.server,
                                                service: service,
                                                status: "error",
                                            });
                                        }
                                    }
                                )
                                .catch((error) => {
                                    updateCommandLogToDb({
                                        stdout: (error as Error).message,
                                        stderr: (error as Error).message,
                                        status: "failed",
                                        duration: 0,
                                    });
                                    updateNodeDeloyStatusToDb({
                                        server: serverObject.server,
                                        service: service,
                                        status: "error",
                                    });
                                });
                        }
                    }
                } else if (command == "restart") {
                    for (let service of services) {
                        for (let serverObject of serverDocs) {
                            if (!serverObject.services.includes(service)) {
                                totalCommandsExecuted++;
                                continue;
                            }
                            updateNodeDeloyStatusToDb({
                                server: serverObject.server,
                                service: service,
                                status: "restarting",
                            });
                            SSHService.restartNode(
                                serverObject.server,
                                serverObject.username,
                                serverObject.password,
                                serverObject.sshPrivateKey,
                                service,
                                {
                                    systemRamInGB: parseInt(
                                        serverObject.ram || "0"
                                    ),
                                }
                            )
                                .then(
                                    async ({
                                        stdouts,
                                        stderrs,
                                        isSuccess,
                                        duration,
                                    }) => {
                                        totalCommandsExecuted++;
                                        currentStderr +=
                                            Object.values(stderrs).join("\n");
                                        if (isSuccess) {
                                            currentStdout +=
                                                "\n" +
                                                `---------- Restart log for ${service} on ${serverObject.server} ----------- \n\n`;
                                            currentStdout += "Okay\n";
                                            updateCommandLogToDb({
                                                stdout: currentStdout,
                                                stderr: currentStderr,
                                                status:
                                                    totalCommandsExecuted ===
                                                    totalCommandsToExecute
                                                        ? "completed"
                                                        : "pending",
                                                duration: duration,
                                            });
                                            updateNodeDeloyStatusToDb({
                                                server: serverObject.server,
                                                service: service,
                                                status: "active",
                                            });
                                        } else {
                                            currentStdout +=
                                                "\n" +
                                                `---------- Restart log for ${service} on ${serverObject.server} ----------- \n\n`;
                                            currentStdout +=
                                                Object.values(stdouts).join(
                                                    "\n"
                                                );
                                            updateCommandLogToDb({
                                                stdout: currentStdout,
                                                stderr: currentStderr,
                                                status: "failed",
                                                duration: duration,
                                            });
                                            updateNodeDeloyStatusToDb({
                                                server: serverObject.server,
                                                service: service,
                                                status: "error",
                                            });
                                        }
                                    }
                                )
                                .catch((error) => {
                                    updateCommandLogToDb({
                                        stdout: (error as Error).message,
                                        stderr: (error as Error).message,
                                        status: "failed",
                                        duration: 0,
                                    });
                                    updateNodeDeloyStatusToDb({
                                        server: serverObject.server,
                                        service: service,
                                        status: "error",
                                    });
                                });
                        }
                    }
                } else {
                    res.status(400).json({ error: "Invalid command" });
                    return;
                }

                res.json({ message: "Command sent successfully" });
            } catch (error) {
                res.status(500).json({
                    error: "Internal server error: " + (error as Error).message,
                });
            }
        });

        app.get("/github-tags", (req, res) => {
            let service = req.query.service as MongoDbTypes.ServiceType;
            if (!service) {
                res.json({
                    error: "Invalid service",
                });
                return;
            }
            let tags = GithubService.getGithubTags(service);
            res.json(tags);
        });

        app.post("/deploy", MiddleWare.authenticateToken, async (req, res) => {
            let servers: string[] = req.body.servers;
            let service: MongoDbTypes.ServiceType = req.body.service;
            let tag: string = req.body.tag;
            let operator: string | undefined = req.user?.username;
            let extraData: {
                epochFile?: string;
                peers?: string[];
                mainAuxStatus: number;
                ids: string[];
                ramMode: string;
                bobConfig: object | undefined;
                loggingPasscode: string;
                operatorId: string;
                keydbConfig?: string[];
                kvrocksConfig?: string[];
                keepOldConfig?: boolean;
            } = req.body.extraData;

            let binaryFileMap = {
                liteNode: "Qubic",
                bobNode: "bob",
            };

            if (!operator) {
                res.status(400).json({
                    error: "No operator found",
                });
                return;
            }

            let binaryUrl: string = "";
            try {
                if (
                    GithubService.getGithubTags(service)?.findIndex(
                        (t) => t.name.trim() === tag.trim()
                    ) === -1
                ) {
                    if (tag.startsWith("http")) {
                        binaryUrl = tag;
                    } else {
                        throw new Error("Tag not found in GitHub releases");
                    }
                } else {
                    binaryUrl = GithubService.getDownloadUrlForTag(
                        tag,
                        binaryFileMap[service as keyof typeof binaryFileMap],
                        service
                    );
                }
            } catch (error) {
                res.status(400).json({
                    error: (error as Error).message,
                });
            }
            // Validate input
            if (!servers || !Array.isArray(servers) || servers.length === 0) {
                res.status(400).json({
                    error: "Invalid or missing 'servers' in request body",
                });
                return;
            }
            if (
                !service ||
                !Object.values(MongoDbTypes.ServiceType).includes(service)
            ) {
                res.status(400).json({
                    error: "Invalid or missing 'service' in request body",
                });
                return;
            }
            if (!binaryUrl || typeof binaryUrl !== "string") {
                res.status(400).json({
                    error: "Invalid or missing 'binaryUrl' in request body",
                });
                return;
            }
            if (service === MongoDbTypes.ServiceType.LiteNode) {
                if (!extraData.epochFile || !extraData.peers) {
                    res.status(400).json({
                        error: "Missing 'epochFile' or 'peers' in extraData for deployment",
                    });
                    return;
                }

                let isEpochFileValid = await checkLink(extraData.epochFile);
                if (!isEpochFileValid) {
                    res.status(400).json({
                        error: "The provided 'epochFile' URL is not accessible",
                    });
                    return;
                }
            }

            if (extraData.loggingPasscode) {
                // check logging passcode format
                let passcodeParts = extraData.loggingPasscode.split("-");
                if (passcodeParts.length !== 4) {
                    res.status(400).json({
                        error: "Logging passcode must have 4 parts separated by '-'",
                    });
                } else if (
                    passcodeParts.some((part) => {
                        let num = Number(part);
                        return isNaN(num);
                    })
                ) {
                    res.status(400).json({
                        error: "Each part of the logging passcode must be a valid number",
                    });
                }
            }

            if (extraData.operatorId) {
                if (extraData.operatorId.length !== 60) {
                    res.status(400).json({
                        error: "Operator ID must be exactly 60 characters",
                    });
                }
            }

            // Get server details from DB
            let serverDocs: MongoDbTypes.Server[] = [];
            try {
                serverDocs = (
                    await Mongodb.getServersCollection()
                        .find({ server: { $in: servers } })
                        .toArray()
                ).filter((s) => s.username && s.username.length > 0);

                if (serverDocs.length === 0) {
                    res.status(404).json({
                        error: "No matching servers found in the database",
                    });
                    return;
                }

                for (let server of serverDocs) {
                    if (server.status !== "active") {
                        res.status(400).json({
                            error: `Server ${server.server} is not active, please exclude it from deployment.`,
                        });
                        return;
                    }
                }
            } catch (error) {
                res.status(500).json({
                    error: "Failed to fetch servers from database " + error,
                });
                return;
            }

            const databaseUpdater = ({
                server,
                service,
                stdout,
                stderr,
                status,
            }: {
                server: string;
                service: MongoDbTypes.ServiceType;
                stdout: string;
                stderr: string;
                status: "pending" | "active" | "error";
            }) => {
                Mongodb.getServersCollection()
                    .updateOne({ server: server }, [
                        {
                            $set: {
                                deployStatus: {
                                    $mergeObjects: [
                                        "$deployStatus",
                                        { [service]: status },
                                    ],
                                },
                                deployLogs: {
                                    $mergeObjects: [
                                        "$deployLogs",
                                        {
                                            [service]: {
                                                stdout: stdout,
                                                stderr: stderr,
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    ])
                    .then()
                    .catch(() => {});
            };

            let isAutoP2P =
                extraData.peers && extraData.peers[0] === "auto_p2p";

            // map ip to list of p2p peers
            let p2pMap: Record<string, string[]> = {};
            if (isAutoP2P) {
                let baremetalNodes = extraData.peers?.slice(1);
                if (!baremetalNodes || baremetalNodes.length === 0) {
                    res.status(400).json({
                        error: "No baremetal nodes specified for P2P connections.",
                    });
                    return;
                }
                let connectedNodes = [];
                // first randomly choose 4 seed nodes (which connect to baremetal) and add to p2p map
                let seedNodes = serverDocs
                    .sort(() => 0.5 - Math.random())
                    .slice(0, 4);
                for (let seedNode of seedNodes) {
                    p2pMap[seedNode.server] = baremetalNodes as string[];
                    connectedNodes.push(seedNode.server);
                }
                // for the rest of the nodes, randomly choose 3 from waiting and 1 from connected nodes
                for (let serverNode of serverDocs) {
                    if (connectedNodes.includes(serverNode.server)) continue;

                    let peersForNode = [];
                    let waitingNodes = serverDocs.filter(
                        (node) =>
                            !connectedNodes.includes(node.server) &&
                            node.server !== serverNode.server
                    );
                    // choose 3 from waiting nodes
                    let waitingChoices = waitingNodes
                        .sort(() => 0.5 - Math.random())
                        .slice(0, 3);

                    // if not enough waiting nodes, fill from connected nodes
                    if (waitingChoices.length < 3) {
                        let needed = 3 - waitingChoices.length;
                        let extraConnected = connectedNodes
                            .sort(() => 0.5 - Math.random())
                            .slice(0, needed);
                        for (let extra of extraConnected) {
                            peersForNode.push(extra);
                        }
                    }
                    for (let choice of waitingChoices) {
                        peersForNode.push(choice.server);
                    }
                    // choose 1 from connected nodes
                    if (connectedNodes.length > 0) {
                        let connectedChoice = connectedNodes.sort(
                            () => 0.5 - Math.random()
                        )[0];
                        peersForNode.push(connectedChoice);
                    }
                    p2pMap[serverNode.server] = peersForNode as string[];
                    connectedNodes.push(serverNode.server);
                }
            }

            // Deploy to each server
            try {
                for (let server of serverDocs) {
                    if (!server.services.includes(service)) continue;
                    if (!server.username) continue;
                    SSHService.deployNode(
                        server.server,
                        server!.username,
                        server!.password,
                        server.sshPrivateKey,
                        service,
                        {
                            binaryUrl,
                            epochFile: extraData?.epochFile as string,
                            peers:
                                p2pMap[server.server] ||
                                (extraData?.peers as string[]) ||
                                [],
                            systemRamInGB: parseInt(server.ram || "0"),
                            mainAuxStatus: extraData.mainAuxStatus,
                            ids: extraData.ids,
                            ramMode: extraData.ramMode,
                            bobConfig: extraData.bobConfig || {},
                            loggingPasscode: extraData.loggingPasscode,
                            operatorId: extraData.operatorId,
                            keydbConfig: extraData.keydbConfig || [],
                            kvrocksConfig: extraData.kvrocksConfig || [],
                            keepOldConfig: extraData.keepOldConfig || false,
                        }
                    )
                        .then((result) => {
                            if (result.isSuccess) {
                                databaseUpdater({
                                    server: server.server,
                                    service: service,
                                    stdout:
                                        `---------- Time elapsed ${millisToSeconds(
                                            result.duration
                                        )} seconds ----------- \n\n` +
                                        Object.values(result.stdouts).join(
                                            "\n"
                                        ),
                                    stderr: Object.values(result.stderrs).join(
                                        "\n"
                                    ),
                                    status: "active",
                                });

                                Mongodb.getLiteNodeCollection()
                                    .updateOne(
                                        {
                                            server: server.server,
                                        },
                                        {
                                            $set: {
                                                passcode:
                                                    extraData.loggingPasscode,
                                            },
                                        }
                                    )
                                    .then()
                                    .catch(() => {});

                                NodeService.tryGetIdsFromLiteNode(
                                    server.server
                                ).then((ids) => {
                                    let groupId = calcGroupIdFromIds(ids);
                                    Mongodb.getLiteNodeCollection()
                                        .updateOne(
                                            {
                                                server: server.server,
                                            },
                                            {
                                                $set: {
                                                    ids: ids,
                                                    groupId: groupId,
                                                },
                                            }
                                        )
                                        .then()
                                        .catch(() => {});
                                });
                            } else {
                                databaseUpdater({
                                    server: server.server,
                                    service: service,
                                    stdout:
                                        `---------- Time elapsed ${millisToSeconds(
                                            result.duration
                                        )} seconds ----------- \n` +
                                        Object.values(result.stdouts).join(
                                            "\n"
                                        ),
                                    stderr: Object.values(result.stderrs).join(
                                        "\n"
                                    ),
                                    status: "error",
                                });
                            }
                        })
                        .catch((error) => {
                            logger.error(
                                `Deployment to ${server} failed: ${
                                    (error as Error).message
                                }`
                            );
                            databaseUpdater({
                                server: server.server,
                                service: service,
                                stdout: (error as Error).message,
                                stderr: (error as Error).message,
                                status: "error",
                            });
                        });
                }
            } catch (error) {
                res.status(500).json({
                    error: "Failed to deploy: " + (error as Error).message,
                });
            }

            res.json({ message: "Deployment initiated" });
        });

        app.post("/login", async (req, res) => {
            try {
                const { username, passwordHash } = req.body;
                if (!username || !passwordHash) {
                    res.status(400).json({
                        error: "Missing username or passwordHash",
                    });
                    return;
                }

                const user = await Mongodb.tryLogin(username, passwordHash);
                if (!user) {
                    res.status(401).json({ error: "Invalid credentials" });
                    return;
                }

                const token = jwt.sign(
                    { username: user.username, role: user.role },
                    process.env.JWT_SECRET as string
                );
                res.json({ token });
            } catch (error) {
                logger.error(`Login error: ${(error as Error).message}`);
                res.status(500).json({ error: "Internal server error" });
                return;
            }
        });

        app.get(
            "/operators",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    // check if admin
                    if (!req.user || req.user.role !== "admin") {
                        res.status(403).json({
                            error: "Admin privileges required",
                        });
                        return;
                    }
                    const operators = await Mongodb.getUsersCollection()
                        .find({})
                        .project({ _id: 0, passwordHash: 0 })
                        .toArray();
                    res.json({ operators });
                } catch (error) {
                    logger.error(
                        `Fetch operators error: ${(error as Error).message}`
                    );
                    res.status(500).json({ error: "Internal server error" });
                    return;
                }
            }
        );

        app.delete(
            "/operators",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    if (!req.user || req.user.role !== "admin") {
                        res.status(403).json({
                            error: "Admin privileges required",
                        });
                        return;
                    }
                    const { username } = req.body;
                    if (!username) {
                        res.status(400).json({
                            error: "Missing username",
                        });
                        return;
                    }
                    await Mongodb.getUsersCollection().deleteOne({
                        username,
                    });
                    res.json({ message: "User deleted successfully" });
                } catch (error) {
                    logger.error(
                        `Delete operator error: ${(error as Error).message}`
                    );
                    res.status(500).json({ error: "Internal server error" });
                    return;
                }
            }
        );

        app.post(
            "/operators",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    if (!req.user || req.user.role !== "admin") {
                        res.status(403).json({
                            error: "Admin privileges required",
                        });
                        return;
                    }
                    const { username, passwordHash, role } = req.body;
                    if (!username || !passwordHash || !role) {
                        res.status(400).json({
                            error: "Missing username, passwordHash, or role",
                        });
                        return;
                    }

                    await Mongodb.createUser({
                        username,
                        passwordHash,
                        role,
                        insertedAt: Date.now(),
                    });
                    res.json({ message: "User registered successfully" });
                } catch (error) {
                    logger.error(
                        `Registration error: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error:
                            "Internal server error: " +
                            (error as Error).message,
                    });
                    return;
                }
            }
        );

        app.post(
            "/set-server-alias",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let { server, alias } = req.body;
                    let operator = req.user?.username;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    await Mongodb.getServersCollection().updateOne(
                        { server: server },
                        { $set: { alias: alias } }
                    );
                    res.json({ message: "Alias updated successfully" });
                } catch (error) {
                    logger.error(
                        `Error setting server alias: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Internal server error" + error,
                    });
                }
            }
        );

        app.post(
            "/new-servers",
            MiddleWare.authenticateToken,
            async (req, res) => {
                let body: {
                    servers: {
                        ip: string;
                        username: string;
                        password: string;
                        services: {
                            liteNode: boolean;
                            bobNode: boolean;
                        };
                    }[];
                    authType: "password" | "sshKey" | "tracking";
                } = req.body;
                let { servers: serversData, authType } = body;
                let operator = req.user?.username;
                if (!operator) {
                    res.status(400).json({
                        error: "No operator found",
                    });
                    return;
                }

                let ipInfos: {
                    [key: string]: IpInfo;
                } = {};

                for (let server of serversData) {
                    ipInfos[server.ip] = await lookupIp(server.ip);
                }

                let userSshKey = "";
                try {
                    // Obtain current user ssh key if auth type is sshKey
                    if (authType === "sshKey") {
                        let userDoc =
                            await Mongodb.getUsersCollection().findOne({
                                username: operator,
                            });
                        if (userDoc && userDoc?.currentsshPrivateKey) {
                            userSshKey = userDoc.currentsshPrivateKey;
                        } else {
                            res.status(400).json({
                                error: "No SSH key found for user",
                            });
                            return;
                        }
                    }
                } catch (error) {
                    res.json({
                        error: "Error fetching user ssh key " + error,
                    });
                    return;
                }

                let serversDataNormalized: MongoDbTypes.Server[] =
                    serversData.map((server) => {
                        return {
                            server: server.ip,
                            ipInfo: ipInfos[server.ip]!,
                            operator: operator as string,
                            sshPrivateKey: userSshKey,
                            username: server.username,
                            password: server.password,
                            services: [
                                server.services.liteNode
                                    ? MongoDbTypes.ServiceType.LiteNode
                                    : MongoDbTypes.ServiceType.null,
                                server.services.bobNode
                                    ? MongoDbTypes.ServiceType.BobNode
                                    : MongoDbTypes.ServiceType.null,
                            ].filter(
                                (s) => s !== "null"
                            ) as MongoDbTypes.ServiceType[],
                            status:
                                authType === "tracking"
                                    ? "active"
                                    : "setting_up",
                        };
                    });

                try {
                    let currentServers = await Mongodb.getServersCollection()
                        .find({})
                        .project({ _id: 0, server: 1 })
                        .toArray();

                    // Check if one of the servers already exists
                    for (let serverData of serversDataNormalized) {
                        if (
                            currentServers.find(
                                (s) => s.server === serverData.server
                            )
                        ) {
                            res.status(400).json({
                                error: `Server ${serverData.server} already exists`,
                            });
                            return;
                        }
                    }

                    // Insert new servers into DB
                    await Mongodb.getServersCollection().insertMany(
                        serversDataNormalized
                    );

                    if (authType !== "tracking") {
                        // Do set up for servers
                        for (let serverData of serversDataNormalized) {
                            SSHService.setupNode(
                                serverData.server,
                                serverData.username,
                                serverData.password,
                                serverData.sshPrivateKey
                            )
                                .then(async (result) => {
                                    if (result.isSuccess) {
                                        Mongodb.getServersCollection()
                                            .updateOne(
                                                { server: serverData.server },
                                                {
                                                    $set: {
                                                        cpu: result.cpu,
                                                        os: result.os,
                                                        ram: result.ram,
                                                        status: "active",
                                                        setupLogs: {
                                                            stdout:
                                                                `---------- Time elapsed ${millisToSeconds(
                                                                    result.duration
                                                                )} seconds ----------- \n\n` +
                                                                Object.values(
                                                                    result.stdouts
                                                                ).join("\n"),
                                                            stderr: Object.values(
                                                                result.stderrs
                                                            ).join("\n"),
                                                        },
                                                    },
                                                }
                                            )
                                            .then()
                                            .catch((_) => {});

                                        try {
                                            if (
                                                serverData.services.includes(
                                                    MongoDbTypes.ServiceType
                                                        .LiteNode
                                                )
                                            ) {
                                                await Mongodb.getLiteNodeCollection()
                                                    .insertOne({
                                                        server: serverData.server,
                                                        operator:
                                                            operator as string,
                                                        isPrivate: false,
                                                    })
                                                    .catch((_) => {});
                                            }

                                            if (
                                                serverData.services.includes(
                                                    MongoDbTypes.ServiceType
                                                        .BobNode
                                                )
                                            ) {
                                                await Mongodb.getBobNodeCollection()
                                                    .insertOne({
                                                        server: serverData.server,
                                                        operator:
                                                            operator as string,
                                                        isPrivate: false,
                                                    })
                                                    .catch((_) => {});
                                            }
                                            await NodeService.pullServerLists();
                                        } catch (error) {}
                                    } else {
                                        Mongodb.getServersCollection()
                                            .updateOne(
                                                { server: serverData.server },
                                                {
                                                    $set: {
                                                        status: "error",
                                                        setupLogs: {
                                                            stdout:
                                                                `---------- Time elapsed ${millisToSeconds(
                                                                    result.duration
                                                                )} seconds ----------- \n\n` +
                                                                Object.values(
                                                                    result.stdouts
                                                                ).join("\n"),
                                                            stderr:
                                                                `---------- Time elapsed ${millisToSeconds(
                                                                    result.duration
                                                                )} seconds ----------- \n\n` +
                                                                Object.values(
                                                                    result.stderrs
                                                                ).join("\n"),
                                                        },
                                                    },
                                                }
                                            )
                                            .then()
                                            .catch((_) => {});
                                    }
                                })
                                .catch((error) => {
                                    Mongodb.getServersCollection()
                                        .updateOne(
                                            { server: serverData.server },
                                            {
                                                $set: {
                                                    status: "error",
                                                    setupLogs: {
                                                        stdout: (error as Error)
                                                            .message,
                                                        stderr: (error as Error)
                                                            .message,
                                                    },
                                                },
                                            }
                                        )
                                        .then()
                                        .catch(() => {});
                                });
                        }
                    } else {
                        for (let serverData of serversDataNormalized) {
                            try {
                                if (
                                    serverData.services.includes(
                                        MongoDbTypes.ServiceType.LiteNode
                                    )
                                ) {
                                    await Mongodb.getLiteNodeCollection()
                                        .insertOne({
                                            server: serverData.server,
                                            operator: operator as string,
                                            isPrivate: false,
                                        })
                                        .catch((_) => {});
                                }

                                if (
                                    serverData.services.includes(
                                        MongoDbTypes.ServiceType.BobNode
                                    )
                                ) {
                                    await Mongodb.getBobNodeCollection()
                                        .insertOne({
                                            server: serverData.server,
                                            operator: operator as string,
                                            isPrivate: false,
                                        })
                                        .catch((_) => {});
                                }
                                await NodeService.pullServerLists();
                            } catch (error) {}
                        }
                    }
                } catch (error) {
                    logger.error(
                        `Error adding new servers: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to add new servers " + error,
                    });
                    return;
                }

                res.json({ message: "Servers added successfully" });
            }
        );

        app.get(
            "/my-servers",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }

                    let servers = await Mongodb.getServersCollection()
                        .find({ operator: mongodbOperatorSelection(operator) })
                        .project({
                            _id: 0,
                            password: 0,
                            setupLogs: 0,
                            deployLogs: 0,
                        })
                        .toArray();
                    res.json({ servers });
                } catch (error) {
                    logger.error(
                        `Error fetching my servers: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to fetch servers " + error,
                    });
                }
            }
        );

        app.get(
            "/setup-logs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let server = req.query.server as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!server) {
                        res.status(400).json({ error: "No server specified" });
                        return;
                    }

                    let serverDoc =
                        await Mongodb.getServersCollection().findOne(
                            {
                                server: server,
                            },
                            {
                                projection: {
                                    _id: 0,
                                    setupLogs: 1,
                                    deployLogs: 1,
                                },
                            }
                        );
                    if (!serverDoc) {
                        res.status(404).json({ error: "Server not found" });
                        return;
                    }

                    res.json({
                        setupLogs: serverDoc.setupLogs || {},
                        deployLogs: serverDoc.deployLogs || {},
                    });
                } catch (error) {
                    logger.error(
                        `Error fetching setup logs: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to fetch setup logs " + error,
                    });
                }
            }
        );

        app.get(
            "/deploy-logs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let server = req.query.server as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!server) {
                        res.status(400).json({ error: "No server specified" });
                        return;
                    }
                    let serverDoc =
                        await Mongodb.getServersCollection().findOne(
                            {
                                server: server,
                            },
                            {
                                projection: {
                                    _id: 0,
                                    deployLogs: 1,
                                },
                            }
                        );
                    if (!serverDoc) {
                        res.status(404).json({ error: "Server not found" });
                        return;
                    }
                    res.json({
                        deployLogs: serverDoc.deployLogs || {},
                    });
                } catch (error) {
                    logger.error(
                        `Error fetching deploy logs: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to fetch deploy logs " + error,
                    });
                }
            }
        );

        app.post(
            "/delete-server",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let servers = req.body.servers as string[];
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!server) {
                        res.status(400).json({ error: "No server specified" });
                        return;
                    }

                    for (let server of servers) {
                        await Mongodb.getServersCollection().deleteOne({
                            server: server,
                        });

                        // Remove all lite/bob nodes associcate with it
                        await Mongodb.getLiteNodeCollection().deleteOne({
                            server: server,
                        });
                        await Mongodb.getBobNodeCollection().deleteOne({
                            server: server,
                        });
                    }
                    await NodeService.pullServerLists();
                    res.json({ message: "Server deleted successfully" });
                } catch (error) {
                    logger.error(
                        `Error deleting server: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to delete server " + error,
                    });
                }
            }
        );

        app.post("/refresh-github-tags", async (req, res) => {
            try {
                let service = req.body.service as MongoDbTypes.ServiceType;
                if (!service) {
                    res.status(400).json({ error: "No service specified" });
                    return;
                }
                await GithubService.pullTagsFromGithub(service);
                let tags = GithubService.getGithubTags(service);
                res.json(tags);
            } catch (error) {
                logger.error(
                    `Error refreshing GitHub tags: ${(error as Error).message}`
                );
                res.status(500).json({
                    error: "Failed to refresh GitHub tags " + error,
                });
            }
        });

        app.get(
            "/command-logs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let isStandardCommandFilter = req.query
                        .isStandardCommand as string;
                    let offset = parseInt(req.query.offset as string) || 0;
                    let limit = parseInt(req.query.limit as string) || Infinity;
                    let filterObj: any = {};

                    if (isStandardCommandFilter === "true") {
                        filterObj.isStandardCommand = true;
                    } else if (isStandardCommandFilter === "false") {
                        filterObj.isStandardCommand = false;
                    }

                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }

                    let commandLogs = await Mongodb.getCommandLogsCollection()
                        .find({ operator: operator, ...filterObj })
                        .sort({ timestamp: -1 })
                        .skip(offset)
                        .limit(limit)
                        .project({
                            _id: 0,
                            stdout: 0,
                            stderr: 0,
                        })
                        .toArray();
                    res.json({ commandLogs });
                } catch (error) {
                    logger.error(
                        `Error fetching command logs: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to fetch command logs " + error,
                    });
                }
            }
        );

        app.get("/stdout-command-log", async (req, res) => {
            try {
                let uuid = req.query.uuid as string;
                if (!uuid) {
                    res.status(400).json({ error: "No uuid specified" });
                    return;
                }
                let commandLog =
                    await Mongodb.getCommandLogsCollection().findOne(
                        { uuid: uuid },
                        { projection: { _id: 0, stdout: 1, stderr: 1 } }
                    );
                if (!commandLog) {
                    res.status(404).json({ error: "Command log not found" });
                    return;
                }
                res.json({
                    stdout: commandLog.stdout || "",
                    stderr: commandLog.stderr || "",
                });
            } catch (error) {
                logger.error(
                    `Error fetching stdout of command log: ${
                        (error as Error).message
                    }`
                );
                res.status(500).json({
                    error: "Failed to fetch stdout of command log " + error,
                });
            }
        });

        app.post(
            "/delete-command-log",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let uuid = req.body.uuid as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!uuid) {
                        res.status(400).json({ error: "No uuid specified" });
                        return;
                    }

                    await Mongodb.getCommandLogsCollection().deleteOne({
                        uuid: uuid,
                        operator: operator,
                    });
                    res.json({ message: "Command log deleted successfully" });
                } catch (error) {
                    logger.error(
                        `Error deleting command log: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to delete command log " + error,
                    });
                }
            }
        );

        app.post(
            "/delete-all-command-logs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }

                    await Mongodb.getCommandLogsCollection().deleteMany({
                        operator: operator,
                    });
                    res.json({
                        message: "All command logs deleted successfully",
                    });
                } catch (error) {
                    logger.error(
                        `Error deleting all command logs: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to delete all command logs " + error,
                    });
                }
            }
        );

        app.post(
            "/execute-command",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    // format : command:service::params
                    const QUICKS_COMMANDS_MAP = {
                        "esc/shutdown:lite": () => {
                            return [
                                `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b'`,
                            ];
                        },
                        "f8/savesnapshot:lite": () => {
                            return [
                                `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[19~'`,
                            ];
                        },
                        "f10/clearmemory:lite": () => {
                            return [
                                `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[21~'`,
                            ];
                        },
                        "placebinary:bob": (url: string) => {
                            if (!url || !url.startsWith("http")) {
                                throw new Error("Invalid URL for binary");
                            }
                            return [
                                `cd ~/qbob/`,
                                `rm -rf bob`,
                                `wget ${url}`,
                                `chmod +x $(basename ${url})`,
                            ];
                        },
                        "restartkeydb:bob": () => {
                            return [
                                `pkill -9 keydb-server || true`,
                                `for s in $(screen -ls | awk '/keydb/ {print $1}'); do screen -S "$s" -X quit || true; done`,
                                `while pgrep -x keydb-server >/dev/null; do { echo "Waiting for keydb to be shutdown..."; sleep 1; }; done`,
                                `screen -dmS keydb bash -lc "keydb-server /etc/keydb-runtime.conf || exec bash"`,
                                `until [[ "$(keydb-cli ping 2>/dev/null)" == "PONG" ]]; do { echo "Waiting for keydb..."; sleep 1; }; done`,
                            ];
                        },
                        "restartkvrocks:bob": () => {
                            return [
                                `pkill -9 kvrocks || true`,
                                `for s in $(screen -ls | awk '/kvrocks/ {print $1}'); do screen -S "$s" -X quit || true; done`,
                                `while pgrep -x kvrocks >/dev/null; do { echo "Waiting for kvrocks to be shutdown..."; sleep 1; }; done`,
                                `screen -dmS kvrocks bash -lc "kvrocks -c /etc/kvrocks-runtime.conf || exec bash"`,
                                `until [[ "$(keydb-cli -h 127.0.0.1 -p 6666 ping 2>/dev/null)" == "PONG" ]]; do { echo "Waiting for kvrocks..."; sleep 1; }; done`,
                            ];
                        },
                    };

                    let operator = req.user?.username;
                    let command = req.body.command as string;
                    let servers = req.body.servers as string[];
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!command || !servers) {
                        res.status(400).json({
                            error: "Missing command or servers",
                        });
                        return;
                    }

                    let serverDocs = (
                        await Mongodb.getServersCollection()
                            .find({
                                server: { $in: servers },
                            })
                            .toArray()
                    ).filter((s) => s.username && s.username.length > 0);
                    servers = serverDocs.map((s) => s.server);

                    if (serverDocs.length === 0) {
                        res.status(404).json({
                            error: "No matching servers found in the database",
                        });
                        return;
                    }

                    let currentUUID = uuidv4();
                    await Mongodb.getCommandLogsCollection().insertOne({
                        operator: operator,
                        servers: servers,
                        command: command,
                        stdout: "",
                        stderr: "",
                        timestamp: Date.now(),
                        status: "pending",
                        uuid: currentUUID,
                        isStandardCommand: false,
                        duration: 0,
                    });

                    const databaseUpdater = async ({
                        server,
                        stdout,
                        stderr,
                        status,
                        duration,
                    }: {
                        server: string;
                        stdout: string;
                        stderr: string;
                        status: MongoDbTypes.CommandStatus;
                        duration: number;
                    }) => {
                        await Mongodb.getCommandLogsCollection()
                            .updateOne({ uuid: currentUUID }, [
                                {
                                    $set: {
                                        stdout: {
                                            $concat: [
                                                {
                                                    $ifNull: ["$stdout", ""],
                                                },
                                                "\n",
                                                `---------- Command output for ${server} (${millisToSeconds(
                                                    duration
                                                )}s) ----------- \n\n`,
                                                {
                                                    $literal: stdout,
                                                },
                                            ],
                                        },
                                        stderr: {
                                            $concat: [
                                                {
                                                    $ifNull: ["$stderr", ""],
                                                },
                                                "\n",
                                                `---------- Command error for ${server} (${millisToSeconds(
                                                    duration
                                                )}s) ----------- \n\n`,
                                                {
                                                    $literal: stderr,
                                                },
                                            ],
                                        },
                                        status: status,
                                    },
                                },
                            ])
                            .then()
                            .catch((error) => {
                                logger.error(
                                    `Error updating command log: ${
                                        (error as Error).message
                                    }`
                                );
                            });

                        // Increase duration
                        await Mongodb.getCommandLogsCollection()
                            .updateOne(
                                { uuid: currentUUID },
                                {
                                    $inc: { duration: duration },
                                }
                            )
                            .then()
                            .catch((error) => {
                                logger.error(
                                    `Error updating command log duration: ${
                                        (error as Error).message
                                    }`
                                );
                            });
                    };
                    const updateCommandLogStatus = (
                        status: MongoDbTypes.CommandStatus
                    ) => {
                        Mongodb.getCommandLogsCollection()
                            .updateOne(
                                { uuid: currentUUID },
                                {
                                    $set: { status: status },
                                }
                            )
                            .then()
                            .catch((error) => {
                                logger.error(
                                    `Error updating command log status: ${
                                        (error as Error).message
                                    }`
                                );
                            });
                    };
                    const addErrorServersToCommandLog = async (
                        errorServers: string[]
                    ) => {
                        Mongodb.getCommandLogsCollection()
                            .updateOne(
                                { uuid: currentUUID },
                                {
                                    $addToSet: {
                                        errorServers: { $each: errorServers },
                                    },
                                }
                            )
                            .then()
                            .catch((error) => {
                                logger.error(
                                    `Error adding error servers to command log: ${
                                        (error as Error).message
                                    }`
                                );
                            });
                    };

                    let commandsToBeExecuted: string[] = [];
                    // if (command in QUICKS_COMMANDS_MAP) {
                    //     commandsToBeExecuted =
                    //         QUICKS_COMMANDS_MAP[
                    //             command as keyof typeof QUICKS_COMMANDS_MAP
                    //         ];
                    // } else {
                    //     commandsToBeExecuted = [command];
                    // }
                    for (let cmdKey in QUICKS_COMMANDS_MAP) {
                        if (command.startsWith(cmdKey)) {
                            let cmdFunc =
                                QUICKS_COMMANDS_MAP[
                                    cmdKey as keyof typeof QUICKS_COMMANDS_MAP
                                ];

                            let params: string[] =
                                command.split("::")[1]?.split(",") || [];

                            // @ts-ignore
                            commandsToBeExecuted = cmdFunc(...params);
                            break;
                        }
                    }
                    if (commandsToBeExecuted.length === 0) {
                        commandsToBeExecuted = [command];
                    }
                    console.log(
                        "Commands to be executed:",
                        commandsToBeExecuted
                    );

                    let commandsExecuted = 0;
                    let haveAtleastOneError = false;
                    let errorServersList: string[] = [];
                    for (let serverObject of serverDocs) {
                        SSHService.executeCommands(
                            serverObject.server,
                            serverObject.username,
                            serverObject.password,
                            commandsToBeExecuted,
                            30_000,
                            {
                                sshPrivateKey: serverObject.sshPrivateKey,
                            }
                        )
                            .then((result) => {
                                commandsExecuted++;
                                let isAllDone =
                                    commandsExecuted === serverDocs.length;
                                if (result.isSuccess) {
                                    databaseUpdater({
                                        server: serverObject.server,
                                        stdout: Object.values(
                                            result.stdouts
                                        ).join("\n"),
                                        stderr: Object.values(
                                            result.stderrs
                                        ).join("\n"),
                                        status: isAllDone
                                            ? "completed"
                                            : "pending",
                                        duration: result.duration,
                                    });
                                } else {
                                    haveAtleastOneError = true;
                                    errorServersList.push(serverObject.server);
                                    databaseUpdater({
                                        server: serverObject.server,
                                        stdout: Object.values(
                                            result.stdouts
                                        ).join("\n"),
                                        stderr: Object.values(
                                            result.stderrs
                                        ).join("\n"),
                                        status: isAllDone
                                            ? "failed"
                                            : "pending",
                                        duration: result.duration,
                                    });
                                }
                                return result;
                            })
                            .then(() => {
                                // If all done, update the main command log status
                                if (commandsExecuted === serverDocs.length) {
                                    updateCommandLogStatus(
                                        haveAtleastOneError
                                            ? "failed"
                                            : "completed"
                                    );
                                    if (haveAtleastOneError) {
                                        addErrorServersToCommandLog(
                                            errorServersList
                                        );
                                    }
                                }
                            })
                            // never reached (just there for future)
                            .catch((error) => {
                                haveAtleastOneError = true;
                                commandsExecuted++;
                                let isAllDone =
                                    commandsExecuted === serverDocs.length;
                                databaseUpdater({
                                    server: serverObject.server,
                                    stdout: (error as Error).message,
                                    stderr: (error as Error).message,
                                    status: isAllDone ? "failed" : "pending",
                                    duration: 0,
                                });
                            });
                    }

                    res.json({
                        message: "Command execution initiated",
                    });
                } catch (error) {
                    logger.error(
                        `Error executing command: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to execute command " + error,
                    });
                }
            }
        );

        app.post(
            "/set-ssh-key",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let sshPrivateKey = req.body.sshPrivateKey as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!sshPrivateKey) {
                        res.status(400).json({
                            error: "No SSH private key provided",
                        });
                        return;
                    }

                    await Mongodb.getUsersCollection().updateOne(
                        { username: operator },
                        { $set: { currentsshPrivateKey: sshPrivateKey } }
                    );

                    res.json({
                        message: "SSH private key updated successfully",
                    });
                } catch (error) {
                    logger.error(
                        `Error setting SSH private key: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to set SSH private key " + error,
                    });
                }
            }
        );

        app.get("/my-info", MiddleWare.authenticateToken, async (req, res) => {
            try {
                let operator = req.user?.username;
                if (!operator) {
                    res.status(400).json({ error: "No operator found" });
                    return;
                }

                let userDoc = await Mongodb.getUsersCollection().findOne(
                    { username: operator },
                    { projection: { _id: 0, passwordHash: 0 } }
                );
                res.json({ user: userDoc });
            } catch (error) {
                logger.error(
                    `Error fetching my info: ${(error as Error).message}`
                );
                res.status(500).json({
                    error: "Failed to fetch user info " + error,
                });
            }
        });

        app.get("/random-peers", (req, res) => {
            try {
                let expectedLitePeersLength =
                    parseInt(req.query.litePeers as string) || 2;
                let expectedBobPeersLength =
                    parseInt(req.query.bobPeers as string) || 2;
                let service = req.query.service as MongoDbTypes.ServiceType;
                if (service == MongoDbTypes.ServiceType.LiteNode) {
                    let peers = NodeService.getRandomLiteNode(
                        expectedLitePeersLength
                    ).map((peer) => peer.server);
                    res.json({ peers: peers });
                } else if (service == MongoDbTypes.ServiceType.BobNode) {
                    let litePeers = NodeService.getRandomLiteNode(
                        expectedLitePeersLength,
                        true
                    ).map((peer) => peer.server);
                    let bobPeers = NodeService.getRandomBobNode(
                        expectedBobPeersLength
                    ).map((peer) => peer.server);
                    res.json({
                        litePeers: litePeers,
                        bobPeers: bobPeers,
                    });
                } else {
                    res.status(400).json({ error: "Invalid service type" });
                }
            } catch (error) {
                logger.error(
                    `Error fetching random peers: ${(error as Error).message}`
                );
                res.status(500).json({
                    error: "Failed to fetch random peers " + error,
                });
            }
        });

        app.get(
            "/shortcut-commands",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    let commands = await Mongodb.getShortcutCommandsCollection()
                        .find({
                            operator: operator,
                        })
                        .project({ _id: 0 })
                        .toArray();
                    res.json({ commands });
                } catch (error) {
                    logger.error(
                        `Error fetching shortcut commands: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to fetch shortcut commands " + error,
                    });
                }
            }
        );

        app.post(
            "/add-shortcut-command",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let name = req.body.name as string;
                    let command = req.body.command as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!name || !command) {
                        res.status(400).json({
                            error: "Name and command are required",
                        });
                        return;
                    }

                    await Mongodb.getShortcutCommandsCollection().insertOne({
                        operator: operator,
                        name: name,
                        command: command,
                    });

                    res.json({
                        message: "Shortcut command added successfully",
                    });
                } catch (error) {
                    logger.error(
                        `Error adding shortcut command: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to add shortcut command " + error,
                    });
                }
            }
        );

        app.delete(
            "/delete-shortcut-command",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let name = req.body.name as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!name) {
                        res.status(400).json({
                            error: "Name is required",
                        });
                        return;
                    }

                    await Mongodb.getShortcutCommandsCollection().deleteOne({
                        operator: operator,
                        name: name,
                    });

                    res.json({
                        message: "Shortcut command deleted successfully",
                    });
                } catch (error) {
                    logger.error(
                        `Error deleting shortcut command: ${
                            (error as Error).message
                        }`
                    );
                    res.status(500).json({
                        error: "Failed to delete shortcut command " + error,
                    });
                }
            }
        );

        app.post("/server-info-for-map", async (req, res) => {
            try {
                let servers = await Mongodb.getServersCollection()
                    .find({}, { projection: { _id: 0, server: 1, ipInfo: 1 } })
                    .toArray();

                let serverHash: Record<string, string> = {};
                for (let server of servers) {
                    if (!serverHash[server.server]) {
                        serverHash[server.server] = await hashSHA256(
                            server.server
                        );
                    }
                }

                let responseServers = servers.map((s) => ({
                    server: serverHash[s.server] as string,
                    lat: s.ipInfo?.lat || 0,
                    lon: s.ipInfo?.lon || 0,
                    isBM: false,
                }));

                let bmNodes = MapService.getBMNodes();

                for (let bmNode of bmNodes) {
                    if (serverHash[bmNode]) {
                        continue;
                    }
                    if (!serverHash[bmNode]) {
                        serverHash[bmNode] = await hashSHA256(bmNode);
                    }
                    let ipInfo: IpInfo = (await MapService.getIpInfoForServer(
                        bmNode
                    )) as IpInfo;

                    if (!ipInfo) {
                        return;
                    }

                    responseServers.push({
                        server: serverHash[bmNode] as string,
                        lat: ipInfo.lat || 0,
                        lon: ipInfo.lon || 0,
                        isBM: true,
                    });
                }

                // make sure unique
                let uniqueServersMap: Record<
                    string,
                    {
                        server: string;
                        lat: number;
                        lon: number;
                        isBM: boolean;
                    }
                > = {};
                responseServers.forEach((s) => {
                    uniqueServersMap[s.server] = s;
                });
                responseServers = Object.values(uniqueServersMap);
                res.json({ servers: responseServers });
            } catch (error) {
                logger.error(
                    `Error fetching server info for map: ${
                        (error as Error).message
                    }`
                );
                res.status(500).json({
                    error: "Failed to fetch server info for map " + error,
                });
            }
        });

        app.get(
            "/cron-jobs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let cronId = req.query.cronId as string | undefined;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }

                    let cronJobs = await Mongodb.getCronJobsCollection()
                        .find(
                            {
                                operator: operator,
                                ...(cronId ? { cronId: cronId } : {}),
                            },
                            { projection: { _id: 0 } }
                        )
                        .toArray();
                    res.json({ cronJobs });
                } catch (error) {
                    logger.error(
                        `Error fetching cron jobs: ${(error as Error).message}`
                    );
                    res.status(500).json({
                        error: "Failed to fetch cron jobs " + error,
                    });
                }
            }
        );

        app.post(
            "/cron-jobs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let cronJob: MongoDbTypes.CronJob = req.body;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (
                        !cronJob ||
                        !cronJob.command ||
                        !cronJob.schedule ||
                        !cronJob.type
                    ) {
                        res.status(400).json({
                            error: "cronJob with command, and schedule are required",
                        });
                        return;
                    }

                    if (cronJob.type === "custom") {
                        // no support for custom cron syntax yet
                        return res.status(400).json({
                            error: "Custom cron syntax is not supported yet",
                        });
                    }

                    cronJob.operator = operator;
                    cronJob.cronId = (
                        await hashSHA256(
                            operator +
                                "-" +
                                cronJob.name +
                                "-" +
                                cronJob.command
                        )
                    ).substring(0, 8);

                    Mongodb.getCronJobsCollection()
                        .updateOne(
                            { cronId: cronJob.cronId, operator: operator },
                            { $set: cronJob },
                            { upsert: true }
                        )
                        .then(() => {
                            res.json({
                                message:
                                    "Cron job created/updated successfully",
                            });
                        })
                        .catch((error) => {
                            logger.error(
                                `Error creating/updating cron job: ${
                                    (error as Error).message
                                }`
                            );
                            res.status(500).send({
                                error:
                                    "Failed to create/update cron job " + error,
                            });
                        });
                } catch (error) {
                    res.status(500).send({
                        error: "Failed to create/update cron job " + error,
                    });
                }
            }
        );

        app.post(
            "/cron-jobs/update",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let cronId = req.body.cronId as string;
                    let updates = req.body
                        .updates as Partial<MongoDbTypes.CronJob>;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!cronId || !updates) {
                        res.status(400).json({
                            error: "cronId and updates are required",
                        });
                        return;
                    }

                    Mongodb.getCronJobsCollection()
                        .updateOne(
                            { cronId: cronId, operator: operator },
                            { $set: updates }
                        )
                        .then(() => {
                            res.json({
                                message: "Cron job updated successfully",
                            });
                        })
                        .catch((error) => {
                            logger.error(
                                `Error updating cron job: ${
                                    (error as Error).message
                                }`
                            );
                            res.status(500).send({
                                error: "Failed to update cron job " + error,
                            });
                        });
                } catch (error) {
                    res.status(500).send({
                        error: "Failed to update cron job " + error,
                    });
                }
            }
        );

        app.post("/checkin", async (req, res) => {
            try {
                let body = req.body;
                let ip =
                    req.headers["x-forwarded-for"] || req.socket.remoteAddress;
                // check if body is object (valid json)
                if (typeof body !== "object") {
                    res.status(400).json({ error: "Invalid JSON body" });
                    return;
                }
                if (Array.isArray(body)) {
                    res.status(400).json({ error: "Invalid JSON body" });
                    return;
                }
                // these field must be exists: type, version, uptime, operator, signature, timestamp
                const requiredFields = [
                    "type",
                    "version",
                    "uptime",
                    "operator",
                    "signature",
                    "timestamp",
                ];
                for (let field of requiredFields) {
                    if (!(field in body)) {
                        res.status(400).json({
                            error: `Missing required field: ${field}`,
                        });
                        return;
                    }
                }
                // rate limit: only allow checkin once every 30 minutes per ip+type+operator
                let rateLimitKey = `${ip}-${body.type}-${body.operator}`;
                let now = Date.now();
                if (
                    lastCheckinMap[rateLimitKey] &&
                    now - lastCheckinMap[rateLimitKey] < 30 * 60 * 1000
                ) {
                    res.status(429).json({
                        error: "Too many checkins. Please wait before checking in again.",
                    });
                    return;
                }
                lastCheckinMap[rateLimitKey] = now;
                // insert to mongodb
                await Mongodb.getCheckinsCollection().insertOne({
                    ...body,
                    ip: ip,
                    lastCheckinAt: Date.now(),
                });
                res.json({ message: "Checkin successful" });
            } catch (error) {
                logger.error(`Error in checkin: ${(error as Error).message}`);
                res.status(500).json({
                    error: "Failed to checkin " + error,
                });
            }
        });

        app.get("/checkins", async (req, res) => {
            try {
                let type = req.query.type as string | undefined;
                let operator = req.query.operator as string | undefined;
                let ipv4 = req.query.ip as string | undefined;
                let normalized =
                    req.query.normalized === "true" ||
                    req.query.normalized === "1";

                let query: any = {};
                if (type) {
                    query.type = type;
                }
                if (operator) {
                    query.operator = operator;
                }
                if (ipv4) {
                    // support ipv4 partial match
                    query.ip = { $regex: ipv4 };
                }

                // get last wed at 12:00 utc +0
                const lastWedTimestamp = getLastWednesdayTimestamp().timestamp;

                if (normalized) {
                    query.timestamp = { $gte: lastWedTimestamp / 1000 };
                }

                let checkins = (await Mongodb.getCheckinsCollection()
                    .find(query, { projection: { _id: 0 } })
                    .limit(normalized ? Infinity : 1000)
                    .skip(0)
                    .toArray()) as MongoDbTypes.Checkin[];

                if (normalized) {
                    // merge checkins by type+operator+ip, calc total uptime and last checkin
                    let mergedCheckins: Record<
                        string,
                        MongoDbTypes.Checkin & {
                            totalUptime: number;
                            firstSeenAt: number;
                        }
                    > = {};
                    for (let checkin of checkins.sort(
                        (a, b) => a.timestamp - b.timestamp
                    )) {
                        let key = `${checkin.type}-${checkin.operator}-${checkin.ip}`;
                        if (!mergedCheckins[key]) {
                            mergedCheckins[key] = {
                                ...checkin,
                                totalUptime: checkin.uptime,
                                firstSeenAt: checkin.timestamp * 1000,
                            };
                        } else {
                            // if current uptime is greater than previous uptime, add the difference to totalUptime
                            if (checkin.uptime >= mergedCheckins[key].uptime) {
                                mergedCheckins[key].totalUptime +=
                                    checkin.uptime - mergedCheckins[key].uptime;
                            } else {
                                // else, just add the current uptime (node restarted)
                                mergedCheckins[key].totalUptime +=
                                    checkin.uptime;
                            }
                            // update other fields
                            mergedCheckins[key].timestamp =
                                checkin.timestamp * 1000;
                            mergedCheckins[key].uptime = checkin.uptime;
                            mergedCheckins[key].lastCheckinAt =
                                checkin.lastCheckinAt;
                        }
                    }
                    // delete unused fields
                    const unusedFields = ["uptime"];
                    for (let key in mergedCheckins) {
                        for (let field of unusedFields) {
                            delete (mergedCheckins[key] as any)[field];
                        }
                    }
                    // convert to array
                    checkins = Object.values(
                        mergedCheckins
                    ) as MongoDbTypes.Checkin[];
                }

                // reformat ip from db (if ipv6 format, convert to ipv4
                checkins = checkins.map((checkin) => {
                    if (checkin.ip && checkin.ip.startsWith("::ffff:")) {
                        checkin.ip = checkin.ip.replace("::ffff:", "");
                    }
                    return checkin;
                });

                res.json({ checkins });
            } catch (error) {
                logger.error(
                    `Error fetching checkins: ${(error as Error).message}`
                );
                res.status(500).json({
                    error: "Failed to fetch checkins " + error,
                });
            }
        });

        app.get("/currenttick", (_, res) => {
            try {
                let statuses = NodeService.getStatus();
                let currentTick = 0;
                let epoch = 0;
                for (let node of statuses.liteNodes) {
                    if (node.tick > currentTick) {
                        currentTick = node.tick;
                        epoch = node.epoch;
                    }
                }
                res.json({ tick: currentTick, epoch });
            } catch (error) {
                logger.error(
                    `Error fetching current tick: ${(error as Error).message}`
                );
                res.status(500).json({
                    error: "Failed to fetch current tick " + error,
                });
            }
        });

        app.delete(
            "/cron-jobs",
            MiddleWare.authenticateToken,
            async (req, res) => {
                try {
                    let operator = req.user?.username;
                    let cronId = req.body.cronId as string;
                    if (!operator) {
                        res.status(400).json({ error: "No operator found" });
                        return;
                    }
                    if (!cronId) {
                        res.status(400).json({
                            error: "cronId is required",
                        });
                        return;
                    }

                    Mongodb.getCronJobsCollection()
                        .deleteOne({ cronId: cronId, operator: operator })
                        .then(() => {
                            res.json({
                                message: "Cron job deleted successfully",
                            });
                        })
                        .catch((error) => {
                            logger.error(
                                `Error deleting cron job: ${
                                    (error as Error).message
                                }`
                            );
                            res.status(500).send({
                                error: "Failed to delete cron job " + error,
                            });
                        });
                } catch (error) {
                    res.status(500).send({
                        error: "Failed to delete cron job " + error,
                    });
                }
            }
        );

        // let server = app.listen(port, () => {
        //     logger.info(`HTTP Server is running at http://localhost:${port}`);
        // });
        let server: any;
        if (process.env.ENV === "production") {
            logger.info("Starting HTTPS server in production mode");
            const httpsOptions = {
                key: fs.readFileSync(
                    process.env.HTTPS_KEY_PATH || "./certs/key.pem"
                ),
                cert: fs.readFileSync(
                    process.env.HTTPS_CERT_PATH || "./certs/cert.pem"
                ),
            };
            server = https.createServer(httpsOptions, app).listen(port, () => {
                logger.info(
                    `HTTPS Server is running at https://localhost:${port}`
                );
            });
        } else {
            logger.info("Starting HTTP server in development mode");
            server = app.listen(port, () => {
                logger.info(
                    `HTTP Server is running at http://localhost:${port}`
                );
            });
        }

        return server;
    }
}

export { HttpServer };
