import { Mongodb, MongoDbTypes, IS_NO_DB } from "../database/db.js";
import type { QueryPeersMode } from "../types/type.js";
import { isNodeActive } from "../utils/common.js";
import { Gmail } from "../utils/gmail.js";
import type { IpInfo } from "../utils/ip.js";
import { logger } from "../utils/logger.js";
import { calcGroupIdFromIds } from "../utils/node.js";
import { sleep } from "../utils/time.js";
import { Checkin } from "./logic/checkin.js";
import { SSHService } from "./ssh-service.js";
import * as geolib from "geolib";
import { isIPv4 } from "net";
import fs from "fs/promises";

namespace NodeService {
    const IDLE_TIME = 1000; // 1 second
    const DEFAULT_LITE_NODE_HTTP_PORT = 41841;
    const DEFAULT_BOB_NODE_HTTP_PORT = 40420;

    export interface LiteNodeTickInfo {
        operator: string;
        ipInfo: IpInfo | {};
        tick: number;
        epoch: number;
        alignedVotes: number;
        misalignedVotes: number;
        initialTick: number;
        lastUpdated: number;
        lastTickChanged: number;
        mainAuxStatus: number;
        groupId: string;
        isPrivate?: boolean;
        isSavingSnapshot: boolean;
    }

    export interface BobNodeTickInfo {
        operator: string;
        ipInfo: IpInfo | {};
        currentProcessingEpoch: number;
        currentFetchingTick: number;
        currentFetchingLogTick: number;
        currentVerifyLoggingTick: number;
        currentIndexingTick: number;
        initialTick: number;
        lastUpdated: number;
        lastTickChanged: number;
        bobVersion: string;
        isPrivate?: boolean;
    }

    interface LiteNodeExtended extends MongoDbTypes.LiteNode {
        ipInfo?: IpInfo;
    }

    interface BobNodeExtended extends MongoDbTypes.BobNode {
        ipInfo?: IpInfo;
    }

    let _ipInfoCache: { [ip: string]: IpInfo } = {};
    let _currentLiteNodes: LiteNodeExtended[] = [];
    let _currentBobNodes: BobNodeExtended[] = [];
    let _serverToOperatorMap: { [server: string]: string } = {};
    // IPs excluded from random-peers results (loaded from blacklisted_peers collection)
    let _blacklistedPeers: Set<string> = new Set();

    // NO_DB mode peer pools. File-seeded peers are permanent (admin-curated).
    // Runtime peers come from /checkin and are evictable once they fail liveness.
    const NO_DB_RUNTIME_CAP = 10_000;
    const NO_DB_EVICT_MS = 5 * 60 * 1000; // evict runtime peer if inactive 5min
    const NO_DB_SWEEP_MS = 30 * 1000;
    const _noDbFile: { lite: Set<string>; bob: Set<string> } = {
        lite: new Set(),
        bob: new Set(),
    };
    const _noDbRuntime: {
        lite: Map<string, number>; // ip -> addedAt
        bob: Map<string, number>;
    } = {
        lite: new Map(),
        bob: new Map(),
    };

    // NO_DB checkins mirror. Unbounded (acceptable: NO_DB is temp; restart clears it).
    const _noDbCheckins: MongoDbTypes.Checkin[] = [];

    export function addNoDbCheckin(doc: MongoDbTypes.Checkin): void {
        if (!IS_NO_DB) return;
        _noDbCheckins.push(doc);
    }

    export function getNoDbCheckins(): MongoDbTypes.Checkin[] {
        return _noDbCheckins;
    }

    function noDbAllPeers(type: "lite" | "bob"): string[] {
        return [..._noDbFile[type], ..._noDbRuntime[type].keys()];
    }

    async function loadNoDbSeed() {
        const path = `${process.cwd()}/data/peers.json`;
        try {
            const raw = await fs.readFile(path, "utf-8");
            const parsed = JSON.parse(raw) as {
                lite?: string[];
                bob?: string[];
            };
            (parsed.lite || []).forEach((ip) => {
                if (isIPv4(ip)) _noDbFile.lite.add(ip);
            });
            (parsed.bob || []).forEach((ip) => {
                if (isIPv4(ip)) _noDbFile.bob.add(ip);
            });
            logger.info(
                `🌱 NO_DB seed loaded: ${_noDbFile.lite.size} lite, ${_noDbFile.bob.size} bob (file)`
            );
        } catch (err: any) {
            logger.warn(
                `🌱 NO_DB seed not loaded (${err.message}); starting with empty pools`
            );
        }
    }

    export function addNoDbPeer(type: "lite" | "bob", ip: string): boolean {
        if (!IS_NO_DB) return false;
        if (!isIPv4(ip)) return false;
        if (_noDbFile[type].has(ip)) return false;
        const pool = _noDbRuntime[type];
        if (pool.has(ip)) return false;
        if (pool.size >= NO_DB_RUNTIME_CAP) return false;
        pool.set(ip, Date.now());
        logger.info(`🌱 NO_DB peer added (${type}, runtime): ${ip}`);
        return true;
    }

    async function watchAndEvictNoDbPeers() {
        while (true) {
            await sleep(NO_DB_SWEEP_MS);
            const now = Date.now();
            const evict = (type: "lite" | "bob") => {
                const pool = _noDbRuntime[type];
                const statusMap =
                    type === "lite"
                        ? _statusCheckin.liteServers
                        : _statusCheckin.bobServers;
                let removed = 0;
                for (const [ip, addedAt] of pool) {
                    const tick = statusMap[ip]?.lastTickChanged ?? 0;
                    const lastAlive = Math.max(tick, addedAt);
                    if (now - lastAlive > NO_DB_EVICT_MS) {
                        pool.delete(ip);
                        delete statusMap[ip];
                        removed++;
                    }
                }
                if (removed > 0) {
                    logger.info(
                        `🌱 NO_DB evicted ${removed} stale ${type} peer(s); ${pool.size} remain`
                    );
                }
            };
            evict("lite");
            evict("bob");
        }
    }

    let _status: {
        liteServers: {
            [server: string]: LiteNodeTickInfo;
        };
        bobServers: {
            [server: string]: BobNodeTickInfo;
        };
    } = {
        liteServers: {},
        bobServers: {},
    };
    let _statusCheckin: {
        liteServers: {
            [server: string]: LiteNodeTickInfo;
        };
        bobServers: {
            [server: string]: BobNodeTickInfo;
        };
    } = {
        liteServers: {},
        bobServers: {},
    };

    async function getLiteNodeTickInfo(
        server: string
    ): Promise<LiteNodeTickInfo> {
        const url = `http://${server}:${DEFAULT_LITE_NODE_HTTP_PORT}/tick-info`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch tick info from ${server}: ${response.statusText}`
                );
            }

            const data: LiteNodeTickInfo = await response.json();

            return data;
        } catch (error) {
            return {
                isSavingSnapshot: false,
                tick: -1,
                epoch: -1,
                alignedVotes: -1,
                misalignedVotes: -1,
                initialTick: -1,
                lastUpdated: -1,
                mainAuxStatus: -1,
                lastTickChanged: -1,
                groupId: "",
                operator: "",
                ipInfo: {},
            };
        }
    }

    async function getBobNodeTickInfo(
        server: string
    ): Promise<BobNodeTickInfo> {
        const url = `http://${server}:${DEFAULT_BOB_NODE_HTTP_PORT}/status`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch tick info from ${server}: ${response.statusText}`
                );
            }

            const data: BobNodeTickInfo = await response.json();

            return data;
        } catch (error) {
            return {
                operator: "",
                ipInfo: {},
                currentProcessingEpoch: -1,
                currentFetchingTick: -1,
                currentFetchingLogTick: -1,
                currentVerifyLoggingTick: -1,
                currentIndexingTick: -1,
                initialTick: -1,
                lastUpdated: -1,
                lastTickChanged: -1,
                bobVersion: "",
            };
        }
    }

    export function getLiteNodeInfo(server: string) {
        return _status.liteServers[server];
    }

    export function getSystemNodesStatus() {
        // Convert to array of server statuses
        let liteNodesStatus = Object.entries(_status.liteServers).map(
            ([server, info]) => ({
                server,
                region: "",
                ...info,
            })
        );

        let bobNodesStatus = Object.entries(_status.bobServers).map(
            ([server, info]) => ({
                server,
                region: "",
                ...info,
            })
        );

        let statuses = {
            liteNodes: liteNodesStatus,
            bobNodes: bobNodesStatus,
        };

        return statuses;
    }

    export function getCheckinNodesStatus() {
        // Convert to array of server statuses
        let liteNodesStatus = Object.entries(_statusCheckin.liteServers).map(
            ([server, info]) => ({
                server,
                region: "",
                ...info,
            })
        );

        let bobNodesStatus = Object.entries(_statusCheckin.bobServers).map(
            ([server, info]) => ({
                server,
                region: "",
                ...info,
            })
        );

        let statuses = {
            liteNodes: liteNodesStatus,
            bobNodes: bobNodesStatus,
        };

        return statuses;
    }

    export function getNetworkStatus() {
        let statuses = NodeService.getSystemNodesStatus();
        let currentTick = 0;
        let epoch = 0;
        for (let node of statuses.liteNodes) {
            if (node.tick > currentTick) {
                currentTick = node.tick;
                epoch = node.epoch;
            }
        }
        return { tick: currentTick, epoch };
    }

    export async function tryGetIdsFromLiteNode(
        server: string
    ): Promise<string[]> {
        const url = `http://${server}:${DEFAULT_LITE_NODE_HTTP_PORT}/running-ids`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let retries = 1000;
        while (retries > 0) {
            try {
                const response = await fetch(url, {
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (!response.ok) {
                    throw new Error(
                        `Failed to fetch running IDs from ${server}: ${response.statusText}`
                    );
                }

                const data: { runningIds: string[] } = await response.json();

                return data.runningIds;
            } catch (error) {
                retries--;
            }
        }

        return [];
    }

    // Single-shot running-ids fetch (no retry) for the periodic groupId refresh.
    async function fetchRunningIdsOnce(
        server: string,
        timeoutMs = 3000
    ): Promise<string[] | null> {
        const url = `http://${server}:${DEFAULT_LITE_NODE_HTTP_PORT}/running-ids`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) return null;
            const data: { runningIds: string[] } = await res.json();
            return Array.isArray(data.runningIds) ? data.runningIds : null;
        } catch {
            clearTimeout(timeout);
            return null;
        }
    }

    // Refresh ids+groupId for our system lite nodes every 10s, so cluster grouping
    // (used by Main failover) stays current when a node's running id set changes.
    async function watchAndRefreshGroupIds() {
        const REFRESH_INTERVAL_MS = 10_000;
        while (true) {
            try {
                const nodes = [..._currentLiteNodes]; // system nodes only
                await Promise.all(
                    nodes.map(async (node) => {
                        const server = node.server;
                        const status = _status.liteServers[server];
                        // only reachable system nodes
                        if (!status || status.tick === -1 || status.epoch === -1)
                            return;
                        const ids = await fetchRunningIdsOnce(server);
                        if (!ids) return; // unreachable/failed → keep existing
                        const groupId = calcGroupIdFromIds(ids);
                        if ((node.groupId || "") === groupId) return; // unchanged
                        node.ids = ids;
                        node.groupId = groupId;
                        if (_status.liteServers[server]) {
                            _status.liteServers[server].groupId = groupId;
                        }
                        await Mongodb.getLiteNodeCollection()
                            .updateOne({ server }, { $set: { ids, groupId } })
                            .catch(() => {});
                        logger.info(
                            `Refreshed groupId for ${server}: ${
                                groupId ? groupId.slice(0, 8) : "(none)"
                            }`
                        );
                    })
                );
            } catch (error) {
                logger.error(
                    `Error in watchAndRefreshGroupIds: ${
                        (error as Error).message
                    }`
                );
            }
            await sleep(REFRESH_INTERVAL_MS);
        }
    }

    async function watchLiteNodes() {
        const handleFetchAndUpdate = async (
            statusObject: {
                [server: string]: LiteNodeTickInfo;
            },
            servers: string[],
            serversLiteNodeDb?: MongoDbTypes.LiteNode[]
        ) => {
            let allPromises = servers.map((server) =>
                getLiteNodeTickInfo(server)
            );
            let results = await Promise.all(allPromises);

            results.forEach((tickInfo, index) => {
                let serverObject = statusObject[servers[index] as string];
                const serverIp = servers[index] as string;
                if (tickInfo.tick !== -1 || !serverObject) {
                    let oldTick = serverObject?.tick || -1;
                    let operator =
                        _serverToOperatorMap[servers[index] as string] ||
                        "unknown";
                    statusObject[serverIp] = {
                        operator: operator,
                        ipInfo: _ipInfoCache[serverIp] || {},
                        tick: tickInfo.tick,
                        initialTick: tickInfo.initialTick,
                        epoch: tickInfo.epoch,
                        alignedVotes: tickInfo.alignedVotes,
                        misalignedVotes: tickInfo.misalignedVotes,
                        mainAuxStatus: tickInfo.mainAuxStatus,
                        groupId: serversLiteNodeDb
                            ? serversLiteNodeDb[index]?.groupId || ""
                            : "",
                        isSavingSnapshot: Boolean(tickInfo.isSavingSnapshot),
                        lastUpdated:
                            tickInfo.tick !== -1
                                ? Date.now()
                                : serverObject?.lastUpdated || -1,
                        lastTickChanged:
                            oldTick !== tickInfo.tick
                                ? Date.now()
                                : serverObject?.lastTickChanged || -1,
                    };
                }
            });
        };

        const systemNodesProcessor = async () => {
            while (true) {
                let servers: MongoDbTypes.LiteNode[] = [..._currentLiteNodes];
                // Check removed node and delete them from status object
                if (
                    _status.liteServers &&
                    Object.keys(_status.liteServers).length > 0
                ) {
                    Object.keys(_status.liteServers).forEach((server) => {
                        if (!servers.some((s) => s.server === server)) {
                            delete _status.liteServers[server];
                        }
                    });
                }

                let startTime = Date.now();
                await handleFetchAndUpdate(
                    _status.liteServers,
                    servers.map((s) => s.server),
                    servers
                );
                logger.info(
                    `Updated and fetched tick info for ${servers.length} Lite Nodes (System) in ${Date.now() - startTime}ms`
                );

                await sleep(IDLE_TIME);
            }
        };

        const checkinNodesProcessor = async () => {
            while (true) {
                let liteNodesFromCheckins: { ip: string }[];
                if (IS_NO_DB) {
                    liteNodesFromCheckins = noDbAllPeers("lite").map((ip) => ({
                        ip,
                    }));
                } else {
                    liteNodesFromCheckins = await Checkin.getCheckins({
                        type: "lite",
                        normalized: true,
                        epoch: 0, // latest epoch
                    });
                }
                // filter out nodes that are already in system nodes to avoid duplication
                liteNodesFromCheckins = liteNodesFromCheckins.filter(
                    (c) =>
                        _currentLiteNodes.findIndex(
                            (s) => s.server === c.ip
                        ) === -1
                );
                let startTime = Date.now();
                await handleFetchAndUpdate(
                    _statusCheckin.liteServers,
                    liteNodesFromCheckins.map((c) => c.ip)
                );
                logger.info(
                    `Updated and fetched check-in info for ${liteNodesFromCheckins.length} Lite Nodes (Checkin) in ${Date.now() - startTime}ms`
                );

                await sleep(IDLE_TIME);
            }
        };

        systemNodesProcessor();
        checkinNodesProcessor();
    }

    async function watchBobNodes() {
        const handleFetchAndUpdate = async (
            statusObject: {
                [server: string]: BobNodeTickInfo;
            },
            servers: string[]
        ) => {
            // Fetch tick info for each server
            let allPromises = servers.map((server) =>
                getBobNodeTickInfo(server)
            );
            let results = await Promise.all(allPromises);

            results.forEach((tickInfo, index) => {
                let serverObject = statusObject[servers[index] as string];
                if (tickInfo.currentFetchingTick !== -1 || !serverObject) {
                    let oldTick = serverObject?.currentFetchingTick || -1;
                    let operator =
                        _serverToOperatorMap[servers[index] as string] ||
                        "unknown";
                    statusObject[servers[index] as string] = {
                        operator: operator,
                        ipInfo: _ipInfoCache[servers[index] as string] || {},
                        currentProcessingEpoch: tickInfo.currentProcessingEpoch,
                        currentFetchingTick: tickInfo.currentFetchingTick,
                        currentFetchingLogTick: tickInfo.currentFetchingLogTick,
                        currentVerifyLoggingTick:
                            tickInfo.currentVerifyLoggingTick,
                        currentIndexingTick: tickInfo.currentIndexingTick,
                        initialTick: tickInfo.initialTick,
                        lastUpdated:
                            tickInfo.currentFetchingTick !== -1
                                ? Date.now()
                                : serverObject?.lastUpdated || -1,
                        lastTickChanged:
                            oldTick !== tickInfo.currentFetchingTick
                                ? Date.now()
                                : serverObject?.lastTickChanged || -1,
                        bobVersion: tickInfo.bobVersion || "unknown",
                    };
                }
            });
        };

        const systemNodesProcessor = async () => {
            while (true) {
                let servers: MongoDbTypes.BobNode[] = [..._currentBobNodes];
                // Check removed node and delete them from status object
                if (
                    _status.bobServers &&
                    Object.keys(_status.bobServers).length > 0
                ) {
                    Object.keys(_status.bobServers).forEach((server) => {
                        if (!servers.some((s) => s.server === server)) {
                            delete _status.bobServers[server];
                        }
                    });
                }
                let startTime = Date.now();
                await handleFetchAndUpdate(
                    _status.bobServers,
                    servers.map((s) => s.server)
                );
                logger.info(
                    `Updated and fetched tick info for ${servers.length} Bob Nodes (System) in ${Date.now() - startTime}ms`
                );

                await sleep(IDLE_TIME);
            }
        };

        const checkinNodesProcessor = async () => {
            while (true) {
                let bobNodesFromCheckins: { ip: string }[];
                if (IS_NO_DB) {
                    bobNodesFromCheckins = noDbAllPeers("bob").map((ip) => ({
                        ip,
                    }));
                } else {
                    bobNodesFromCheckins = await Checkin.getCheckins({
                        type: "bob",
                        normalized: true,
                        epoch: 0, // latest epoch
                    });
                }
                // filter out nodes that are already in system nodes to avoid duplication
                bobNodesFromCheckins = bobNodesFromCheckins.filter(
                    (c) =>
                        _currentBobNodes.findIndex((s) => s.server === c.ip) ===
                        -1
                );
                let startTime = Date.now();
                await handleFetchAndUpdate(
                    _statusCheckin.bobServers,
                    bobNodesFromCheckins.map((c) => c.ip)
                );
                logger.info(
                    `Updated and fetched check-in info for ${bobNodesFromCheckins.length} Bob Nodes (Checkin) in ${Date.now() - startTime}ms`
                );

                await sleep(IDLE_TIME);
            }
        };

        systemNodesProcessor();
        checkinNodesProcessor();
    }

    export async function requestShutdownAllLiteNodes() {
        let servers: MongoDbTypes.LiteNode[] = [..._currentLiteNodes];
        let allPromises = servers.map((server) =>
            requestShudownLiteNode(server.server)
        );
        let results = await Promise.all(allPromises);

        let finalStatuses: { server: string; success: boolean }[] = [];
        results.forEach((success, index) => {
            finalStatuses.push({
                server: servers[index]?.server as string,
                success,
            });
        });

        return finalStatuses;
    }

    export async function requestShudownLiteNode(server: string) {
        const url = `http://${server}:${DEFAULT_LITE_NODE_HTTP_PORT}/shutdown`;

        try {
            const response = await fetch(url, { method: "POST" });
            if (!response.ok) {
                throw new Error(
                    `Failed to request shutdown from ${server}: ${response.statusText}`
                );
            }

            logger.info(`Shutdown request sent to ${server}`);
            return true;
        } catch (error) {
            logger.error(
                `Error requesting shutdown from ${server}: ${
                    (error as Error).message
                }`
            );
            return false;
        }
    }

    export async function pullServerLists() {
        try {
            let liteServers = await Mongodb.getLiteNodes();
            let bobServers = await Mongodb.getBobNodes();
            let allServers = (await Mongodb.getServersCollection()
                .find({})
                .toArray()) as MongoDbTypes.Server[];

            // update ip cache for system nodes
            for (let node of [...liteServers, ...bobServers]) {
                _serverToOperatorMap[node.server] = node.operator || "unknown";
            }

            let serversIpInfo: MongoDbTypes.ServerIpInfo[] =
                await Mongodb.getServerIpInfoCollection().find({}).toArray();
            serversIpInfo.forEach((doc) => {
                _ipInfoCache[doc.server] = doc.ipInfo;
            });

            _currentLiteNodes = liteServers
                .map((node) => ({ ...node }))
                .filter((node) => {
                    let serverDoc = allServers.find(
                        (s) => s.server === node.server
                    );
                    let services = serverDoc?.services || [];
                    let isLiteNode = services.includes(
                        MongoDbTypes.ServiceType.LiteNode
                    );

                    if (!isLiteNode) {
                        // remove from database if it's not a lite node
                        Mongodb.getLiteNodeCollection()
                            .deleteOne({ server: node.server })
                            .then(() => {
                                logger.info(
                                    `Removed ${node.server} from Lite Nodes collection as it's no longer a Lite Node`
                                );
                            })
                            .catch(() => {});
                    }

                    return isLiteNode;
                });
            _currentBobNodes = bobServers
                .map((node) => ({ ...node }))
                .filter((node) => {
                    let serverDoc = allServers.find(
                        (s) => s.server === node.server
                    );
                    let services = serverDoc?.services || [];
                    let isBobNode = services.includes(
                        MongoDbTypes.ServiceType.BobNode
                    );

                    if (!isBobNode) {
                        // remove from database if it's not a bob node
                        Mongodb.getBobNodeCollection()
                            .deleteOne({ server: node.server })
                            .then(() => {
                                logger.info(
                                    `Removed ${node.server} from Bob Nodes collection as it's no longer a Bob Node`
                                );
                            })
                            .catch(() => {});
                    }

                    return isBobNode;
                });

            logger.info(
                `Pulled ${liteServers.length} Lite Nodes and ${bobServers.length} Bob Nodes from database`
            );
        } catch (error) {}
    }

    export async function refreshBlacklistedPeers() {
        try {
            let docs = await Mongodb.getBlacklistedPeersCollection()
                .find({}, { projection: { ip: 1 } })
                .toArray();
            _blacklistedPeers = new Set(docs.map((d) => d.ip));
            logger.info(`Loaded ${_blacklistedPeers.size} blacklisted peers`);
        } catch (error) {
            logger.error(
                `Error loading blacklisted peers: ${(error as Error).message}`
            );
        }
    }

    export function isPeerBlacklisted(ip: string) {
        return _blacklistedPeers.has(ip);
    }

    export function getRandomLiteNode(
        n: number,
        {
            isNeedLoggingPasscode = false,
            mode = "random",
            clientIpInfo,
            filterOut = [],
            trustedNode = false,
        }: {
            isNeedLoggingPasscode?: boolean;
            mode?: QueryPeersMode;
            clientIpInfo?: IpInfo | null;
            filterOut?: string[];
            trustedNode?: boolean;
        } = {}
    ) {
        let servers: string[] = [];
        if (trustedNode) {
            servers = Object.keys(_status.liteServers).filter((server) => {
                return isNodeActive(
                    _status.liteServers[server]?.lastTickChanged || 0
                );
            });
        } else {
            servers = Object.keys(_statusCheckin.liteServers).filter(
                (server) => {
                    return isNodeActive(
                        _statusCheckin.liteServers[server]?.lastTickChanged || 0
                    );
                }
            );
        }

        // always exclude blacklisted peers from random-peers results
        servers = servers.filter((server) => !_blacklistedPeers.has(server));

        // filter out servers in filterOut list
        servers = servers.filter((server) => !filterOut.includes(server));

        if (n >= servers.length) {
            return servers;
        }

        let selectedServers: string[] = [];
        let usedIndices: Set<number> = new Set();

        // const checkIsCandidateNode = (server: string) => {
        //     if (isNeedLoggingPasscode) {
        //         return isNodeActive(
        //             _status.liteServers[server.server]?.lastTickChanged || 0
        //         );
        //         //  &&
        //         // (!server.passcode || server.passcode.trim() === "0-0-0-0")
        //     } else {
        //         return isNodeActive(
        //             _status.liteServers[server.server]?.lastTickChanged || 0
        //         );
        //     }
        // };

        let candidateServers = servers;
        let numberOfActiveNodes = candidateServers.length;

        if (numberOfActiveNodes < n) {
            n = numberOfActiveNodes;
        }

        let distanceMap: { server: string; distance: number }[] = [];
        if (mode === "closest" && clientIpInfo) {
            let serversWithoutIpInfo: string[] = [];
            candidateServers.forEach((server) => {
                let serverIpInfo = _ipInfoCache[server];
                if (serverIpInfo) {
                    let distance = geolib.getDistance(
                        {
                            latitude: clientIpInfo.lat,
                            longitude: clientIpInfo.lon,
                        },
                        {
                            latitude: serverIpInfo.lat,
                            longitude: serverIpInfo.lon,
                        }
                    );
                    distanceMap.push({ server: server, distance });
                } else {
                    serversWithoutIpInfo.push(server);
                }
            });

            // sort by distance
            distanceMap.sort((a, b) => a.distance - b.distance);

            // take top n closest nodes with known ipinfo
            selectedServers = distanceMap.slice(0, n).map((item) => item.server);

            // fill remaining slots with random peers lacking ipinfo
            let remaining = n - selectedServers.length;
            while (remaining > 0 && serversWithoutIpInfo.length > 0) {
                let idx = Math.floor(
                    Math.random() * serversWithoutIpInfo.length
                );
                selectedServers.push(serversWithoutIpInfo[idx]!);
                serversWithoutIpInfo.splice(idx, 1);
                remaining--;
            }

            return selectedServers;
        }

        // random mode, select random nodes from candidate servers
        while (selectedServers.length < n) {
            let randomIndex = Math.floor(
                Math.random() * candidateServers.length
            );
            if (!usedIndices.has(randomIndex)) {
                usedIndices.add(randomIndex);
                selectedServers.push(candidateServers[randomIndex]!);
            }
        }

        return selectedServers;
    }

    export function getRandomBobNode(
        n: number,
        {
            mode = "random",
            clientIpInfo,
            filterOut = [],
            trustedNode = false,
        }: {
            mode?: QueryPeersMode;
            clientIpInfo?: IpInfo | null;
            filterOut?: string[];
            trustedNode?: boolean;
        } = {}
    ) {
        let servers: string[] = [];
        if (trustedNode) {
            servers = Object.keys(_status.bobServers).filter((server) => {
                return isNodeActive(
                    _status.bobServers[server]?.lastTickChanged || 0
                );
            });
        } else {
            servers = Object.keys(_statusCheckin.bobServers).filter(
                (server) => {
                    return isNodeActive(
                        _statusCheckin.bobServers[server]?.lastTickChanged || 0
                    );
                }
            );
        }
        // always exclude blacklisted peers from random-peers results
        servers = servers.filter((server) => !_blacklistedPeers.has(server));

        if (n >= servers.length) {
            return servers;
        }

        servers = servers.filter((server) => !filterOut.includes(server));

        if (n >= servers.length) {
            return servers;
        }

        let selectedServers: string[] = [];
        let usedIndices: Set<number> = new Set();

        // const checkIsCandidateNode = (server: MongoDbTypes.BobNode) => {
        //     return isNodeActive(
        //         _status.bobServers[server.server]?.lastTickChanged || 0
        //     );
        // };

        let candidateServers = servers;
        let numberOfActiveNodes = candidateServers.length;

        if (numberOfActiveNodes < n) {
            n = numberOfActiveNodes;
        }

        let distanceMap: { server: string; distance: number }[] = [];
        if (mode === "closest" && clientIpInfo) {
            let serversWithoutIpInfo: string[] = [];
            candidateServers.forEach((server) => {
                let serverIpInfo = _ipInfoCache[server];
                if (serverIpInfo) {
                    let distance = geolib.getDistance(
                        {
                            latitude: clientIpInfo.lat,
                            longitude: clientIpInfo.lon,
                        },
                        {
                            latitude: serverIpInfo.lat,
                            longitude: serverIpInfo.lon,
                        }
                    );
                    distanceMap.push({ server: server, distance });
                } else {
                    serversWithoutIpInfo.push(server);
                }
            });

            // sort by distance
            distanceMap.sort((a, b) => a.distance - b.distance);

            // take top n closest nodes with known ipinfo
            selectedServers = distanceMap.slice(0, n).map((item) => item.server);

            // fill remaining slots with random peers lacking ipinfo
            let remaining = n - selectedServers.length;
            while (remaining > 0 && serversWithoutIpInfo.length > 0) {
                let idx = Math.floor(
                    Math.random() * serversWithoutIpInfo.length
                );
                selectedServers.push(serversWithoutIpInfo[idx]!);
                serversWithoutIpInfo.splice(idx, 1);
                remaining--;
            }

            return selectedServers;
        }

        while (selectedServers.length < n) {
            let randomIndex = Math.floor(
                Math.random() * candidateServers.length
            );
            if (!usedIndices.has(randomIndex)) {
                usedIndices.add(randomIndex);
                selectedServers.push(candidateServers[randomIndex]!);
            }
        }

        return selectedServers;
    }

    async function watchAndSaveSnapshot() {
        const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
        const WINDOW_SAVE_INTERVAL = 60 * 60 * 1000; // 1 hour

        let lastSaveTickMap: { [server: string]: number } = {};

        let numberOfNodesPerSave = 0;
        let currentPendingNodes: MongoDbTypes.Server[] = [];

        while (true) {
            try {
                // obtain operator cronjob to see if the save snapshot is enabled
                let isOperatorCronJobEnabledMap: {
                    [operator: string]: boolean;
                } = {};
                let operatorCronJobs = await Mongodb.getCronJobsCollection()
                    .find({
                        command: "auto-save-snapshot",
                    })
                    .toArray();
                for (let job of operatorCronJobs) {
                    isOperatorCronJobEnabledMap[job.operator] = job.isEnabled;
                }
                // select random `numberOfNodesPerSave` nodes from currentPendingNodes
                let nodesToSave: MongoDbTypes.Server[] = [];
                if (currentPendingNodes.length <= numberOfNodesPerSave) {
                    // set up
                    let liteNodes = [..._currentLiteNodes];
                    let liteNodesDbDocs = (await Mongodb.getServersCollection()
                        .find({})
                        .toArray()) as MongoDbTypes.Server[];
                    liteNodesDbDocs = liteNodesDbDocs.filter(
                        (doc) =>
                            doc.username &&
                            liteNodes.some((ln) => ln.server === doc.server)
                    );
                    liteNodesDbDocs = liteNodesDbDocs.filter(
                        (doc) => !!isOperatorCronJobEnabledMap[doc.operator]
                    );
                    numberOfNodesPerSave = Math.ceil(
                        liteNodesDbDocs.length /
                            (WINDOW_SAVE_INTERVAL / SAVE_INTERVAL)
                    );
                    // reset
                    nodesToSave = [...currentPendingNodes];
                    currentPendingNodes = [...liteNodesDbDocs];
                } else {
                    while (nodesToSave.length < numberOfNodesPerSave) {
                        let randomIndex = Math.ceil(
                            Math.random() * currentPendingNodes.length
                        );
                        nodesToSave.push(currentPendingNodes[randomIndex]!);
                        currentPendingNodes.splice(randomIndex, 1);
                    }
                }

                // Save snapshot for selected nodes
                for (let node of nodesToSave) {
                    let lastSaveTick = lastSaveTickMap[node.server] || 0;
                    let currentTick =
                        _status.liteServers[node.server]?.tick || 0;
                    if (currentTick - lastSaveTick > 676 * 2) {
                        if (isOperatorCronJobEnabledMap[node.operator]) {
                            SSHService.executeCommands(
                                node.server,
                                node.username,
                                node.password,
                                [
                                    `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[19~'`,
                                ],
                                60_000,
                                {
                                    sshPrivateKey: node.sshPrivateKey,
                                }
                            )
                                .then(() => {
                                    logger.info(
                                        `Snapshot command sent to ${node.server}`
                                    );
                                })
                                .catch(() => {});
                            lastSaveTickMap[node.server] =
                                _status.liteServers[node.server]?.tick || 0;
                        } else {
                            logger.info(
                                `Skipping snapshot for ${node.server}, cron job disabled`
                            );
                        }
                    } else {
                        logger.info(
                            `Skipping snapshot for ${node.server}, not enough ticks progressed`
                        );
                    }
                }
                await sleep(SAVE_INTERVAL);
            } catch (error) {
                logger.error(
                    `Error in watchAndSaveSnapshot: ${(error as Error).message}`
                );
            }
        }
    }

    const LAG_THRESHOLD_TICKS = 8;
    const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between repeat alerts for same node
    const lastAlertSentAt: Record<string, number> = {};
    const alertingNodes = new Set<string>();

    async function watchMainNode() {
        while (true) {
            try {
                const systemNodesStatus = NodeService.getSystemNodesStatus();
                const mainNodes = systemNodesStatus.liteNodes.filter(
                    (node) =>
                        (node.mainAuxStatus & 1) === 1 && node.epoch != -1
                );
                const systemTick = NodeService.getNetworkStatus().tick;
                const now = Date.now();
                const currentlyLagging = new Set<string>();

                for (const node of mainNodes) {
                    const behind = systemTick - node.tick;
                    if (behind > LAG_THRESHOLD_TICKS) {
                        currentlyLagging.add(node.server);
                        const last = lastAlertSentAt[node.server] || 0;
                        if (now - last >= ALERT_COOLDOWN_MS) {
                            logger.warn(
                                `Main node ${node.server} is lagging behind. System tick: ${systemTick}, Node tick: ${node.tick}`
                            );
                            lastAlertSentAt[node.server] = now;
                            alertingNodes.add(node.server);
                            Gmail.sendMainNodeLaggingEmail({
                                behindTicks: behind,
                                nodeIp: node.server,
                            });
                        }
                    }
                }

                for (const server of Array.from(alertingNodes)) {
                    if (!currentlyLagging.has(server)) {
                        alertingNodes.delete(server);
                        delete lastAlertSentAt[server];
                        logger.info(
                            `Main node ${server} has recovered (back in sync).`
                        );
                        Gmail.sendMainNodeRecoveredEmail({ nodeIp: server });
                    }
                }
            } catch (error) {
                logger.error(
                    `Error in watchMainNode: ${(error as Error).message}`
                );
            }
            await sleep(30_000);
        }
    }

    const TTYD_WATCHDOG_INTERVAL_MS = 60_000;
    const TTYD_DEFAULT_PORT = 7681;

    // Single self-contained shell snippet: probe ttyd's TLS port and only
    // restart (relaunch the screen session) if it's dead/unreachable. Kept on
    // one line because executeCommands writes each array entry as one shell
    // line. Wrapped in if/else so it always exits 0 — executeCommands prepends
    // `set -e`, and a failed /dev/tcp probe would otherwise kill the shell.
    // Mirrors the launch line in buildTtydInstallCommands (commands.routes.ts):
    // same binary path, cert paths and screen session name. Does NOT reinstall
    // — if the binary is gone we skip (that's an uninstall, not a crash).
    function buildTtydReviveCommand(token: string, port: number): string {
        return [
            `if bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}" 2>/dev/null; then`,
            `echo "ttyd-watchdog: OK :${port}";`,
            `elif [ ! -x /usr/local/bin/ttyd ]; then`,
            `echo "ttyd-watchdog: binary missing, skip";`,
            `else`,
            `for s in $(screen -ls | awk '/ttyd/ {print $1}'); do screen -S "$s" -X quit || true; done;`,
            `pkill -f /usr/local/bin/ttyd || true;`,
            `screen -dmS ttyd bash -lc "/usr/local/bin/ttyd -W -p ${port} -b /${token} -S -C /etc/ttyd-cert.pem -K /etc/ttyd-key.pem bash -l || exec bash";`,
            `sleep 2;`,
            `bash -c "exec 3<>/dev/tcp/127.0.0.1/${port}" 2>/dev/null && echo "ttyd-watchdog: RESTARTED :${port}" || echo "ttyd-watchdog: RESTART FAILED :${port}";`,
            `fi`,
        ].join(" ");
    }

    // Watchdog for the ttyd SSH-console server on each managed host. Restarts it
    // if the port is unreachable (process crashed, screen session died, OOM, etc.).
    async function watchTtydConsoles() {
        while (true) {
            try {
                const servers = (await Mongodb.getServersCollection()
                    .find({ ttyd: { $exists: true } })
                    .toArray()) as MongoDbTypes.Server[];

                await Promise.allSettled(
                    servers.map(async (s) => {
                        if (!s.ttyd?.token || !s.username) return;
                        const port = s.ttyd.port || TTYD_DEFAULT_PORT;
                        const res = await SSHService.executeCommands(
                            s.server,
                            s.username,
                            s.password,
                            [buildTtydReviveCommand(s.ttyd.token, port)],
                            60_000,
                            { sshPrivateKey: s.sshPrivateKey }
                        );
                        const out =
                            (res.stdouts["shell"] || "") +
                            (res.stderrs["shell"] || "");
                        if (out.includes("RESTART FAILED")) {
                            logger.error(
                                `ttyd watchdog: restart FAILED on ${s.server} (:${port})`
                            );
                        } else if (out.includes("RESTARTED")) {
                            logger.warn(
                                `ttyd watchdog: ttyd was down, restarted on ${s.server} (:${port})`
                            );
                        }
                    })
                );
            } catch (error) {
                logger.error(
                    `Error in watchTtydConsoles: ${(error as Error).message}`
                );
            }
            await sleep(TTYD_WATCHDOG_INTERVAL_MS);
        }
    }

    export interface MainNodeEvent {
        type: "promote" | "demote";
        server: string;
        groupId: string;
        operator: string;
        reason: string;
        tick: number;
        timestamp: number;
    }
    let _mainNodeEventCb: ((event: MainNodeEvent) => void) | null = null;
    // SocketServer registers here to relay promote/demote events to clients.
    export function onMainNodeEvent(cb: (event: MainNodeEvent) => void) {
        _mainNodeEventCb = cb;
    }

    const PROMOTE_WATCH_INTERVAL_MS = 3_000;
    const MAIN_UNHEALTHY_MS = 30_000; // unreachable or tick-frozen this long => down
    const GROUP_ACTION_COOLDOWN_MS = 120_000; // settle time after an action confirms before next decision
    const F12_RETRY_INTERVAL_MS = 20_000; // gap between F12 re-tries (F12 not guaranteed first try)
    const F12_MAX_ATTEMPTS = 5;
    const lastGroupActionAt: Record<string, number> = {};
    const promotedMainByGroup: Record<string, string> = {};
    // In-flight F12 actions awaiting confirmation (keyed by server). F12 is not
    // guaranteed to change mode on the first try, so we verify via tick-info and
    // re-send until the node reaches the desired mode (or attempts run out).
    interface PendingAction {
        desired: "main" | "aux";
        groupId: string;
        operator: string;
        reason: string;
        attempts: number;
        lastTryAt: number;
    }
    const pendingActions: Record<string, PendingAction> = {};

    // Keeps exactly one Main lite node per groupId. Promotes the most in-sync aux
    // (F12 = change mode) when a group has no healthy Main (Main down/crashed, or
    // group fully up but nobody flipped), and demotes extras down to one.
    async function watchAndPromoteMain() {
        while (true) {
            try {
                // operator opt-in (cron_jobs command "auto-promote-main")
                const operatorEnabled: Record<string, boolean> = {};
                const cronJobs = await Mongodb.getCronJobsCollection()
                    .find({ command: "auto-promote-main" })
                    .toArray();
                for (const job of cronJobs) {
                    operatorEnabled[job.operator] = job.isEnabled;
                }

                // SSH creds per managed node (tracking-only nodes have no username)
                const credsByServer: Record<
                    string,
                    {
                        username: string;
                        password: string;
                        sshPrivateKey: string;
                        operator: string;
                    }
                > = {};
                const serverDocs = (await Mongodb.getServersCollection()
                    .find({})
                    .toArray()) as MongoDbTypes.Server[];
                for (const doc of serverDocs) {
                    if (doc.username) {
                        credsByServer[doc.server] = {
                            username: doc.username,
                            password: doc.password,
                            sshPrivateKey: doc.sshPrivateKey,
                            operator: doc.operator,
                        };
                    }
                }

                const systemTick = NodeService.getNetworkStatus().tick;
                const now = Date.now();

                // group lite servers by groupId (skip ungrouped / default-id nodes)
                const groups: Record<string, string[]> = {};
                for (const [server, info] of Object.entries(
                    _status.liteServers
                )) {
                    if (!info.groupId) continue;
                    (groups[info.groupId] ||= []).push(server);
                }

                const isHealthy = (server: string) => {
                    const info = _status.liteServers[server];
                    if (!info) return false;
                    return (
                        info.epoch !== -1 &&
                        now - info.lastUpdated < MAIN_UNHEALTHY_MS &&
                        now - info.lastTickChanged < MAIN_UNHEALTHY_MS
                    );
                };
                const isMain = (server: string) =>
                    (_status.liteServers[server]!.mainAuxStatus & 1) === 1;
                const tickOf = (server: string) =>
                    _status.liteServers[server]?.tick || 0;

                const sendF12 = (server: string) => {
                    const creds = credsByServer[server];
                    if (!creds) return;
                    SSHService.executeCommands(
                        server,
                        creds.username,
                        creds.password,
                        [
                            `screen -S ${SSHService.LITE_SCREEN_NAME} -X stuff $'\\x1b[24~'`,
                        ],
                        60_000,
                        { sshPrivateKey: creds.sshPrivateKey }
                    )
                        .then(() =>
                            logger.info(`Sent F12 (change mode) to ${server}`)
                        )
                        .catch(() => {});
                };

                const startAction = (
                    server: string,
                    desired: "main" | "aux",
                    groupId: string,
                    reason: string
                ) => {
                    pendingActions[server] = {
                        desired,
                        groupId,
                        operator: credsByServer[server]?.operator || "",
                        reason,
                        attempts: 1,
                        lastTryAt: now,
                    };
                    sendF12(server);
                    logger.info(
                        `Group ${groupId}: F12 #1 to ${
                            desired === "main" ? "promote" : "demote"
                        } ${server}`
                    );
                };

                // Reconcile in-flight F12 actions: confirm via tick-info, retry, or give up.
                for (const [server, p] of Object.entries(pendingActions)) {
                    const info = _status.liteServers[server];
                    const isMainNow = info
                        ? (info.mainAuxStatus & 1) === 1
                        : false;
                    const reached =
                        !!info &&
                        info.epoch !== -1 &&
                        (p.desired === "main" ? isMainNow : !isMainNow);
                    if (reached) {
                        if (p.desired === "main")
                            promotedMainByGroup[p.groupId] = server;
                        lastGroupActionAt[p.groupId] = now;
                        delete pendingActions[server];
                        logger.info(
                            `Group ${p.groupId}: ${server} confirmed ${p.desired} after ${p.attempts} F12 attempt(s)`
                        );
                        _mainNodeEventCb?.({
                            type: p.desired === "main" ? "promote" : "demote",
                            server,
                            groupId: p.groupId,
                            operator: p.operator,
                            reason: p.reason,
                            tick: tickOf(server),
                            timestamp: now,
                        });
                        Gmail.sendMainNodeFailoverEmail({
                            type: p.desired === "main" ? "promote" : "demote",
                            server,
                            groupId: p.groupId,
                            reason: p.reason,
                            tick: tickOf(server),
                        });
                    } else if (now - p.lastTryAt >= F12_RETRY_INTERVAL_MS) {
                        if (p.attempts >= F12_MAX_ATTEMPTS) {
                            lastGroupActionAt[p.groupId] = now;
                            delete pendingActions[server];
                            logger.error(
                                `Group ${p.groupId}: F12 failed to set ${server} to ${p.desired} after ${p.attempts} attempts`
                            );
                        } else {
                            p.attempts++;
                            p.lastTryAt = now;
                            sendF12(server);
                            logger.info(
                                `Group ${p.groupId}: F12 #${p.attempts} retry to set ${server} to ${p.desired}`
                            );
                        }
                    }
                }

                for (const [groupId, members] of Object.entries(groups)) {
                    // don't make new decisions while an action for this group is unconfirmed
                    if (members.some((s) => pendingActions[s])) continue;
                    if (
                        now - (lastGroupActionAt[groupId] || 0) <
                        GROUP_ACTION_COOLDOWN_MS
                    ) {
                        continue;
                    }

                    const healthyMains = members.filter(
                        (s) => isMain(s) && isHealthy(s)
                    );
                    const downMains = members.filter(
                        (s) => isMain(s) && !isHealthy(s)
                    );
                    const candidateAux = members.filter(
                        (s) =>
                            !isMain(s) &&
                            isHealthy(s) &&
                            credsByServer[s] &&
                            operatorEnabled[credsByServer[s]!.operator]
                    );

                    if (healthyMains.length === 0 && candidateAux.length >= 1) {
                        // (a) failover: a Main existed and died; or
                        // (b) cold election: group fully up but no Main (forgot to flip)
                        const allHealthy = members.every((s) => isHealthy(s));
                        const shouldPromote =
                            downMains.length >= 1 ||
                            (downMains.length === 0 && allHealthy);
                        if (shouldPromote) {
                            const pick = [...candidateAux].sort((a, b) => {
                                const d = tickOf(b) - tickOf(a);
                                return d !== 0 ? d : a.localeCompare(b);
                            })[0]!;
                            const reason =
                                downMains.length >= 1
                                    ? "failover: previous Main down"
                                    : "elected: group had no Main";
                            logger.info(
                                `Group ${groupId}: no healthy Main (systemTick ${systemTick}); promoting ${pick} (tick ${tickOf(
                                    pick
                                )})`
                            );
                            startAction(pick, "main", groupId, reason);
                        }
                    } else if (healthyMains.length > 1) {
                        // enforce single Main: keep the promoted one (or highest tick),
                        // demote one other (prefer the recovered old Main)
                        const keep =
                            promotedMainByGroup[groupId] &&
                            healthyMains.includes(promotedMainByGroup[groupId]!)
                                ? promotedMainByGroup[groupId]!
                                : [...healthyMains].sort(
                                      (a, b) => tickOf(b) - tickOf(a)
                                  )[0]!;
                        const demotable = healthyMains.filter(
                            (s) =>
                                s !== keep &&
                                credsByServer[s] &&
                                operatorEnabled[credsByServer[s]!.operator]
                        );
                        if (demotable.length >= 1) {
                            const victim = demotable[0]!;
                            logger.info(
                                `Group ${groupId}: ${healthyMains.length} Mains; demoting ${victim}, keeping ${keep}`
                            );
                            startAction(
                                victim,
                                "aux",
                                groupId,
                                "enforce single Main per group"
                            );
                        }
                    }
                }
            } catch (error) {
                logger.error(
                    `Error in watchAndPromoteMain: ${(error as Error).message}`
                );
            }
            await sleep(PROMOTE_WATCH_INTERVAL_MS);
        }
    }

    export async function start() {
        if (IS_NO_DB) {
            await loadNoDbSeed();
        }
        await pullServerLists();
        await refreshBlacklistedPeers();
        watchLiteNodes();
        watchBobNodes();
        watchAndRefreshGroupIds();
        if (!IS_NO_DB) {
            watchAndSaveSnapshot();
            watchMainNode();
            watchAndPromoteMain();
            watchTtydConsoles();
        } else {
            watchAndEvictNoDbPeers();
            logger.info(
                "🌱 NO_DB: skipping watchAndSaveSnapshot, watchMainNode, watchAndPromoteMain"
            );
        }
    }
}

export { NodeService };
