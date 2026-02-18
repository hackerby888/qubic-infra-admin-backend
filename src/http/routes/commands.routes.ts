import express from "express";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { SSHService } from "../../services/ssh-service.js";
import { v4 as uuidv4 } from "uuid";
import { millisToSeconds } from "../../utils/time.js";

const router = express.Router();

// POST /command - Shutdown or restart services on servers
router.post("/command", authenticateToken, async (req, res) => {
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
        ).filter(
            (s) => s.username && s.username.length > 0 && s.status === "active"
        );

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

        const updateNodeDeployStatusToDb = ({
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
        const totalCommandsToExecute = services.length * serverDocs.length;

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
                                        Object.values(stderrs).join("\n");
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
                                    updateNodeDeployStatusToDb({
                                        server: serverObject.server,
                                        service: service,
                                        status: "stopped",
                                    });
                                } else {
                                    updateCommandLogToDb({
                                        stdout: Object.values(stdouts).join(
                                            "\n"
                                        ),
                                        stderr: Object.values(stderrs).join(
                                            "\n"
                                        ),
                                        status: "failed",
                                        duration: duration,
                                    });
                                    updateNodeDeployStatusToDb({
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
                            updateNodeDeployStatusToDb({
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
                    updateNodeDeployStatusToDb({
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
                            systemRamInGB: parseInt(serverObject.ram || "0"),
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
                                    updateNodeDeployStatusToDb({
                                        server: serverObject.server,
                                        service: service,
                                        status: "active",
                                    });
                                } else {
                                    currentStdout +=
                                        "\n" +
                                        `---------- Restart log for ${service} on ${serverObject.server} ----------- \n\n`;
                                    currentStdout +=
                                        Object.values(stdouts).join("\n");
                                    updateCommandLogToDb({
                                        stdout: currentStdout,
                                        stderr: currentStderr,
                                        status: "failed",
                                        duration: duration,
                                    });
                                    updateNodeDeployStatusToDb({
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
                            updateNodeDeployStatusToDb({
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

// POST /execute-command - Execute custom commands on servers
router.post("/execute-command", authenticateToken, async (req, res) => {
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
                    `while pgrep -x keydb-server >/dev/null; do { echo "Waiting for keydb to be shutdown..."; sleep 1; pkill -2 keydb-server || true; }; done`,
                    `for s in $(screen -ls | awk '/keydb/ {print $1}'); do screen -S "$s" -X quit || true; done`,
                    `screen -dmS keydb bash -lc "keydb-server /etc/keydb-runtime.conf || exec bash"`,
                    `until [[ "$(keydb-cli ping 2>/dev/null)" == "PONG" ]]; do { echo "Waiting for keydb..."; sleep 1; }; done`,
                ];
            },
            "restartkvrocks:bob": () => {
                return [
                    `while pgrep -x kvrocks >/dev/null; do { echo "Waiting for kvrocks to be shutdown..."; sleep 1; pkill -2 kvrocks || true; }; done`,
                    `for s in $(screen -ls | awk '/kvrocks/ {print $1}'); do screen -S "$s" -X quit || true; done`,
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
        ).filter(
            (s) => s.username && s.username.length > 0 && s.status === "active"
        );
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
        const updateCommandLogStatus = (status: MongoDbTypes.CommandStatus) => {
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
        const addErrorServersToCommandLog = async (errorServers: string[]) => {
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

                let params: string[] = command.split("::")[1]?.split(",") || [];

                // @ts-ignore
                commandsToBeExecuted = cmdFunc(...params);
                break;
            }
        }
        if (commandsToBeExecuted.length === 0) {
            commandsToBeExecuted = [command];
        }
        console.log("Commands to be executed:", commandsToBeExecuted);

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
                    let isAllDone = commandsExecuted === serverDocs.length;
                    if (result.isSuccess) {
                        databaseUpdater({
                            server: serverObject.server,
                            stdout: Object.values(result.stdouts).join("\n"),
                            stderr: Object.values(result.stderrs).join("\n"),
                            status: isAllDone ? "completed" : "pending",
                            duration: result.duration,
                        });
                    } else {
                        haveAtleastOneError = true;
                        errorServersList.push(serverObject.server);
                        databaseUpdater({
                            server: serverObject.server,
                            stdout: Object.values(result.stdouts).join("\n"),
                            stderr: Object.values(result.stderrs).join("\n"),
                            status: isAllDone ? "failed" : "pending",
                            duration: result.duration,
                        });
                    }
                    return result;
                })
                .then(() => {
                    // If all done, update the main command log status
                    if (commandsExecuted === serverDocs.length) {
                        updateCommandLogStatus(
                            haveAtleastOneError ? "failed" : "completed"
                        );
                        if (haveAtleastOneError) {
                            addErrorServersToCommandLog(errorServersList);
                        }
                    }
                })
                // never reached (just there for future)
                .catch((error) => {
                    haveAtleastOneError = true;
                    commandsExecuted++;
                    let isAllDone = commandsExecuted === serverDocs.length;
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
        logger.error(`Error executing command: ${(error as Error).message}`);
        res.status(500).json({
            error: "Failed to execute command " + error,
        });
    }
});

// GET /shortcut-commands - Get shortcut commands for the current operator
router.get("/shortcut-commands", authenticateToken, async (req, res) => {
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
            `Error fetching shortcut commands: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch shortcut commands " + error,
        });
    }
});

// POST /add-shortcut-command - Add a new shortcut command
router.post("/add-shortcut-command", authenticateToken, async (req, res) => {
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
            `Error adding shortcut command: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to add shortcut command " + error,
        });
    }
});

// DELETE /delete-shortcut-command - Delete a shortcut command
router.delete(
    "/delete-shortcut-command",
    authenticateToken,
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
                `Error deleting shortcut command: ${(error as Error).message}`
            );
            res.status(500).json({
                error: "Failed to delete shortcut command " + error,
            });
        }
    }
);

export default router;
