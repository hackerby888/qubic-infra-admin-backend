import { Mongodb, type MongoDbTypes } from "../database/db.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

namespace NodeService {
    const IDLE_TIME = 1000; // 1 second
    const DEFAULT_LITE_NODE_HTTP_PORT = 41841;
    const DEFAULT_BOB_NODE_HTTP_PORT = 40420;

    export interface LiteNodeTickInfo {
        operator: string;
        tick: number;
        epoch: number;
        alignedVotes: number;
        misalignedVotes: number;
        initialTick: number;
        lastUpdated: number;
        lastTickChanged: number;
    }

    export interface BobNodeTickInfo {
        operator: string;
        currentProcessingEpoch: number;
        currentFetchingTick: number;
        currentFetchingLogTick: number;
        currentVerifyLoggingTick: number;
        currentIndexingTick: number;
        initialTick: number;
        lastUpdated: number;
        lastTickChanged: number;
    }

    let _currentLiteNodes: MongoDbTypes.LiteNode[] = [];
    let _currentBobNodes: MongoDbTypes.BobNode[] = [];

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

    async function getLiteNodeTickInfo(server: string) {
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
                tick: -1,
                epoch: -1,
                alignedVotes: -1,
                misalignedVotes: -1,
                initialTick: -1,
                lastUpdated: -1,
                lastTickChanged: -1,
            };
        }
    }

    async function getBobNodeTickInfo(server: string) {
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
                currentProcessingEpoch: -1,
                currentFetchingTick: -1,
                currentFetchingLogTick: -1,
                currentVerifyLoggingTick: -1,
                currentIndexingTick: -1,
                initialTick: -1,
                lastUpdated: -1,
                lastTickChanged: -1,
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

    async function watchLiteNodes() {
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
                if (tickInfo.tick !== -1 || !serverObject) {
                    let oldTick = serverObject?.tick || -1;
                    let operator = servers[index]?.operator || "unknown";
                    _status.liteServers[servers[index]?.server as string] = {
                        operator: operator,
                        tick: tickInfo.tick,
                        initialTick: tickInfo.initialTick,
                        epoch: tickInfo.epoch,
                        alignedVotes: tickInfo.alignedVotes,
                        misalignedVotes: tickInfo.misalignedVotes,
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

            _currentLiteNodes = liteServers.map((node) => ({ ...node }));
            _currentBobNodes = bobServers.map((node) => ({ ...node }));
            console.log("✅ Pulled server lists from database");
            console.log(_currentLiteNodes);
            console.log(_currentBobNodes);
        } catch (error) {}
    }

    export async function start() {
        await pullServerLists();
        watchLiteNodes();
        watchBobNodes();
    }
}

export { NodeService };
