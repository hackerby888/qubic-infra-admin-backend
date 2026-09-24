import net from "net";
import { randomInt } from "crypto";

// Qubic p2p wire protocol. Lite core and bob share the header layout and message numbers.
export namespace QubicP2P {
    // Ports the random-peers consumers dial (core-bob NodeIntroducer hardcodes them)
    export const LITE_PORT = 21841;
    export const BOB_PORT = 21842;

    export const MessageType = {
        EXCHANGE_PUBLIC_PEERS: 0,
        BROADCAST_FUTURE_TICK_DATA: 8,
        REQUEST_COMPUTORS: 11,
        REQUEST_TICK_DATA: 16,
        REQUEST_CURRENT_TICK_INFO: 27,
        RESPOND_CURRENT_TICK_INFO: 28,
        END_RESPONSE: 35,
        TRY_AGAIN: 54,
    } as const;

    const HEADER_SIZE = 8;
    const MAX_PACKET_SIZE = 0xffffff;
    // Largest reply we ask for is tick data (139,384B); anything far bigger is a broken or hostile peer
    const MAX_RECEIVE_PACKET_SIZE = 256 * 1024;
    const TICK_INFO_SIZE = 16;
    const TICK_DATA_HEAD_SIZE = 8;

    const CONNECT_TIMEOUT_MS = 3_000;
    // Generous: a 139KB tick data reply over a ~300ms RTT link was measured at up to ~5s
    const REQUEST_TIMEOUT_MS = 10_000;

    export interface Packet {
        type: number;
        dejavu: number;
        payload: Buffer;
    }

    export interface TickInfo {
        tickDuration: number;
        epoch: number;
        tick: number;
        alignedVotes: number;
        misalignedVotes: number;
        initialTick: number;
    }

    // Header: u24 LE total size (header included), u8 type, u32 LE dejavu.
    // Dejavu must be fresh and nonzero: lite drops repeated packets, bob routes replies by dejavu.
    export function encodePacket(type: number, payload: Buffer = Buffer.alloc(0), dejavu = randomInt(1, 2 ** 32)) {
        const size = HEADER_SIZE + payload.length;
        if (size > MAX_PACKET_SIZE) {
            throw new Error(`Packet too large: ${size} bytes`);
        }

        const buffer = Buffer.alloc(size);
        buffer.writeUIntLE(size, 0, 3);
        buffer.writeUInt8(type, 3);
        buffer.writeUInt32LE(dejavu, 4);
        payload.copy(buffer, HEADER_SIZE);

        return { buffer, dejavu };
    }

    // Reassembles packets from a TCP byte stream that may split or merge them arbitrarily.
    export class PacketReader {
        private pending: Buffer = Buffer.alloc(0);

        // Returns every packet completed by this chunk. Throws on a malformed header.
        push(chunk: Buffer): Packet[] {
            this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;

            const packets: Packet[] = [];
            while (this.pending.length >= HEADER_SIZE) {
                const size = this.pending.readUIntLE(0, 3);
                if (size < HEADER_SIZE || size > MAX_RECEIVE_PACKET_SIZE) {
                    throw new Error(`Malformed packet size: ${size}`);
                }
                if (this.pending.length < size) {
                    break;
                }

                packets.push({
                    type: this.pending.readUInt8(3),
                    dejavu: this.pending.readUInt32LE(4),
                    payload: this.pending.subarray(HEADER_SIZE, size),
                });
                this.pending = this.pending.subarray(size);
            }

            return packets;
        }
    }

    interface Waiter {
        resolve: (packet: Packet) => void;
        reject: (error: Error) => void;
    }

    // One TCP connection to a node. Several requests can be in flight; replies are matched by dejavu.
    export class Connection {
        private readonly reader = new PacketReader();
        private readonly waiters = new Map<number, Waiter>();
        private closedError: Error | null = null;

        private constructor(private readonly socket: net.Socket) {
            socket.setNoDelay(true);
            socket.on("data", (chunk: Buffer) => this.onData(chunk));
            socket.on("error", (error) => this.fail(error));
            socket.on("close", () => this.fail(new Error("Connection closed")));
        }

        static open(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Connection> {
            return new Promise((resolve, reject) => {
                const socket = net.connect({ host, port });

                const onError = (error: Error) => {
                    clearTimeout(timer);
                    socket.destroy();
                    reject(error);
                };
                const timer = setTimeout(() => onError(new Error(`Connect to ${host}:${port} timed out after ${timeoutMs}ms`)), timeoutMs);

                socket.once("error", onError);
                socket.once("connect", () => {
                    clearTimeout(timer);
                    socket.removeListener("error", onError);
                    resolve(new Connection(socket));
                });
            });
        }

        // Resolves with the first packet echoing this request's dejavu, whatever its type.
        request(type: number, payload?: Buffer, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Packet> {
            if (this.closedError) {
                return Promise.reject(this.closedError);
            }

            const { buffer, dejavu } = encodePacket(type, payload);

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.waiters.delete(dejavu);
                    reject(new Error(`No reply to message type ${type} within ${timeoutMs}ms`));
                }, timeoutMs);

                this.waiters.set(dejavu, {
                    resolve: (packet) => {
                        clearTimeout(timer);
                        resolve(packet);
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        reject(error);
                    },
                });
                this.socket.write(buffer);
            });
        }

        close() {
            this.socket.destroy();
        }

        private onData(chunk: Buffer) {
            let packets: Packet[];
            try {
                packets = this.reader.push(chunk);
            } catch (error) {
                this.socket.destroy(error as Error);
                return;
            }

            for (const packet of packets) {
                // Unsolicited traffic (lite's peer exchange, computor requests) carries a foreign dejavu
                const waiter = this.waiters.get(packet.dejavu);
                if (!waiter) {
                    continue;
                }
                this.waiters.delete(packet.dejavu);
                waiter.resolve(packet);
            }
        }

        private fail(error: Error) {
            this.closedError ??= error;
            for (const waiter of this.waiters.values()) {
                waiter.reject(error);
            }
            this.waiters.clear();
        }
    }

    // Node answered TRY_AGAIN: its request queue is full. Alive, just busy.
    export class NodeBusyError extends Error {
        constructor() {
            super("Node busy (TRY_AGAIN)");
        }
    }

    function expectPacket(packet: Packet, type: number, minPayloadSize: number) {
        if (packet.type === MessageType.TRY_AGAIN) {
            throw new NodeBusyError();
        }
        if (packet.type !== type || packet.payload.length < minPayloadSize) {
            throw new Error(`Unexpected reply: type ${packet.type}, ${packet.payload.length} bytes (wanted type ${type})`);
        }
    }

    export function decodeTickInfo(payload: Buffer): TickInfo {
        return {
            tickDuration: payload.readUInt16LE(0),
            epoch: payload.readUInt16LE(2),
            tick: payload.readUInt32LE(4),
            alignedVotes: payload.readUInt16LE(8),
            misalignedVotes: payload.readUInt16LE(10),
            initialTick: payload.readUInt32LE(12),
        };
    }

    // All fields are zero while the node has no computor list yet. Bob reports its last verified tick.
    export async function requestTickInfo(connection: Connection): Promise<TickInfo> {
        const packet = await connection.request(MessageType.REQUEST_CURRENT_TICK_INFO);
        expectPacket(packet, MessageType.RESPOND_CURRENT_TICK_INFO, TICK_INFO_SIZE);

        return decodeTickInfo(packet.payload);
    }

    // Only the head of TickData is decoded; digests and fees are not needed by callers yet.
    // Null means END_RESPONSE: the tick is empty or the node does not hold it.
    export async function requestTickData(connection: Connection, tick: number): Promise<{ epoch: number; tick: number } | null> {
        const payload = Buffer.alloc(4);
        payload.writeUInt32LE(tick);

        const packet = await connection.request(MessageType.REQUEST_TICK_DATA, payload);
        if (packet.type === MessageType.END_RESPONSE) {
            return null;
        }
        expectPacket(packet, MessageType.BROADCAST_FUTURE_TICK_DATA, TICK_DATA_HEAD_SIZE);

        return {
            epoch: packet.payload.readUInt16LE(2),
            tick: packet.payload.readUInt32LE(4),
        };
    }

    // "busy" means the node answered TRY_AGAIN; callers should neither strike nor clear it.
    export type ProbeResult = "ok" | "no-tick-info" | "no-tick-data" | "busy";

    // Same check for lite and bob. Tick info is 24 bytes; tick data is ~139KB, so callers can skip it on most rounds.
    export async function probe(host: string, port: number, withTickData: boolean): Promise<ProbeResult> {
        let connection: Connection | null = null;
        try {
            connection = await Connection.open(host, port);

            let tickInfo: TickInfo;
            try {
                tickInfo = await requestTickInfo(connection);
            } catch (error) {
                return error instanceof NodeBusyError ? "busy" : "no-tick-info";
            }
            // All zeros: no computor list yet, the node cannot serve anything
            if (tickInfo.tick === 0) {
                return "no-tick-info";
            }
            if (!withTickData) {
                return "ok";
            }

            // Previous tick is stored on both node kinds, but never reach back past the epoch's first tick
            const tick = Math.max(tickInfo.tick - 1, tickInfo.initialTick);
            const tickData = await requestTickData(connection, tick);

            // END_RESPONSE (null) is a valid answer for an empty tick
            if (tickData === null || (tickData.tick === tick && tickData.epoch === tickInfo.epoch)) {
                return "ok";
            }
            return "no-tick-data";
        } catch (error) {
            if (error instanceof NodeBusyError) {
                return "busy";
            }
            return connection ? "no-tick-data" : "no-tick-info";
        } finally {
            connection?.close();
        }
    }
}
