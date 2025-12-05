import express from "express";
import cors from "cors";
import { GithubService } from "../services/github-service.js";
import { NodeService } from "../services/node-service.js";
import { logger } from "../utils/logger.js";
import jwt from "jsonwebtoken";
import { Mongodb, MongoDbTypes } from "../database/db.js";
import { SSHService } from "../services/ssh-service.js";
import { checkLink } from "../utils/common.js";
import { v4 as uuidv4 } from "uuid";
import { millisToSeconds } from "../utils/time.js";
import { lookupIp, type IpInfo } from "../utils/ip.js";
import { calcGroupIdFromIds } from "../utils/node.js";

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
            let statuses = NodeService.getStatus();
            if (operator) {
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

            statuses.liteNodes = statuses.liteNodes.map((status) => {
                let nodeDoc = liteNodesFromDb.find(
                    (node) => node.server === status.server
                );
                return {
                    ...status,
                    isPrivate: nodeDoc ? nodeDoc.isPrivate : false,
                };
            });
            statuses.bobNodes = statuses.bobNodes.map((status) => {
                let nodeDoc = bobNodesFromDb.find(
                    (node) => node.server === status.server
                );
                return {
                    ...status,
                    isPrivate: nodeDoc ? nodeDoc.isPrivate : false,
                };
            });

            res.json({ statuses });
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
                            { server: server, operator: operator },
                            { $set: { isPrivate: !!isPrivate } }
                        );
                    } else if (service === MongoDbTypes.ServiceType.BobNode) {
                        await Mongodb.getBobNodeCollection().updateOne(
                            { server: server, operator: operator },
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
                let serverDocs = await Mongodb.getServersCollection()
                    .find({
                        server: { $in: servers },
                        operator,
                    })
                    .toArray();

                if (
                    servers.length === 0 ||
                    serverDocs.length !== servers.length
                ) {
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
                binaryUrl = GithubService.getDownloadUrlForTag(
                    tag,
                    binaryFileMap[service as keyof typeof binaryFileMap],
                    service
                );
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
            if (
                service === MongoDbTypes.ServiceType.LiteNode ||
                service === MongoDbTypes.ServiceType.BobNode
            ) {
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

            // Get server details from DB
            let serverDocs: MongoDbTypes.Server[] = [];
            try {
                serverDocs = await Mongodb.getServersCollection()
                    .find({ server: { $in: servers } })
                    .toArray();
                if (
                    serverDocs.length === 0 ||
                    serverDocs.length !== servers.length
                ) {
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
                            peers: extraData?.peers as string[],
                            systemRamInGB: parseInt(server.ram || "0"),
                            mainAuxStatus: extraData.mainAuxStatus,
                            ids: extraData.ids,
                            ramMode: extraData.ramMode,
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
                                stdout: "",
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
                        { server: server, operator: operator },
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
                        .find({ operator: operator })
                        .project({
                            _id: 0,
                            password: 0,
                            setupLogs: 0,
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
                                operator: operator,
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
                            operator: operator,
                        });

                        // Remove all lite/bob nodes associcate with it
                        await Mongodb.getLiteNodeCollection().deleteOne({
                            server: server,
                            operator: operator,
                        });
                        await Mongodb.getBobNodeCollection().deleteOne({
                            server: server,
                            operator: operator,
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
                    const QUICKS_COMMANDS_MAP = {
                        "esc/shutdown:lite": [
                            `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b'`,
                        ],
                        "f8/savesnapshot:lite": [
                            `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[19~'`,
                        ],
                        "f10/clearmemory:lite": [
                            `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[21~'`,
                        ],
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

                    let serverDocs = await Mongodb.getServersCollection()
                        .find({
                            server: { $in: servers },
                            operator,
                        })
                        .toArray();

                    if (
                        serverDocs.length === 0 ||
                        serverDocs.length !== servers.length
                    ) {
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

                    let commandsToBeExecuted: string[] = [];
                    if (command in QUICKS_COMMANDS_MAP) {
                        commandsToBeExecuted =
                            QUICKS_COMMANDS_MAP[
                                command as keyof typeof QUICKS_COMMANDS_MAP
                            ];
                    } else {
                        commandsToBeExecuted = [command];
                    }
                    let commandsExecuted = 0;
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
                            .then(async (result) => {
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
                            })
                            .catch((error) => {
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

        let server = app.listen(port, () => {
            logger.info(`HTTP Server is running at http://localhost:${port}`);
        });

        return server;
    }
}

export { HttpServer };
