import { Mongodb, type MongoDbTypes } from "../database/db.js";
import { isNodeActive } from "../utils/common.js";
import type { IpInfo } from "../utils/ip.js";
import { logger } from "../utils/logger.js";
import { calcGroupIdFromIds } from "../utils/node.js";
import { sleep } from "../utils/time.js";
import { SSHService } from "./ssh-service.js";

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

    export function getStatus() {
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

    export function getNetworkStatus() {
        let statuses = NodeService.getStatus();
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

            let allPromises = servers.map((server) =>
                getLiteNodeTickInfo(server.server)
            );
            let results = await Promise.all(allPromises);

            results.forEach((tickInfo, index) => {
                let serverObject =
                    _status.liteServers[servers[index]!.server as string];
                const serverIp = servers[index]!.server;
                if (tickInfo.tick !== -1 || !serverObject) {
                    let oldTick = serverObject?.tick || -1;
                    let operator = servers[index]?.operator || "unknown";
                    _status.liteServers[serverIp] = {
                        operator: operator,
                        ipInfo: _ipInfoCache[serverIp] || {},
                        tick: tickInfo.tick,
                        initialTick: tickInfo.initialTick,
                        epoch: tickInfo.epoch,
                        alignedVotes: tickInfo.alignedVotes,
                        misalignedVotes: tickInfo.misalignedVotes,
                        mainAuxStatus: tickInfo.mainAuxStatus,
                        groupId: servers[index]?.groupId || "",
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

                    if (
                        tickInfo.tick !== -1 &&
                        !isGotRunningIds[serverIp] &&
                        (!servers[index]!.groupId ||
                            servers[index]!.groupId === "")
                    ) {
                        // Try to get running IDs from the lite node
                        isGotRunningIds[serverIp] = true;
                        NodeService.tryGetIdsFromLiteNode(serverIp).then(
                            (ids) => {
                                let groupId = calcGroupIdFromIds(ids);
                                servers[index]!.groupId = groupId;
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
            });

            await sleep(IDLE_TIME);
        }
    }

    async function watchBobNodes() {
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

            // Fetch tick info for each server
            let allPromises = servers.map((server) =>
                getBobNodeTickInfo(server.server)
            );
            let results = await Promise.all(allPromises);

            results.forEach((tickInfo, index) => {
                let serverObject =
                    _status.bobServers[servers[index]?.server as string];
                if (tickInfo.currentFetchingTick !== -1 || !serverObject) {
                    let oldTick = serverObject?.currentFetchingTick || -1;
                    let operator = servers[index]?.operator || "unknown";
                    _status.bobServers[servers[index]?.server as string] = {
                        operator: operator,
                        ipInfo:
                            _ipInfoCache[servers[index]?.server as string] ||
                            {},
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

            await sleep(IDLE_TIME);
        }
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

            for (let node of [...liteServers, ...bobServers]) {
                if (!_ipInfoCache[node.server]) {
                    try {
                        let fullServerDoc =
                            await Mongodb.getServersCollection().findOne({
                                server: node.server,
                            });
                        if (fullServerDoc && fullServerDoc.ipInfo) {
                            _ipInfoCache[node.server] = fullServerDoc.ipInfo;
                        }
                    } catch (error) {
                        logger.error(
                            `Error fetching IP info for Lite Node ${
                                node.server
                            }: ${(error as Error).message}`
                        );
                    }
                }
            }

            _currentLiteNodes = liteServers.map((node) => ({ ...node }));
            _currentBobNodes = bobServers.map((node) => ({ ...node }));
            logger.info(
                `Pulled ${liteServers.length} Lite Nodes and ${bobServers.length} Bob Nodes from database`
            );
        } catch (error) {}
    }

    export function getRandomLiteNode(
        n: number,
        isNeedLoggingPasscode = false
    ) {
        let servers: MongoDbTypes.LiteNode[] = [..._currentLiteNodes];
        if (n >= servers.length) {
            return servers;
        }

        let selectedServers: MongoDbTypes.LiteNode[] = [];
        let usedIndices: Set<number> = new Set();

        const checkIsCandidateNode = (server: MongoDbTypes.LiteNode) => {
            if (isNeedLoggingPasscode) {
                return (
                    isNodeActive(
                        _status.liteServers[server.server]?.lastTickChanged || 0
                    ) &&
                    (!server.passcode || server.passcode.trim() === "0-0-0-0")
                );
            } else {
                return isNodeActive(
                    _status.liteServers[server.server]?.lastTickChanged || 0
                );
            }
        };

        let numberOfActiveNodes = servers.filter((server) =>
            checkIsCandidateNode(server)
        ).length;

        if (numberOfActiveNodes < n) {
            n = numberOfActiveNodes;
        }

        while (selectedServers.length < n) {
            let randomIndex = Math.floor(Math.random() * servers.length);
            if (
                !usedIndices.has(randomIndex) &&
                checkIsCandidateNode(servers[randomIndex]!)
            ) {
                usedIndices.add(randomIndex);
                selectedServers.push(servers[randomIndex]!);
            }
        }

        return selectedServers;
    }

    export function getRandomBobNode(n: number) {
        let servers: MongoDbTypes.BobNode[] = [..._currentBobNodes];
        if (n >= servers.length) {
            return servers;
        }

        let selectedServers: MongoDbTypes.BobNode[] = [];
        let usedIndices: Set<number> = new Set();

        const checkIsCandidateNode = (server: MongoDbTypes.BobNode) => {
            return isNodeActive(
                _status.bobServers[server.server]?.lastTickChanged || 0
            );
        };

        let numberOfActiveNodes = servers.filter((server) =>
            checkIsCandidateNode(server)
        ).length;

        if (numberOfActiveNodes < n) {
            n = numberOfActiveNodes;
        }

        while (selectedServers.length < n) {
            let randomIndex = Math.floor(Math.random() * servers.length);
            if (
                !usedIndices.has(randomIndex) &&
                checkIsCandidateNode(servers[randomIndex]!)
            ) {
                usedIndices.add(randomIndex);
                selectedServers.push(servers[randomIndex]!);
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
