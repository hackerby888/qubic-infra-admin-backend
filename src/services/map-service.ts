import { Mongodb } from "../database/db.js";
import { lookupIp, type IpInfo } from "../utils/ip.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

namespace MapService {
    let queue: string[] = [];
    let ipcache: { [server: string]: IpInfo } = {};
    let bmNodes: Set<string> = new Set();

    export function enqueueServerForIpLookup(server: string) {
        if (!ipcache[server] && !queue.includes(server)) {
            queue.push(server);
        }
    }

    export async function getIpInfoForServer(
        server: string,
        enqueueIfNotFound: boolean = true
    ): Promise<IpInfo | null> {
        try {
            if (ipcache[server]) {
                return ipcache[server];
            }

            // obtain from database cache
            let ipInfoDoc = await Mongodb.getServerIpInfoCollection().findOne({
                server,
            });
            if (ipInfoDoc && ipInfoDoc.ipInfo) {
                ipcache[server] = ipInfoDoc.ipInfo;
                return ipInfoDoc.ipInfo;
            }

            if (enqueueIfNotFound) {
                enqueueServerForIpLookup(server);
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    export async function watchAndUpdateServerIpInfo() {
        setInterval(async () => {
            if (queue.length === 0) {
                return;
            }
            let server = queue.shift()!;
            try {
                let ipInfo = await lookupIp(server);
                if (ipInfo.country === "Unknown") {
                    throw new Error("Invalid IP info");
                }
                ipcache[server] = ipInfo;
                let serverIpInfoCollection =
                    Mongodb.getServerIpInfoCollection();
                await serverIpInfoCollection.updateOne(
                    { server },
                    {
                        $set: {
                            ipInfo,
                        },
                    },
                    { upsert: true }
                );
            } catch (error) {
                console.error(
                    `Failed to update IP info for server ${server}:`,
                    error
                );
                // Re-enqueue the server for retry
                queue.push(server);
            }
        }, 1000); // Process one server every 1 second
    }

    export async function watchAndUpdateBMNodes() {
        while (true) {
            try {
                let data: {
                    ipAddress: string;
                    currentTick: number;
                    lastChange: string;
                }[] = await fetch(
                    "https://api.qubic.li/public/peers?limit=1000"
                ).then((res) => res.json());

                let newBmNodes: Set<string> = new Set();
                data.forEach((node) => {
                    newBmNodes.add(node.ipAddress);
                    getIpInfoForServer(node.ipAddress, true);
                });
                bmNodes = newBmNodes;
                logger.info(
                    `🌐 MapService: Updated BM nodes list with ${bmNodes.size} entries.`
                );
            } catch (error: any) {
                logger.error(
                    `🌐 MapService: Failed to update BM nodes list:`,
                    error
                );
            }

            await sleep(10 * 60 * 1000); // every 10 minutes
        }
    }

    export function getBMNodes(): Set<string> {
        return bmNodes;
    }

    async function buildCacheFromDatabase() {
        let serverIpInfoCollection = Mongodb.getServerIpInfoCollection();
        let allDocs = await serverIpInfoCollection.find({}).toArray();
        allDocs.forEach((doc) => {
            if (doc.server && doc.ipInfo) {
                ipcache[doc.server] = doc.ipInfo;
            }
        });
        logger.info(
            `🌐 MapService: Loaded IP info for ${allDocs.length} servers from database cache.`
        );
    }

    export async function start() {
        await buildCacheFromDatabase();
        watchAndUpdateServerIpInfo();
        watchAndUpdateBMNodes();
        logger.info("🌐 MapService started.");
    }
}

export { MapService };
