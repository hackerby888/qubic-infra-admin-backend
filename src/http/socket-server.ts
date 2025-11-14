import { Server, type Socket } from "socket.io";
import { logger } from "../utils/logger.js";
import { Mongodb, MongoDbTypes } from "../database/db.js";
import { SSHService } from "../services/ssh-service.js";
import { log } from "console";

declare module "socket.io" {
    interface Socket {
        host: string;
        service: MongoDbTypes.ServiceType;
    }
}

export namespace SocketServer {
    let io: Server;
    export function start(httpServer: any) {
        io = new Server(httpServer, {
            cors: { origin: "*" },
        });

        io.on("connection", (socket) => {
            socket.on(
                "subscribeToServiceLogs",
                async (data: {
                    service: MongoDbTypes.ServiceType;
                    host: string;
                }) => {
                    try {
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
                            (logData: string) => {
                                socket.emit("serviceLogUpdate", {
                                    service: data.service,
                                    log: logData,
                                });
                            }
                        );
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

            socket.on("disconnect", () => {
                if (!socket.host || !socket.service) return;
                logger.info(
                    `Socket ${socket.id} disconnected | data: ${socket.host}, ${socket.service}`
                );
                let cleanUpFunction = SSHService.cleanUpSSHMap[socket.host];
                if (cleanUpFunction) {
                    cleanUpFunction();
                }
                SSHService._releaseExecutionLock(socket.host);
                delete SSHService.cleanUpSSHMap[socket.host];
            });
        });
    }

    export function getIo(): Server {
        if (!io) {
            throw new Error("Socket.io server not initialized");
        }
        return io;
    }
}
