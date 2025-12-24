import { Server, Socket } from "socket.io";
import { logger } from "../utils/logger.js";
import { Mongodb, MongoDbTypes } from "../database/db.js";
import { SSHService } from "../services/ssh-service.js";
import { NodeService } from "../services/node-service.js";
import { sleep } from "../utils/time.js";

declare module "socket.io" {
    interface Socket {
        operator: string;
        host: string;
        service: MongoDbTypes.ServiceType;
        isSubscribedToLogs: boolean;
        isSubscribedToRealtimeStats: boolean;
    }
}

export namespace SocketServer {
    let io: Server;
    let connectingRealtimeSockets: Set<Socket> = new Set();

    async function watchAndbroadcastRealtimeStats() {
        while (true) {
            try {
                let liteNodesFromDb = await Mongodb.getLiteNodeCollection()
                    .find({})
                    .toArray();
                let bobNodesFromDb = await Mongodb.getBobNodeCollection()
                    .find({})
                    .toArray();

                for (const socket of connectingRealtimeSockets) {
                    let statuses = NodeService.getStatus();

                    if (socket.operator) {
                        // Filter statuses by operator
                        statuses.liteNodes = statuses.liteNodes.filter(
                            (status) => status.operator === socket.operator
                        );
                        statuses.bobNodes = statuses.bobNodes.filter(
                            (status) => status.operator === socket.operator
                        );
                    }

                    // If no operator is provided, filter out private nodes
                    if (!socket.operator) {
                        // Only return if isPrivate is false
                        statuses.liteNodes = statuses.liteNodes.filter(
                            (status) => {
                                let nodeDoc = liteNodesFromDb.find(
                                    (node) => node.server === status.server
                                );
                                return nodeDoc ? !nodeDoc.isPrivate : false;
                            }
                        );

                        statuses.bobNodes = statuses.bobNodes.filter(
                            (status) => {
                                let nodeDoc = bobNodesFromDb.find(
                                    (node) => node.server === status.server
                                );
                                return nodeDoc ? !nodeDoc.isPrivate : false;
                            }
                        );
                    }

                    statuses.liteNodes = true
                        ? statuses.liteNodes.map((status) => {
                              let nodeDoc = liteNodesFromDb.find(
                                  (node) => node.server === status.server
                              );
                              return {
                                  ...status,
                                  isPrivate: nodeDoc
                                      ? nodeDoc.isPrivate
                                      : false,
                              };
                          })
                        : [];
                    statuses.bobNodes = true
                        ? statuses.bobNodes.map((status) => {
                              let nodeDoc = bobNodesFromDb.find(
                                  (node) => node.server === status.server
                              );
                              return {
                                  ...status,
                                  isPrivate: nodeDoc
                                      ? nodeDoc.isPrivate
                                      : false,
                              };
                          })
                        : [];

                    socket.emit("realtimeStatsUpdate", statuses);
                }
            } catch (error: any) {
                logger.error(
                    `Error broadcasting realtime stats: ${error.message}`
                );
            }

            await sleep(1000); // 1 second interval
        }
    }

    export function start(httpServer: any) {
        io = new Server(httpServer, {
            cors: { origin: "*" },
        });

        io.on("connection", (socket) => {
            ///////////////// Subscribe to Service Logs /////////////////

            socket.on(
                "subscribeToServiceLogs",
                async (data: {
                    service: MongoDbTypes.ServiceType;
                    host: string;
                }) => {
                    try {
                        socket.isSubscribedToLogs = true;
                        socket.host = data.host;
                        socket.service = data.service;
                        logger.info(
                            `Socket ${socket.id} requested to subscribe to logs for service: ${data.service} on host: ${data.host}`
                        );

                        let serverDoc =
                            await Mongodb.getServersCollection().findOne({
                                server: data.host,
                            });
                        if (!serverDoc) {
                            logger.warn(
                                `Socket ${socket.id} attempted to subscribe to logs for unknown host: ${data.host}`
                            );
                            return;
                        }

                        let screenNameMap: Record<
                            MongoDbTypes.ServiceType,
                            string
                        > = {
                            liteNode: SSHService.LITE_SCREEN_NAME,
                            bobNode: SSHService.BOB_SCREEN_NAME,
                            null: "",
                        };

                        if (!screenNameMap[data.service]) {
                            return socket.disconnect(true);
                        }

                        SSHService.executeCommands(
                            serverDoc.server,
                            serverDoc.username,
                            serverDoc.password,
                            [`screen -r ${screenNameMap[data.service]} -d`],
                            0,
                            {
                                sshPrivateKey: serverDoc.sshPrivateKey,
                                onData: (logData: string) => {
                                    socket.emit("serviceLogUpdate", {
                                        service: data.service,
                                        log: logData,
                                    });
                                },
                            }
                        )
                            .then((result) => {
                                if (!result.isSuccess) {
                                    socket.emit("serviceLogUpdate", {
                                        service: data.service,
                                        log: `Error executing SSH commands: ${Object.values(
                                            result.stderrs
                                        ).join("\n")}\n`,
                                    });
                                }
                            })
                            .catch((error) => {
                                socket.emit("serviceLogUpdate", {
                                    service: data.service,
                                    log: `Error executing SSH commands: ${error.message}\n`,
                                });
                            });
                        logger.info(
                            `Socket ${socket.id} subscribed to logs for service: ${data.service}`
                        );
                    } catch (error) {
                        socket.disconnect(true);
                    }
                }
            );

            socket.on(
                "unsubscribeFromServiceLogs",
                (data: { service: string; host: string }) => {
                    if (socket.service !== data.service) return;
                    logger.info(
                        `Socket ${socket.id} unsubscribed from logs for service: ${data.service}`
                    );
                    let cleanUpFunction = SSHService.cleanUpSSHMap[socket.host];
                    if (cleanUpFunction) {
                        cleanUpFunction();
                    }
                    SSHService._releaseExecutionLock(socket.host);
                    delete SSHService.cleanUpSSHMap[socket.host];
                }
            );

            ///////////////// Subscribe to Realtime Stats /////////////////
            socket.on(
                "subscribeToRealtimeStats",
                (data: {
                    service: MongoDbTypes.ServiceType;
                    operator?: string;
                }) => {
                    logger.info(
                        `Socket ${socket.id} subscribed to realtime stats`
                    );
                    socket.service = data.service;
                    socket.operator = data.operator || "";
                    socket.isSubscribedToRealtimeStats = true;
                    connectingRealtimeSockets.add(socket);
                }
            );

            socket.on("unsubscribeFromRealtimeStats", () => {
                if (socket.isSubscribedToRealtimeStats) {
                    connectingRealtimeSockets.delete(socket);
                    socket.isSubscribedToRealtimeStats = false;
                    logger.info(
                        `Socket ${socket.id} unsubscribed from realtime stats | remaining connections: ${connectingRealtimeSockets.size}`
                    );
                }
            });

            socket.on("disconnect", () => {
                // clean up logs stuff
                if (
                    socket.host &&
                    socket.service &&
                    socket.isSubscribedToLogs
                ) {
                    logger.info(
                        `Socket ${socket.id} disconnected | data: ${socket.host}, ${socket.service}`
                    );
                    let cleanUpFunction = SSHService.cleanUpSSHMap[socket.host];
                    if (cleanUpFunction) {
                        cleanUpFunction();
                    }
                    SSHService._releaseExecutionLock(socket.host);
                    delete SSHService.cleanUpSSHMap[socket.host];
                }

                if (socket.isSubscribedToRealtimeStats) {
                    connectingRealtimeSockets.delete(socket);
                    logger.info(
                        `Socket ${socket.id} disconnected from realtime stats | remaining connections: ${connectingRealtimeSockets.size}`
                    );
                }
            });
        });

        watchAndbroadcastRealtimeStats();
    }

    export function getIo(): Server {
        if (!io) {
            throw new Error("Socket.io server not initialized");
        }
        return io;
    }
}
