import path from "path";
import { Client } from "ssh2";
import EventEmitter from "events";
import fs from "fs";
import { logger } from "../utils/logger.js";
import { Mongodb, MongoDbTypes } from "../database/db.js";
import stripAnsi from "strip-ansi";
import {
    getBasenameFromUrl,
    getUnzipCommandFromUrl,
    inlineBashCommands,
} from "../utils/common.js";

export namespace SSHService {
    export const LITE_SCREEN_NAME = "qubic";
    export const BOB_SCREEN_NAME = "bob";
    export const DEFAULT_BOB_CONFIG = {
        // Format: bob:ip:port
        "p2p-node": [],
        // Format: BM:ip:port:0-0-0-0 where 0-0-0-0 is the passcode
        "trusted-node": [],
        "request-cycle-ms": 500,
        "request-logging-cycle-ms": 150,
        "future-offset": 3,
        "log-level": "info",
        "keydb-url": "tcp://127.0.0.1:6379",
        "run-server": true,
        "server-port": 21842,
        "arbitrator-identity":
            "AFZPUAIYVPNUYGJRQVLUKOPPVLHAZQTGLYAAUUNBXFTVTAMSBKQBLEIEPCVJ",
        "trusted-entities": [
            "QCTBOBEPDEZGBBCSOWGBYCAIZESDMEVRGLWVNBZAPBIZYEJFFZSPPIVGSCVL",
        ],
        "node-seed": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "is-trusted-node": true,
        "tick-storage-mode": "free",
        "max-thread": 16,
        "spam-qu-threshold": 100,
    };

    let _isExecutingCommandsMap: {
        [key: string]: boolean;
    } = {};

    export let cleanUpSSHMap: {
        [key: string]: () => void;
    } = {};

    const Scripts = {
        GeneralSetupPath: path.resolve(
            process.cwd(),
            "src",
            "scripts",
            "general-setup.sh"
        ),

        getLiteNodeSetupScripts({
            binaryUrl,
            epochFile,
            peers,
            isRestart = false,
        }: {
            binaryUrl: string;
            epochFile: string;
            peers: string[];
            isRestart?: boolean;
        }) {
            // If isRestart is true, skip setup steps and just start the node with existing configs
            if (isRestart) {
                return [
                    `cd ~`,
                    `cd qlite`,
                    `CURRENT_PEERS=$(cat peers.txt)`,
                    `CURRENT_BINARY=$(cat binary_name.txt)`,
                    `screen -dmS ${LITE_SCREEN_NAME} bash -lc "./$CURRENT_BINARY -s 32 --peers $CURRENT_PEERS"`,
                ];
            }

            let peersString = peers.join(",");
            let binaryName = getBasenameFromUrl(binaryUrl);
            return [
                `date`,
                `cd ~`,
                `rm -rf qlite`,
                `mkdir -p qlite`,
                `cd qlite`,
                `wget ${binaryUrl}`,
                `chmod +x ./${binaryName}`,
                `wget ${epochFile}`,
                getUnzipCommandFromUrl(epochFile),
                // Save peers and binary name for future restarts
                `echo "${peersString}" > peers.txt`,
                `echo "${binaryName}" > binary_name.txt`,
                `CURRENT_PEERS=$(cat peers.txt)`,
                `CURRENT_BINARY=$(cat binary_name.txt)`,
                `screen -dmS ${LITE_SCREEN_NAME} bash -lc "./$CURRENT_BINARY -s 32 --peers $CURRENT_PEERS"`,
            ];
        },

        getBobNodeSetupScripts({
            binaryUrl,
            epochFile,
            peers,
            isRestart = false,
            systemRamInGB,
        }: {
            binaryUrl: string;
            epochFile: string;
            peers: string[];
            isRestart?: boolean;
            systemRamInGB: number;
        }) {
            const totalRamNeededInSystem = {
                liteNode: 40,
                bobNode: 6,
                system: 2,
            };
            let totalRamNeededForKeydbInGB =
                systemRamInGB -
                totalRamNeededInSystem.liteNode -
                totalRamNeededInSystem.bobNode -
                totalRamNeededInSystem.system;

            if (totalRamNeededForKeydbInGB < 12) {
                totalRamNeededForKeydbInGB = 12; // Minimum 12GB for keydb
            }
            // If isRestart is true, skip setup steps and just start the node with existing configs
            let binaryName = getBasenameFromUrl(binaryUrl);
            if (isRestart) {
                return [
                    `cd ~`,
                    `cd qbob`,
                    `CURRENT_BINARY=$(cat binary_name.txt)`,
                    `screen -dmS keydb bash -lc "keydb-server --maxmemory ${totalRamNeededForKeydbInGB}G --maxmemory-policy allkeys-lru"`,
                    `until [[ "$(keydb-cli ping 2>/dev/null)" == "PONG" ]]; do { echo "Waiting for keydb..."; sleep 1; }; done`,
                    `screen -dmS ${BOB_SCREEN_NAME} bash -lc "./$CURRENT_BINARY bob_config.json || exec bash"`,
                ];
            }

            let currentBobConfig = {
                ...DEFAULT_BOB_CONFIG,
                "p2p-node": peers
                    .filter((p) => p && p.startsWith("bob:"))
                    .map((p) => p.trim()),
                "trusted-node": peers
                    .filter((p) => p && p.startsWith("BM:"))
                    .map((p) => p.trim()),
            };
            return [
                `date`,
                `cd ~`,
                `rm -rf qbob`,
                `rm -rf /data/flash/db/*`,
                `mkdir -p /data/flash/db`,
                `mkdir -p qbob`,
                `cd qbob`,
                `wget ${binaryUrl}`,
                `chmod +x ./${binaryName}`,
                `wget ${epochFile}`,
                getUnzipCommandFromUrl(epochFile),
                // Write default config to config.json
                `echo '${JSON.stringify(currentBobConfig)}' > bob_config.json`,
                // Beautify the config file using jq
                `jq . bob_config.json > temp_config.json && mv temp_config.json bob_config.json`,
                `echo "${binaryName}" > binary_name.txt`,
                `CURRENT_BINARY=$(cat binary_name.txt)`,
                `screen -dmS keydb bash -lc "keydb-server --maxmemory ${totalRamNeededForKeydbInGB}G --maxmemory-policy allkeys-lru"`,
                `until [[ "$(keydb-cli ping 2>/dev/null)" == "PONG" ]]; do { echo "Waiting for keydb..."; sleep 1; }; done`,
                `screen -dmS ${BOB_SCREEN_NAME} bash -lc "./$CURRENT_BINARY bob_config.json || exec bash"`,
            ];
        },

        getShutdownCommands(
            type: MongoDbTypes.ServiceType,
            { killDb = false }: { killDb?: boolean } = {}
        ) {
            if (type === MongoDbTypes.ServiceType.LiteNode) {
                return [
                    `for s in $(screen -ls | awk '/${LITE_SCREEN_NAME}/ {print $1}'); do screen -S "$s" -X quit; done`,
                    `[ -d ~/qlite ] && [ -f ~/qlite/binary_name.txt ] && cd ~ && cd qlite && LITE_BINARY_NAME=$(cat binary_name.txt) && while pgrep -x $LITE_BINARY_NAME >/dev/null; do { echo "Waiting for litenode to be shutdown..."; sleep 1; }; done`,
                    `echo "Debug: LITE_BINARY_NAME=$LITE_BINARY_NAME"`,
                ];
            } else if (type === MongoDbTypes.ServiceType.BobNode) {
                let killDbCommands = [
                    `pkill -9 keydb-server || true`,
                    `for s in $(screen -ls | awk '/keydb/ {print $1}'); do screen -S "$s" -X quit || true; done`,
                    `while pgrep -x keydb-server >/dev/null; do { echo "Waiting for keydb to be shutdown..."; sleep 1; }; done`,
                ];
                return [
                    `for s in $(screen -ls | awk '/${BOB_SCREEN_NAME}/ {print $1}'); do screen -S "$s" -X quit || true; done`,
                    `[ -d ~/qbob ] && [ -f ~/qbob/binary_name.txt ] && cd ~ && cd qbob && BOB_BINARY_NAME=$(cat binary_name.txt) && while pgrep -x $BOB_BINARY_NAME >/dev/null; do { echo "Waiting for bobnode to be shutdown..."; sleep 1; }; done`,
                    ...(killDb ? killDbCommands : []),
                    `echo "Debug: BOB_BINARY_NAME=$BOB_BINARY_NAME"`,
                ];
            } else {
                return [];
            }
        },

        getRestartCommands(
            type: MongoDbTypes.ServiceType,
            {
                systemRamInGB,
            }: {
                systemRamInGB: number;
            }
        ) {
            if (type === MongoDbTypes.ServiceType.LiteNode) {
                let startCommands = this.getLiteNodeSetupScripts({
                    binaryUrl: "",
                    epochFile: "",
                    peers: [],
                    isRestart: true,
                });
                return [
                    this.getShutdownCommands(type).join("; "),
                    ...startCommands,
                ];
            } else if (type === MongoDbTypes.ServiceType.BobNode) {
                let startCommands = this.getBobNodeSetupScripts({
                    binaryUrl: "",
                    epochFile: "",
                    peers: [],
                    isRestart: true,
                    systemRamInGB: systemRamInGB,
                });
                return [
                    this.getShutdownCommands(type).join("; "),
                    ...startCommands,
                ];
            } else {
                return [];
            }
        },
    };

    const systemInfoCommands = {
        cpu: `grep -m 1 "model name" /proc/cpuinfo | awk -F': ' '{print $2}'`,
        os: `grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2 | tr -d '"'`,
        ram: `free -h | grep Mem | awk '{print $2}'`,
    };

    export async function _accquireExecutionLock(host: string) {
        while (_isExecutingCommandsMap[host]) {
            // Wait if there is an ongoing execution for the same host and username
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        _isExecutingCommandsMap[host] = true;
    }

    export async function _releaseExecutionLock(host: string) {
        _isExecutingCommandsMap[host] = false;
    }

    export function getSetupCommands() {
        try {
            let fullStringCommand: string;
            fullStringCommand = fs.readFileSync(
                Scripts.GeneralSetupPath,
                "utf-8"
            );
            return fullStringCommand
                .split("\n")
                .filter((line) => line.trim() !== "");
        } catch (error) {
            return [];
        }
    }

    export async function setupNode(
        host: string,
        username: string,
        password: string,
        sshPrivateKey: string
    ) {
        const commands = getSetupCommands();
        if (commands.length === 0) {
            return {
                stdouts: {},
                stderrs: {},
                isSuccess: false,
                cpu: "",
                os: "",
                ram: "",
                duration: 0,
            };
        }
        // NOTE: Using isNonInteractive to avoid issues with apt freeze the stdin
        let result = await executeCommands(
            host,
            username,
            password,
            [inlineBashCommands(commands)],
            0,
            {
                sshPrivateKey: sshPrivateKey,
                isNonInteractive: true,
            }
        );
        // To be able to map the outputs correctly, execute system info commands separately aka (isNonInteractive: true)
        let sysInfo = await executeCommands(
            host,
            username,
            password,
            Object.values(systemInfoCommands),
            0,
            {
                sshPrivateKey: sshPrivateKey,
                isNonInteractive: true,
            }
        );

        return {
            stdouts: result.stdouts,
            stderrs: result.stderrs,
            isSuccess: result.isSuccess,
            cpu:
                sysInfo.stdouts[systemInfoCommands.cpu]?.replaceAll("\n", "") ||
                "",
            os:
                sysInfo.stdouts[systemInfoCommands.os]?.replaceAll("\n", "") ||
                "",
            ram:
                sysInfo.stdouts[systemInfoCommands.ram]?.replaceAll("\n", "") ||
                "",
            duration: result.duration + sysInfo.duration,
        };
    }

    export async function shutdownNode(
        host: string,
        username: string,
        password: string,
        sshPrivateKey: string,
        type: MongoDbTypes.ServiceType
    ) {
        let commands: string[] = [];
        commands.push(Scripts.getShutdownCommands(type).join("; "));

        let result = await executeCommands(
            host,
            username,
            password,
            commands,
            0,
            {
                isNonInteractive: true,
                sshPrivateKey: sshPrivateKey,
            }
        );
        return {
            stdouts: result.stdouts,
            stderrs: result.stderrs,
            isSuccess: result.isSuccess,
            duration: result.duration,
        };
    }

    export async function restartNode(
        host: string,
        username: string,
        password: string,
        sshPrivateKey: string,
        type: MongoDbTypes.ServiceType,
        { systemRamInGB }: { systemRamInGB: number }
    ) {
        let commands: string[] = [];
        for (const cmd of Scripts.getRestartCommands(type, {
            systemRamInGB,
        })) {
            if (cmd && cmd?.trim() !== "") commands.push(cmd);
        }
        logger.info(`Restart commands for ${host}@${username}: ${commands}`);
        let result = await executeCommands(
            host,
            username,
            password,
            commands,
            0,
            {
                isNonInteractive: false,
                sshPrivateKey: sshPrivateKey,
            }
        );
        return {
            stdouts: result.stdouts,
            stderrs: result.stderrs,
            isSuccess: result.isSuccess,
            duration: result.duration,
        };
    }

    export async function deployNode(
        host: string,
        username: string,
        password: string,
        sshPrivateKey: string,
        type: MongoDbTypes.ServiceType,
        {
            binaryUrl,
            epochFile,
            peers,
            systemRamInGB,
        }: {
            binaryUrl: string;
            epochFile: string;
            peers: string[];
            systemRamInGB: number;
        }
    ) {
        const returnFailedObject: {
            stdouts: { [key: string]: string };
            stderrs: { [key: string]: string };
            isSuccess: boolean;
            duration: number;
        } = {
            stdouts: {},
            stderrs: {},
            isSuccess: false,
            duration: 0,
        };

        try {
            const commands = [];
            commands.push(
                ...Scripts.getShutdownCommands(type, { killDb: true })
            );

            if (type === MongoDbTypes.ServiceType.LiteNode) {
                commands.push(
                    ...Scripts.getLiteNodeSetupScripts({
                        binaryUrl,
                        epochFile,
                        peers,
                    })
                );
            } else if (type === MongoDbTypes.ServiceType.BobNode) {
                commands.push(
                    ...Scripts.getBobNodeSetupScripts({
                        binaryUrl,
                        epochFile,
                        peers,
                        systemRamInGB,
                    })
                );
            } else {
                return returnFailedObject;
            }

            let currentServer = await Mongodb.getServersCollection().findOne({
                server: host,
            });

            if (!currentServer) {
                return returnFailedObject;
            }

            await Mongodb.getServersCollection().updateOne(
                {
                    server: host,
                },
                {
                    $set: {
                        deployStatus: {
                            ...currentServer.deployStatus,
                            [type === MongoDbTypes.ServiceType.LiteNode
                                ? "liteNode"
                                : "bobNode"]: "setting_up",
                        },
                    },
                }
            );

            let result = await executeCommands(
                host,
                username,
                password,
                commands,
                0,
                {
                    sshPrivateKey: sshPrivateKey,
                }
            );
            return {
                stdouts: result.stdouts,
                stderrs: result.stderrs,
                isSuccess: result.isSuccess,
                duration: result.duration,
            };
        } catch (error) {
            return returnFailedObject;
        }
    }

    /**
     * executeCommands connects to a remote server via SSH and executes an array of commands.
     * @param host
     * @param username
     * @param password
     * @param commands array of commands to execute
     * @param timeout in millis seconds, 0 means no timeout
     * @returns
     */
    export async function executeCommands(
        host: string,
        username: string,
        password: string,
        commands: string[],
        timeout: number = 0,
        extraData: {
            onData?: (data: string) => void;
            isNonInteractive?: boolean;
            sshPrivateKey?: string;
        } = {}
    ) {
        let startTime = Date.now();
        await _accquireExecutionLock(host);

        let stdouts: {
            // command: output;
            [key: string]: string;
        } = {};
        let stderrs: {
            // command: error output;
            [key: string]: string;
        } = {};
        let isSuccess = false;

        commands.unshift("exec 2>&1"); // Redirect stderr to stdout
        commands.filter((cmd) => cmd && !cmd.trim().startsWith("#"));

        try {
            const emitter = new EventEmitter();
            const conn = new Client();
            logger.info(
                `Starting SSH command execution for ${host}@${username}...`
            );

            cleanUpSSHMap[host] = () => {
                try {
                    conn.end();
                } catch (error) {}
            };

            const handleOnData = (data: any, command?: string) => {
                const output = stripAnsi(data.toString());
                logger.info(`SSH Output: ${output}`);
                if (command) {
                    stdouts[command] = (stdouts[command] || "") + output;
                } else {
                    stdouts["shell"] = (stdouts["shell"] || "") + output;
                }

                if (extraData.onData) {
                    extraData.onData(output);
                }
            };

            const handleOnErrorData = (data: any, command?: string) => {
                const errorOutput = stripAnsi(data.toString());
                logger.error(`SSH Error Output: ${errorOutput}`);
                if (command) {
                    stderrs[command] = (stderrs[command] || "") + errorOutput;
                } else {
                    stderrs["shell"] = (stderrs["shell"] || "") + errorOutput;
                }
            };
            conn.on("ready", async () => {
                logger.info(
                    `SSH Connection ready for ${host}@${username}. Executing commands...`
                );
                if (!extraData.isNonInteractive) {
                    commands.unshift("set -e"); // Exit on error
                    commands.unshift("QDONE=qdone_signal");
                    commands.push(`echo "GETHERE@$QDONE"`);
                    const expectedDoneSignalStr = `GETHERE@qdone_signal`;
                    let isDoneSignalReceived = false;
                    conn.shell(
                        {
                            width: 640 * 3,
                            cols: 80 * 3,
                        },
                        (err, stream) => {
                            if (err) {
                                emitter.emit("error", err);
                                return;
                            }

                            stream
                                .on("close", () => {
                                    emitter.emit("done", {
                                        isDoneSignalReceived,
                                    });
                                })
                                .on("data", (data: any) => {
                                    // If the done signal is received, mark as done (no commands failed)
                                    if (
                                        data
                                            .toString()
                                            .includes(expectedDoneSignalStr)
                                    ) {
                                        isDoneSignalReceived = true;
                                    }
                                    handleOnData(data);
                                })
                                .stderr.on("data", (data) => {
                                    handleOnErrorData(data);
                                });

                            // Write commands to the shell
                            for (const command of commands) {
                                stream.write(command + "\n");
                            }
                            stream.end("exit\n");
                        }
                    );
                } else {
                    let totalExecuted = 0;
                    let isDoneSignalReceived = true;
                    for (const command of commands) {
                        try {
                            conn.exec(command, (err, stream) => {
                                if (err) {
                                    emitter.emit("error", err);
                                    return;
                                }
                                stream
                                    .on("close", (code: number) => {
                                        if (code !== 0) {
                                            isDoneSignalReceived = false;
                                        }
                                        totalExecuted += 1;
                                        if (totalExecuted === commands.length) {
                                            emitter.emit("done", {
                                                isDoneSignalReceived,
                                            });
                                        }
                                    })
                                    .on("data", (data: any) => {
                                        handleOnData(data, command);
                                    })
                                    .stderr.on("data", (data) => {
                                        handleOnErrorData(data, command);
                                    });
                            });
                        } catch (error) {
                            emitter.emit("error", error);
                            break;
                        }
                    }
                }
            }).on("error", (err) => {
                emitter.emit("error", err);
            });

            conn.connect({
                host: host,
                port: 22,
                username: username,
                password: password,
                privateKey: (extraData?.sshPrivateKey || "").replace(
                    /\\n/g,
                    "\n"
                ),
            });

            let isFinallyDone = false;

            // Timeout handling
            if (timeout > 0) {
                setTimeout(() => {
                    if (isFinallyDone) return;
                    emitter.emit("error", new Error("SSH command timeout"));
                }, timeout);
            }

            await new Promise<void>((resolve, reject) => {
                emitter.on("done", ({ isDoneSignalReceived }) => {
                    if (isFinallyDone) return;

                    if (cleanUpSSHMap[host]) {
                        cleanUpSSHMap[host]();
                    }
                    isSuccess = isDoneSignalReceived;
                    isFinallyDone = true;
                    resolve();
                    logger.info(
                        `SSH command execution for ${host}@${username} done.`
                    );
                });

                emitter.on("error", (error) => {
                    if (isFinallyDone) return;

                    if (cleanUpSSHMap[host]) {
                        cleanUpSSHMap[host]();
                    }
                    isSuccess = false;
                    isFinallyDone = true;
                    resolve();
                    logger.error(
                        `SSH command execution for ${host}@${username} error: ${error}`
                    );
                    stderrs["shell"] = (stderrs["shell"] || "") + error.message;
                });
            });
        } catch (error) {
            logger.error(
                `SSH command execution for ${host}@${username} error: ${error}`
            );
            stderrs["shell"] =
                (stderrs["shell"] || "") + (error as Error).message;
            isSuccess = false;
        }

        await _releaseExecutionLock(host);
        let endTime = Date.now();
        let durationInMillis = endTime - startTime;
        delete cleanUpSSHMap[host];
        return { stdouts, stderrs, isSuccess, duration: durationInMillis };
    }

    export async function startRequestExecuteCommandsProcessor() {
        // Currently, executeCommands is called directly in each API request handler.
        // If needed, implement a queue processor here to handle requests sequentially.
    }
}
