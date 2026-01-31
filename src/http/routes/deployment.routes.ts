import express from "express";
import { GithubService } from "../../services/github-service.js";
import { NodeService } from "../../services/node-service.js";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { SSHService } from "../../services/ssh-service.js";
import { checkLink } from "../../utils/common.js";
import { millisToSeconds } from "../../utils/time.js";
import { calcGroupIdFromIds } from "../../utils/node.js";

const router = express.Router();

router.get("/github-tags", (req, res) => {
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

router.post("/deploy", authenticateToken, async (req, res) => {
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
            if (server.status !== "active") continue;
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

router.post("/refresh-github-tags", async (req, res) => {
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

export default router;
