import { Server, Socket } from "socket.io";
import { createAdapter } from "@socket.io/mongo-adapter";
import { logger } from "../utils/logger.js";
import { Mongodb, MongoDbTypes, IS_NO_DB } from "../database/db.js";
import { SSHService } from "../services/ssh-service.js";
import { NodeService } from "../services/node-service.js";
import { sleep } from "../utils/time.js";
import WebSocket from "ws";

const ADAPTER_COLLECTION = "socket_io_adapter_events";

declare module "socket.io" {
    interface Socket {
        operator: string;
        host: string;
        service: MongoDbTypes.ServiceType;
        isSubscribedToLogs: boolean;
        isSubscribedToRealtimeStats: boolean;
        isSubscribedToBobLogs: boolean;
    }
}

export namespace SocketServer {
    let io: Server;
    let connectingRealtimeSockets: Set<Socket> = new Set();
    let connectingBobRealtimeLogSockets: { [key: string]: WebSocket } = {};
    // Lightweight channel for event notifications (promote/demote) — no stats stream.
    let notificationSockets: Set<Socket> = new Set();

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
                    let statuses = NodeService.getSystemNodesStatus();

                    if (socket.operator && socket.operator !== "admin") {
                        // Filter statuses by operator (get all nodes if admin)
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

        // Cross-instance broadcast (promote/demote events) via MongoDB change
        // streams (replica-set only). The 1s realtime stats loop stays per-socket
        // (local) — it must NOT go through the adapter or it would N-fold
        // duplicate. NO_DB / standalone uses the default in-memory adapter.
        if (!IS_NO_DB) {
            const collection = Mongodb.getDB().collection(ADAPTER_COLLECTION);
            collection
                .createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 })
                .catch(() => {});
            io.adapter(createAdapter(collection, { addCreatedAtField: true }));
            logger.info(
                "🔌 Socket.IO using MongoDB adapter (cross-instance broadcast)"
            );
        }

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
                                // Read-only long-lived stream → skip the
                                // distributed host lock so it can't block deploys.
                                passive: true,
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

            ///////////////// Register for event notifications /////////////////
            socket.on(
                "registerNotifications",
                (data: { operator?: string }) => {
                    if (data?.operator) socket.operator = data.operator;
                    notificationSockets.add(socket);
                    // Join rooms so the leader's promote/demote events reach this
                    // socket via the Mongo adapter even on another instance.
                    socket.join("notif:" + (socket.operator || ""));
                    if (socket.operator === "admin") socket.join("notif:admin");
                }
            );

            ///////////////// Subcribe to Bob Realtime Logs Proxy /////////////////
            socket.on(
                "subscribeToBobRealtimeLogs",
                (data: { bobHost: string; subscribeData: object }) => {
                    logger.info(
                        `Socket ${socket.id} subscribed to Bob realtime logs proxy at host: ${data.bobHost}`
                    );
                    let ws = new WebSocket(
                        `ws://${data.bobHost}:40420/ws/logs`
                    );

                    ws.onopen = () => {
                        ws.send(JSON.stringify(data.subscribeData));
                        connectingBobRealtimeLogSockets[socket.id] = ws;
                        logger.info(
                            `WebSocket connection established to Bob node at ${data.bobHost} for socket ${socket.id}`
                        );
                        socket.isSubscribedToBobLogs = true;
                    };

                    ws.onmessage = (event) => {
                        socket.emit("bobRealtimeLogUpdate", event.data);
                    };
                    ws.onerror = () => {
                        logger.error(
                            `WebSocket error on connection to Bob node at ${data.bobHost} for socket ${socket.id}`
                        );
                    };
                    ws.onclose = () => {
                        logger.info(
                            `WebSocket connection closed to Bob node at ${data.bobHost} for socket ${socket.id}`
                        );
                        socket.isSubscribedToBobLogs = false;
                        delete connectingBobRealtimeLogSockets[socket.id];
                    };
                }
            );

            socket.on(
                "unsubscribeFromBobRealtimeLogs",
                (data: { bobHost: string; unsubscribeData: object }) => {
                    logger.info(
                        `Socket ${socket.id} unsubscribed from Bob realtime logs proxy at host: ${data.bobHost}`
                    );
                    // close corresponding WebSocket connections
                    let ws = connectingBobRealtimeLogSockets[socket.id];
                    if (ws) {
                        ws.send(JSON.stringify({ action: "unsubscribeAll" }));
                        ws.close();
                    }
                }
            );

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

                notificationSockets.delete(socket);

                if (socket.isSubscribedToBobLogs) {
                    // close corresponding WebSocket connections
                    let ws = connectingBobRealtimeLogSockets[socket.id];
                    if (ws) {
                        ws.close();
                    }
                }
            });
        });

        NodeService.onMainNodeEvent((event) => {
            // Room emit fans out cluster-wide via the adapter: admins (notif:admin)
            // + that operator's sockets (notif:<operator>), de-duplicated by
            // Socket.IO across the two rooms.
            io.to("notif:admin")
                .to("notif:" + event.operator)
                .emit("mainNodeEvent", event);
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
