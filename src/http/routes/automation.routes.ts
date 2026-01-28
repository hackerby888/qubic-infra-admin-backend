import express from "express";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import { hashSHA256 } from "../../utils/crypto.js";

const router = express.Router();

router.get(
    "/cron-jobs",
    authenticateToken,
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

router.post(
    "/cron-jobs",
    authenticateToken,
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

router.post(
    "/cron-jobs/update",
    authenticateToken,
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

router.delete(
    "/cron-jobs",
    authenticateToken,
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

export default router;
