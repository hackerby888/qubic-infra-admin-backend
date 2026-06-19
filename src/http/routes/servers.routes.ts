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
    let servers: string[] = GithubService.getVariable("SERVERS").split(" ");
    for (let i = 0; i < servers.length; i++) {
        if (!servers[i]) continue;

        servers[i] = servers[i]!.trim().split("@")[1] as string;
    }

    res.json({ servers });
});

router.post("/set-server-alias", authenticateToken, async (req, res) => {
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
        logger.error(`Error setting server alias: ${(error as Error).message}`);
        res.status(500).json({
            error: "Internal server error" + error,
        });
    }
});

router.post("/new-servers", authenticateToken, async (req, res) => {
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
            let userDoc = await Mongodb.getUsersCollection().findOne({
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

    let serversDataNormalized: MongoDbTypes.Server[] = serversData.map(
        (server) => {
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
                ].filter((s) => s !== "null") as MongoDbTypes.ServiceType[],
                status: authType === "tracking" ? "active" : "setting_up",
            };
        }
    );

    try {
        let currentServers = await Mongodb.getServersCollection()
            .find({})
            .project({ _id: 0, server: 1 })
            .toArray();

        // Check if one of the servers already exists
        for (let serverData of serversDataNormalized) {
            if (currentServers.find((s) => s.server === serverData.server)) {
                res.status(400).json({
                    error: `Server ${serverData.server} already exists`,
                });
                return;
            }
        }

        // Insert new servers into DB
        await Mongodb.getServersCollection().insertMany(serversDataNormalized);

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
                                            stdout: (error as Error).message,
                                            stderr: (error as Error).message,
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
        logger.error(`Error adding new servers: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to add new servers " + error,
        });
        return;
    }

    res.json({ message: "Servers added successfully" });
});

router.post(
    "/promote-tracking-server",
    authenticateToken,
    async (req, res) => {
        let body: {
            server: string;
            authType: "password" | "sshKey";
            username: string;
            password?: string;
        } = req.body;
        let { server, authType, username, password } = body;
        let operator = req.user?.username;

        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!server || !username || (authType !== "password" && authType !== "sshKey")) {
            res.status(400).json({ error: "Missing or invalid parameters" });
            return;
        }
        if (authType === "password" && !password) {
            res.status(400).json({ error: "Password required for password auth" });
            return;
        }

        // Resolve the server and ensure it belongs to the operator and is tracking-only
        let serverDoc = await Mongodb.getServersCollection().findOne({
            server: server,
            operator: mongodbOperatorSelection(operator),
        });
        if (!serverDoc) {
            res.status(404).json({ error: "Server not found" });
            return;
        }
        if (serverDoc.username) {
            res.status(400).json({
                error: "Server already has credentials (not tracking-only)",
            });
            return;
        }

        // Resolve SSH key when using key auth (stored on the user)
        let userSshKey = "";
        if (authType === "sshKey") {
            let userDoc = await Mongodb.getUsersCollection().findOne({
                username: operator,
            });
            if (userDoc && userDoc.currentsshPrivateKey) {
                userSshKey = userDoc.currentsshPrivateKey;
            } else {
                res.status(400).json({ error: "No SSH key found for user" });
                return;
            }
        }

        let resolvedPassword = authType === "password" ? password || "" : "";

        try {
            await Mongodb.getServersCollection().updateOne(
                { server: server },
                {
                    $set: {
                        username: username,
                        password: resolvedPassword,
                        sshPrivateKey: userSshKey,
                        status: "setting_up",
                    },
                }
            );
        } catch (error) {
            logger.error(
                `Error promoting tracking server: ${(error as Error).message}`
            );
            res.status(500).json({ error: "Failed to update server" });
            return;
        }

        // Kick off setup asynchronously (3+ min); respond immediately
        SSHService.setupNode(server, username, resolvedPassword, userSshKey)
            .then((result) => {
                if (result.isSuccess) {
                    Mongodb.getServersCollection()
                        .updateOne(
                            { server: server },
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
                                            Object.values(result.stdouts).join(
                                                "\n"
                                            ),
                                        stderr: Object.values(
                                            result.stderrs
                                        ).join("\n"),
                                    },
                                },
                            }
                        )
                        .then(() => NodeService.pullServerLists())
                        .catch((_) => {});
                } else {
                    Mongodb.getServersCollection()
                        .updateOne(
                            { server: server },
                            {
                                $set: {
                                    status: "error",
                                    setupLogs: {
                                        stdout:
                                            `---------- Time elapsed ${millisToSeconds(
                                                result.duration
                                            )} seconds ----------- \n\n` +
                                            Object.values(result.stdouts).join(
                                                "\n"
                                            ),
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
                        { server: server },
                        {
                            $set: {
                                status: "error",
                                setupLogs: {
                                    stdout: (error as Error).message,
                                    stderr: (error as Error).message,
                                },
                            },
                        }
                    )
                    .then()
                    .catch(() => {});
            });

        res.json({ message: "Server promotion started" });
    }
);

router.get("/my-servers", authenticateToken, async (req, res) => {
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
        logger.error(`Error fetching my servers: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to fetch servers " + error,
        });
    }
});

router.post("/delete-server", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let servers = req.body.servers as string[];
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!servers) {
            res.status(400).json({ error: "No server specified" });
            return;
        }

        for (let server of servers) {
            await Mongodb.getServersCollection().deleteOne({
                server: server,
            });

            // Remove all lite/bob nodes associated with it
            await Mongodb.getLiteNodeCollection().deleteOne({
                server: server,
            });
            await Mongodb.getBobNodeCollection().deleteOne({
                server: server,
            });
            SSHService._clearSSHPortCache(server);
        }
        await NodeService.pullServerLists();
        res.json({ message: "Server deleted successfully" });
    } catch (error) {
        logger.error(`Error deleting server: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to delete server " + error,
        });
    }
});

// Remove a single service (lite/bob) from a server without deleting the server.
// Stops the running node on the host (best-effort), drops the service + its
// per-service deploy state, deletes the lighter polling record, and refreshes
// NodeService so realtime tracking for that service stops.
router.post("/remove-server-service", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let { server, service } = req.body as {
            server: string;
            service: MongoDbTypes.ServiceType;
        };
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!server || !service) {
            res.status(400).json({ error: "Missing 'server' or 'service'" });
            return;
        }
        if (
            service !== MongoDbTypes.ServiceType.LiteNode &&
            service !== MongoDbTypes.ServiceType.BobNode
        ) {
            res.status(400).json({ error: "Invalid service" });
            return;
        }

        // Resolve the server, scoped to the operator (admin = all).
        let serverDoc = await Mongodb.getServersCollection().findOne({
            server,
            operator: mongodbOperatorSelection(operator),
        });
        if (!serverDoc) {
            res.status(404).json({ error: "Server not found" });
            return;
        }
        if (!serverDoc.services?.includes(service)) {
            res.status(400).json({
                error: "Server does not run this service",
            });
            return;
        }

        // DB first so the user gets a fast, authoritative confirm. Drop the
        // service + its per-service deploy state from the server doc.
        await Mongodb.getServersCollection().updateOne(
            { server },
            {
                $pull: { services: service },
                $unset: {
                    [`deployStatus.${service}`]: "",
                    [`deployStatusAt.${service}`]: "",
                    [`deployLogs.${service}`]: "",
                },
            } as any
        );

        // Remove the lighter polling record so realtime tracking stops.
        if (service === MongoDbTypes.ServiceType.LiteNode) {
            await Mongodb.getLiteNodeCollection().deleteOne({ server });
        } else {
            await Mongodb.getBobNodeCollection().deleteOne({ server });
        }

        await NodeService.pullServerLists();
        SSHService._clearSSHPortCache(server);

        // Respond now — tracking stopped and DB updated. Stopping the running
        // node on the host is SSH and can take a while (or hang on an
        // unreachable host), so run it in the background best-effort; it must
        // not block the user's confirm.
        res.json({ message: "Service removed; stopping on host in background" });

        if (serverDoc.username) {
            SSHService.shutdownNode(
                serverDoc.server,
                serverDoc.username,
                serverDoc.password,
                serverDoc.sshPrivateKey,
                service
            )
                .then((result) => {
                    if (!result.isSuccess) {
                        logger.warn(
                            `Removed ${service} from ${server}; host stop returned failure`
                        );
                    }
                })
                .catch((sshError) => {
                    logger.warn(
                        `Removed ${service} from ${server} but failed to stop it on host: ${
                            (sshError as Error).message
                        }`
                    );
                });
        }
    } catch (error) {
        logger.error(
            `Error removing server service: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to remove service " + error,
        });
    }
});

// Add a service (lite/bob) back to a server. Mirrors /new-servers: registers
// the service, then runs host setup (dependency install) in the background and
// creates the polling record on success so realtime tracking resumes. The node
// binary itself is deployed separately via the deploy dialog.
router.post("/add-server-service", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let { server, service } = req.body as {
            server: string;
            service: MongoDbTypes.ServiceType;
        };
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!server || !service) {
            res.status(400).json({ error: "Missing 'server' or 'service'" });
            return;
        }
        if (
            service !== MongoDbTypes.ServiceType.LiteNode &&
            service !== MongoDbTypes.ServiceType.BobNode
        ) {
            res.status(400).json({ error: "Invalid service" });
            return;
        }

        let serverDoc = await Mongodb.getServersCollection().findOne({
            server,
            operator: mongodbOperatorSelection(operator),
        });
        if (!serverDoc) {
            res.status(404).json({ error: "Server not found" });
            return;
        }
        if (serverDoc.services?.includes(service)) {
            res.status(400).json({
                error: "Server already runs this service",
            });
            return;
        }

        let createPollingDoc = async () => {
            let doc = { server, operator: operator as string, isPrivate: false };
            if (service === MongoDbTypes.ServiceType.LiteNode) {
                await Mongodb.getLiteNodeCollection()
                    .updateOne({ server }, { $set: doc }, { upsert: true })
                    .catch(() => {});
            } else {
                await Mongodb.getBobNodeCollection()
                    .updateOne({ server }, { $set: doc }, { upsert: true })
                    .catch(() => {});
            }
        };

        let hasCreds = Boolean(serverDoc.username);

        // Register the service immediately (badge appears). Mark setting_up only
        // when we will actually SSH the host.
        await Mongodb.getServersCollection().updateOne(
            { server },
            {
                $addToSet: { services: service },
                ...(hasCreds ? { $set: { status: "setting_up" } } : {}),
            } as any
        );

        // Tracking-only servers have no credentials — nothing to set up on the
        // host, just register + start tracking.
        if (!hasCreds) {
            await createPollingDoc();
            await NodeService.pullServerLists();
            res.json({
                message: "Service added (tracking-only, no host setup)",
                setupStarted: false,
            });
            return;
        }

        // Respond now; run dependency setup on the host in the background, like
        // /new-servers. Polling doc is created only on a successful setup.
        res.json({
            message: "Service added; setup running on host",
            setupStarted: true,
        });

        SSHService.setupNode(
            serverDoc.server,
            serverDoc.username,
            serverDoc.password,
            serverDoc.sshPrivateKey
        )
            .then(async (result) => {
                if (result.isSuccess) {
                    await Mongodb.getServersCollection()
                        .updateOne(
                            { server },
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
                                            Object.values(result.stdouts).join(
                                                "\n"
                                            ),
                                        stderr: Object.values(
                                            result.stderrs
                                        ).join("\n"),
                                    },
                                },
                            }
                        )
                        .catch(() => {});
                    await createPollingDoc();
                    await NodeService.pullServerLists();
                } else {
                    await Mongodb.getServersCollection()
                        .updateOne(
                            { server },
                            {
                                $set: {
                                    status: "error",
                                    setupLogs: {
                                        stdout: Object.values(
                                            result.stdouts
                                        ).join("\n"),
                                        stderr: Object.values(
                                            result.stderrs
                                        ).join("\n"),
                                    },
                                },
                            }
                        )
                        .catch(() => {});
                }
            })
            .catch(async (error) => {
                logger.error(
                    `Error setting up added service ${service} on ${server}: ${
                        (error as Error).message
                    }`
                );
                await Mongodb.getServersCollection()
                    .updateOne({ server }, { $set: { status: "error" } })
                    .catch(() => {});
            });
    } catch (error) {
        logger.error(
            `Error adding server service: ${(error as Error).message}`
        );
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to add service " + error });
        }
    }
});

router.post(
    "/transfer-server-ownership",
    authenticateToken,
    async (req, res) => {
        try {
            let operator = req.user?.username;
            let { server, newOwner } = req.body;
            if (!operator) {
                res.status(400).json({ error: "No operator found" });
                return;
            }
            if (!server || !newOwner) {
                res.status(400).json({ error: "Missing parameters" });
                return;
            }

            // check if newOwner exists
            let newOwnerDoc = await Mongodb.getUsersCollection().findOne({
                username: mongodbOperatorSelection(newOwner),
            });
            if (!newOwnerDoc) {
                res.status(404).json({ error: "New owner not found" });
                return;
            }

            // check if server exists and belongs to operator
            let serverDoc = await Mongodb.getServersCollection().findOne({
                server: server,
                operator: mongodbOperatorSelection(operator),
            });
            if (!serverDoc) {
                res.status(404).json({ error: "Server not found" });
                return;
            }

            await Mongodb.getServersCollection().updateOne(
                { server: server },
                { $set: { operator: newOwner } }
            );

            // Also transfer lite/bob nodes associated with it
            await Mongodb.getLiteNodeCollection().updateMany(
                { server: server },
                { $set: { operator: newOwner } }
            );
            await Mongodb.getBobNodeCollection().updateMany(
                { server: server },
                { $set: { operator: newOwner } }
            );

            await NodeService.pullServerLists();

            res.json({ message: "Server ownership transferred successfully" });
        } catch (error) {
            logger.error(
                `Error transferring server ownership: ${
                    (error as Error).message
                }`
            );
            res.status(500).json({
                error: "Failed to transfer server ownership " + error,
            });
        }
    }
);

router.post("/ttyd-credentials", authenticateToken, async (req, res) => {
    try {
        let { host } = req.body;
        let operator = req.user?.username;
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!host) {
            res.status(400).json({ error: "Missing host" });
            return;
        }

        let serverDoc = await Mongodb.getServersCollection().findOne({
            server: host,
            operator: mongodbOperatorSelection(operator),
        });
        if (!serverDoc) {
            res.status(404).json({ error: "Server not found" });
            return;
        }
        if (!serverDoc.ttyd) {
            res.status(404).json({
                error: "ttyd is not installed on this server. Run 'Install ttyd' from the Shell panel first.",
            });
            return;
        }

        res.json({
            host: serverDoc.server,
            port: serverDoc.ttyd.port,
            token: serverDoc.ttyd.token,
        });
    } catch (error) {
        logger.error(
            `Error fetching ttyd credentials: ${(error as Error).message}`
        );
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/update-server-note", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let { server, note } = req.body;
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!server) {
            res.status(400).json({ error: "No server specified" });
            return;
        }

        await Mongodb.getServersCollection().updateOne(
            { server: server, operator: mongodbOperatorSelection(operator) },
            { $set: { note: note } }
        );
        res.json({ message: "Server note updated successfully" });
    } catch (error) {
        logger.error(`Error updating server note: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to update server note " + error,
        });
    }
});

router.post("/set-server-bulk-skip", authenticateToken, async (req, res) => {
    try {
        let operator = req.user?.username;
        let { server, skip } = req.body as { server: string; skip: boolean };
        if (!operator) {
            res.status(400).json({ error: "No operator found" });
            return;
        }
        if (!server) {
            res.status(400).json({ error: "No server specified" });
            return;
        }

        await Mongodb.getServersCollection().updateOne(
            { server: server, operator: mongodbOperatorSelection(operator) },
            { $set: { skipBulkSelect: Boolean(skip) } }
        );
        res.json({ message: "Bulk-select preference updated successfully" });
    } catch (error) {
        logger.error(
            `Error setting server bulk-skip: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to set bulk-select preference " + error,
        });
    }
});

export default router;
