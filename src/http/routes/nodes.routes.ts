import express from "express";
import { NodeService } from "../../services/node-service.js";
import { Mongodb, MongoDbTypes } from "../../database/db.js";
import { SSHService } from "../../services/ssh-service.js";
import { logger } from "../../utils/logger.js";
import { authenticateToken } from "../middleware/auth.middleware.js";
import jwt from "jsonwebtoken";
import { hashSHA256 } from "../../utils/crypto.js";
import {
    getGlobalLiteCustomParameter,
    setGlobalLiteCustomParameter,
    mergeCustomParameter,
} from "../../utils/custom-parameter.js";

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
        let global = await getGlobalLiteCustomParameter();
        let machine = doc?.customParameter || "";
        res.json({
            customParameter: machine,
            global,
            effective: mergeCustomParameter(global, machine),
        });
    } catch (error) {
        logger.error(
            `Error getting custom parameter: ${(error as Error).message}`
        );
        res.status(500).json({ error: "Internal server error" });
    }
});

// Fleet-wide global lite-node custom parameter, used to prefill the bulk
// dialog. `value` is the stored global; `uniform` is always true (single
// canonical value). `total` is the node count in scope for messaging.
router.get(
    "/all-lite-nodes-custom-parameter",
    authenticateToken,
    async (req, res) => {
        try {
            let operator = req.user!.username;
            let serverDocs = await Mongodb.getServersCollection()
                .find({
                    services: MongoDbTypes.ServiceType.LiteNode,
                    ...(operator !== "admin" ? { operator } : {}),
                })
                .toArray();
            let serverNames = serverDocs.map((doc) => doc.server);

            // The bulk dialog edits the fleet-wide global parameter (merged with
            // each node's per-machine value at apply time), so there is a single
            // canonical value to prefill — always uniform.
            let global = await getGlobalLiteCustomParameter();

            res.json({
                value: global,
                uniform: true,
                total: serverNames.length,
            });
        } catch (error) {
            logger.error(
                `Error getting custom parameter for all lite nodes: ${
                    (error as Error).message
                }`
            );
            res.status(500).json({ error: "Internal server error" });
        }
    }
);

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

            // The DB stores only this machine's value; the on-disk file holds
            // the merged (global + machine) string the node actually starts
            // with. Write custom_parameter.txt now so the value is on disk
            // immediately (picked up on the next restart/redeploy). DB write is
            // authoritative; an SSH failure (e.g. node not yet deployed) is
            // non-fatal and only reported in the response.
            let global = await getGlobalLiteCustomParameter();
            let merged = mergeCustomParameter(global, customParameter);
            let written = false;
            try {
                let result = await SSHService.writeLiteNodeCustomParameter(
                    serverDoc.server,
                    serverDoc.username,
                    serverDoc.password,
                    serverDoc.sshPrivateKey,
                    merged
                );
                written = result.isSuccess;
            } catch (sshError) {
                logger.warn(
                    `Saved custom parameter for ${server} to DB but failed to write custom_parameter.txt on node: ${
                        (sshError as Error).message
                    }`
                );
            }

            res.json({
                message: written
                    ? "Custom parameter updated and written to node"
                    : "Custom parameter saved (will apply on next deploy/restart)",
                written,
            });
        } catch (error) {
            logger.error(
                `Error setting custom parameter: ${(error as Error).message}`
            );
            res.status(500).json({ error: "Internal server error" });
        }
    }
);

// Set the fleet-wide GLOBAL lite-node custom parameter. This does NOT touch
// any node's per-machine value — the two are merged (global + machine) at
// apply time. After storing the global we re-write custom_parameter.txt on the
// caller's in-scope nodes (admin = all) with the merged value so it lands on
// disk; it takes effect on each node's next restart/redeploy. SSH failures
// (e.g. node not deployed yet) are non-fatal and counted as skipped.
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

            // Store the global value (system-wide single setting).
            await setGlobalLiteCustomParameter(customParameter);

            let serverDocs = await Mongodb.getServersCollection()
                .find({
                    services: MongoDbTypes.ServiceType.LiteNode,
                    ...(operator !== "admin" ? { operator } : {}),
                })
                .toArray();
            let serverNames = serverDocs.map((doc) => doc.server);

            if (serverNames.length === 0) {
                res.json({
                    message: "Global custom parameter saved (no lite nodes to apply to)",
                    total: 0,
                    updated: 0,
                    skipped: 0,
                });
                return;
            }

            // Each node's per-machine value, to merge with the new global.
            let liteDocs = await Mongodb.getLiteNodeCollection()
                .find({ server: { $in: serverNames } })
                .toArray();
            let machineBy: Record<string, string> = {};
            for (let doc of liteDocs) {
                machineBy[doc.server] = doc.customParameter || "";
            }

            // Write the merged value to each node's custom_parameter.txt.
            let writtenCount = 0;
            await Promise.all(
                serverDocs.map(async (serverDoc) => {
                    if (!serverDoc.username) return;
                    let merged = mergeCustomParameter(
                        customParameter,
                        machineBy[serverDoc.server] ?? ""
                    );
                    try {
                        let result =
                            await SSHService.writeLiteNodeCustomParameter(
                                serverDoc.server,
                                serverDoc.username,
                                serverDoc.password,
                                serverDoc.sshPrivateKey,
                                merged
                            );
                        if (result.isSuccess) writtenCount++;
                    } catch (sshError) {
                        logger.warn(
                            `Saved global custom parameter but failed to write custom_parameter.txt on ${serverDoc.server}: ${
                                (sshError as Error).message
                            }`
                        );
                    }
                })
            );

            res.json({
                message: "Global custom parameter saved and applied",
                total: serverNames.length,
                updated: writtenCount,
                skipped: serverNames.length - writtenCount,
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
