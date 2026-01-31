import express from "express";
import { Mongodb } from "../../database/db.js";
import { logger } from "../../utils/logger.js";
import type { IpInfo } from "../../utils/ip.js";
import { hashSHA256 } from "../../utils/crypto.js";
import { MapService } from "../../services/map-service.js";
import { Checkin } from "../../services/logic/checkin.js";

const router = express.Router();

router.post("/server-info-for-map", async (req, res) => {
    try {
        let servers = await Mongodb.getServersCollection()
            .find({}, { projection: { _id: 0, server: 1, ipInfo: 1 } })
            .toArray();

        let serverHash: Record<string, string> = {};
        for (let server of servers) {
            if (!serverHash[server.server]) {
                serverHash[server.server] = await hashSHA256(server.server);
            }
        }

        let responseServers: {
            server: string;
            lat: number;
            lon: number;
            isBM: boolean;
            isCheckinNode: boolean;
            type: string | undefined;
            lastCheckinAt: number | undefined;
        }[] = servers.map((s) => ({
            server: serverHash[s.server] as string,
            lat: s.ipInfo?.lat || 0,
            lon: s.ipInfo?.lon || 0,
            isBM: false,
            // checkin nodes specific field
            isCheckinNode: false,
            type: undefined,
            lastCheckinAt: undefined,
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
                continue;
            }

            responseServers.push({
                server: serverHash[bmNode] as string,
                lat: ipInfo.lat || 0,
                lon: ipInfo.lon || 0,
                isBM: true,
                isCheckinNode: false,
                type: undefined,
                lastCheckinAt: undefined,
            });
        }

        let checkinNodes: {
            ip: string;
            type: string; // "lite" | "bob"
            lastCheckinAt: number;
        }[] = await Checkin.getCheckins({
            normalized: true,
            epoch: 0, // latest epoch
        });

        // there is a case that per ip-type that operator change will cause multiple ips. we should discard older ones
        let checkinNodeMap: Record<string, { lastCheckinAt: number }> = {};
        for (let node of checkinNodes) {
            let key = `${node.ip}-${node.type}`;
            if (
                !checkinNodeMap[key] ||
                node.lastCheckinAt > checkinNodeMap[key].lastCheckinAt
            ) {
                checkinNodeMap[key] = { lastCheckinAt: node.lastCheckinAt };
            }
        }
        checkinNodes = checkinNodes.filter((node) => {
            let key = `${node.ip}-${node.type}`;
            return (
                checkinNodeMap[key] &&
                node.lastCheckinAt === checkinNodeMap[key].lastCheckinAt
            );
        });

        for (let node of checkinNodes) {
            // already added from either own servers or bmNodes
            if (serverHash[node.ip]) {
                continue;
            }
            let key = `${node.ip}-${node.type}`;
            if (!serverHash[key]) {
                serverHash[key] = await hashSHA256(node.ip);
            }
            let ipInfo: IpInfo = (await MapService.getIpInfoForServer(
                node.ip
            )) as IpInfo;

            if (!ipInfo) {
                continue;
            }

            responseServers.push({
                server: serverHash[key] as string,
                lat: ipInfo.lat || 0,
                lon: ipInfo.lon || 0,
                isBM: false,
                isCheckinNode: true,
                type: node.type,
                lastCheckinAt: node.lastCheckinAt,
            });
        }

        // make sure unique
        let uniqueServersMap: Record<string, (typeof responseServers)[0]> = {};
        responseServers.forEach((s) => {
            uniqueServersMap[s.server] = s;
        });
        responseServers = Object.values(uniqueServersMap);
        res.json({ servers: responseServers });
    } catch (error) {
        logger.error(
            `Error fetching server info for map: ${(error as Error).message}`
        );
        res.status(500).json({
            error: "Failed to fetch server info for map " + error,
        });
    }
});

export default router;
