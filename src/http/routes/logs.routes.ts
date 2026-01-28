import express from "express";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";

const router = express.Router();

router.get(
    "/setup-logs",
    authenticateToken,
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

router.get(
    "/deploy-logs",
    authenticateToken,
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

router.get(
    "/command-logs",
    authenticateToken,
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

router.get("/stdout-command-log", async (req, res) => {
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

router.post(
    "/delete-command-log",
    authenticateToken,
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

router.post(
    "/delete-all-command-logs",
    authenticateToken,
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

export default router;
