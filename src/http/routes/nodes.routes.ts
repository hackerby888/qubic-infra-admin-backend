import express from "express";
import { NodeService } from "../../services/node-service.js";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import jwt from "jsonwebtoken";
import { hashSHA256 } from "../../utils/crypto.js";

const router = express.Router();

router.get("/servers-status", async (req, res) => {
    let operator = req.query.operator as string | undefined;
    let needPlainIp = req.query.plainIp === "true";
    let needAll = req.query.all === "true";
    let statuses = NodeService.getSystemNodesStatus();

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
    let bobNodesServer: string[] = statuses.bobNodes.map((node) => node.server);

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

router.get("/checkin-nodes-status", async (req, res) => {
    try {
        res.json(NodeService.getCheckinNodesStatus());
    } catch (error) {
        logger.error(
            `Error fetching checkin nodes status: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch checkin nodes status " + error,
        });
    }
});

router.get("/system-nodes-status", async (req, res) => {
    try {
        res.json(NodeService.getSystemNodesStatus());
    } catch (error) {
        logger.error(
            `Error fetching system nodes status: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch system nodes status " + error,
        });
    }
});

router.post("/change-visibility", authenticateToken, async (req, res) => {
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
        logger.error(`Error changing visibility: ${(error as Error).message}`);
        res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/lite-node-custom-parameter", authenticateToken, async (req, res) => {
    try {
        let server = req.query.server as string;
        if (!server) {
            res.status(400).json({ error: "Missing server" });
            return;
        }
        let doc = await Mongodb.getLiteNodeCollection().findOne({ server });
        res.json({ customParameter: doc?.customParameter || "" });
    } catch (error) {
        logger.error(
            `Error getting custom parameter: ${(error as Error).message}`
        );
        res.status(500).json({ error: "Internal server error" });
    }
});

router.post(
    "/set-lite-node-custom-parameter",
    authenticateToken,
    async (req, res) => {
        try {
            let operator = req.user!.username;
            let { server, customParameter } = req.body as {
                server: string;
                customParameter: string;
            };
            if (!server) {
                res.status(400).json({ error: "Missing server" });
                return;
            }
            if (typeof customParameter !== "string") {
                res.status(400).json({ error: "customParameter must be a string" });
                return;
            }

            // Verify the server belongs to the operator (or caller is admin)
            let serverDoc = await Mongodb.getServersCollection().findOne({
                server,
                ...(operator !== "admin" ? { operator } : {}),
            });
            if (!serverDoc) {
                res.status(404).json({ error: "Server not found" });
                return;
            }

            await Mongodb.getLiteNodeCollection().updateOne(
                { server },
                { $set: { customParameter } },
                { upsert: true }
            );
            res.json({ message: "Custom parameter updated successfully" });
        } catch (error) {
            logger.error(
                `Error setting custom parameter: ${(error as Error).message}`
            );
            res.status(500).json({ error: "Internal server error" });
        }
    }
);

// Apply one custom parameter to every lite node owned by the operator
// (admin = all lite nodes). Nodes whose stored value already equals the
// target are left untouched (no-op). DB write only — takes effect on each
// node's next deploy/restart, same as the per-machine endpoint.
router.post(
    "/set-all-lite-nodes-custom-parameter",
    authenticateToken,
    async (req, res) => {
        try {
            let operator = req.user!.username;
            let { customParameter } = req.body as {
                customParameter: string;
            };
            if (typeof customParameter !== "string") {
                res.status(400).json({ error: "customParameter must be a string" });
                return;
            }

            let serverDocs = await Mongodb.getServersCollection()
                .find({
                    services: MongoDbTypes.ServiceType.LiteNode,
                    ...(operator !== "admin" ? { operator } : {}),
                })
                .toArray();
            let serverNames = serverDocs.map((doc) => doc.server);

            if (serverNames.length === 0) {
                res.json({
                    message: "No lite nodes found",
                    total: 0,
                    updated: 0,
                    skipped: 0,
                });
                return;
            }

            // Figure out which nodes already hold the target value (no-op)
            // vs. which need writing.
            let liteDocs = await Mongodb.getLiteNodeCollection()
                .find({ server: { $in: serverNames } })
                .toArray();
            let existing: Record<string, string> = {};
            for (let doc of liteDocs) {
                existing[doc.server] = doc.customParameter || "";
            }
            let serversToUpdate = serverNames.filter(
                (server) => (existing[server] ?? "") !== customParameter
            );

            if (serversToUpdate.length > 0) {
                await Mongodb.getLiteNodeCollection().bulkWrite(
                    serversToUpdate.map((server) => ({
                        updateOne: {
                            filter: { server },
                            update: { $set: { customParameter } },
                            upsert: true,
                        },
                    }))
                );
            }

            res.json({
                message: "Custom parameter applied to all lite nodes",
                total: serverNames.length,
                updated: serversToUpdate.length,
                skipped: serverNames.length - serversToUpdate.length,
            });
        } catch (error) {
            logger.error(
                `Error setting custom parameter for all lite nodes: ${
                    (error as Error).message
                }`
            );
            res.status(500).json({ error: "Internal server error" });
        }
    }
);

router.get("/request-shudown", async (req, res) => {
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

router.get("/request-shutdown-all", async (req, res) => {
    let result = await NodeService.requestShutdownAllLiteNodes();
    res.json(result);
});

export default router;
