import express from "express";
import { GithubService } from "../../services/github-service.js";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { SSHService } from "../../services/ssh-service.js";
import { mongodbOperatorSelection } from "../../utils/common.js";
import { lookupIp, type IpInfo } from "../../utils/ip.js";
import { millisToSeconds } from "../../utils/time.js";
import { NodeService } from "../../services/node-service.js";

const router = express.Router();

router.get("/servers", (req, res) => {
    let servers: string[] =
        GithubService.getVariable("SERVERS").split(" ");
    for (let i = 0; i < servers.length; i++) {
        if (!servers[i]) continue;

        servers[i] = servers[i]!.trim().split("@")[1] as string;
    }

    res.json({ servers });
});

router.post(
    "/set-server-alias",
    authenticateToken,
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

router.post(
    "/new-servers",
    authenticateToken,
    async (req, res) => {
        let body: {
            servers: {
                ip: string;
                sshPort?: number;
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
                    sshPort: server.sshPort || 22,
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

router.get(
    "/my-servers",
    authenticateToken,
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

router.post(
    "/delete-server",
    authenticateToken,
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

export default router;
