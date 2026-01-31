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

router.post(
    "/change-visibility",
    authenticateToken,
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
