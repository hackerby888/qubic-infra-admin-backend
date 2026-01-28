import express from "express";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import type { IpInfo } from "../../utils/ip.js";
import { hashSHA256 } from "../../utils/crypto.js";
import { MapService } from "../../services/map-service.js";

const router = express.Router();

router.post("/server-info-for-map", async (req, res) => {
    try {
        let servers = await Mongodb.getServersCollection()
            .find({}, { projection: { _id: 0, server: 1, ipInfo: 1 } })
            .toArray();

        let serverHash: Record<string, string> = {};
        for (let server of servers) {
            if (!serverHash[server.server]) {
                serverHash[server.server] = await hashSHA256(
                    server.server
                );
            }
        }

        let responseServers = servers.map((s) => ({
            server: serverHash[s.server] as string,
            lat: s.ipInfo?.lat || 0,
            lon: s.ipInfo?.lon || 0,
            isBM: false,
        }));

        let bmNodes = MapService.getBMNodes();

        for (let bmNode of bmNodes) {
            if (serverHash[bmNode]) {
                continue;
            }
            if (!serverHash[bmNode]) {
                serverHash[bmNode] = await hashSHA256(bmNode);
            }
            let ipInfo: IpInfo = (await MapService.getIpInfoForServer(
                bmNode
            )) as IpInfo;

            if (!ipInfo) {
                return;
            }

            responseServers.push({
                server: serverHash[bmNode] as string,
                lat: ipInfo.lat || 0,
                lon: ipInfo.lon || 0,
                isBM: true,
            });
        }

        // make sure unique
        let uniqueServersMap: Record<
            string,
            {
                server: string;
                lat: number;
                lon: number;
                isBM: boolean;
            }
        > = {};
        responseServers.forEach((s) => {
            uniqueServersMap[s.server] = s;
        });
        responseServers = Object.values(uniqueServersMap);
        res.json({ servers: responseServers });
    } catch (error) {
        logger.error(
            `Error fetching server info for map: ${
                (error as Error).message
            }`
        );
        res.status(500).json({
            error: "Failed to fetch server info for map " + error,
        });
    }
});

export default router;
