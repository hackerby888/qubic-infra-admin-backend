import { Mongodb, MongoDbTypes } from "../database/db.js";
import type { QueryPeersMode } from "../types/type.js";
import { isNodeActive } from "../utils/common.js";
import type { IpInfo } from "../utils/ip.js";
import { logger } from "../utils/logger.js";
import { calcGroupIdFromIds } from "../utils/node.js";
import { sleep } from "../utils/time.js";
import { Checkin } from "./logic/checkin.js";
import { SSHService } from "./ssh-service.js";
import * as geolib from "geolib";

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

    async function watchLiteNodes() {
        const isGotRunningIds: { [server: string]: boolean } = {};

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

                    if (serversLiteNodeDb && serversLiteNodeDb[index]) {
                        if (
                            tickInfo.tick !== -1 &&
                            !isGotRunningIds[serverIp] &&
                            (!serversLiteNodeDb[index]!.groupId ||
                                serversLiteNodeDb[index]!.groupId === "")
                        ) {
                            // Try to get running IDs from the lite node
                            isGotRunningIds[serverIp] = true;
                            NodeService.tryGetIdsFromLiteNode(serverIp).then(
                                (ids) => {
                                    let groupId = calcGroupIdFromIds(ids);
                                    serversLiteNodeDb[index]!.groupId = groupId;
                                    Mongodb.getLiteNodeCollection()
                                        .updateOne(
                                            {
                                                server: serverIp,
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
                                }
                            );
                        }
                    }
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
                let liteNodesFromCheckins = await Checkin.getCheckins({
                    type: "lite",
                    normalized: true,
                    epoch: 0, // latest epoch
                });
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
                let bobNodesFromCheckins = await Checkin.getCheckins({
                    type: "bob",
                    normalized: true,
                    epoch: 0, // latest epoch
                });
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
                }
            });

            // sort by distance
            distanceMap.sort((a, b) => a.distance - b.distance);

            // return top n closest nodes that are active
            selectedServers = distanceMap.slice(0, n).map((item) => {
                return candidateServers.find((s) => s === item.server)!;
            });

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
                }
            });

            // sort by distance
            distanceMap.sort((a, b) => a.distance - b.distance);

            // return top n closest nodes that are active
            selectedServers = distanceMap.slice(0, n).map((item) => {
                return candidateServers.find((s) => s === item.server)!;
            });

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

    export async function start() {
        await pullServerLists();
        watchLiteNodes();
        watchBobNodes();
        watchAndSaveSnapshot();
    }
}

export { NodeService };
