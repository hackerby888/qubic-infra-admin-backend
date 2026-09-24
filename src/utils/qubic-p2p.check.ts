// Codec self-check: npx tsx src/utils/qubic-p2p.check.ts
import assert from "assert";
import { QubicP2P } from "./qubic-p2p.js";

const { buffer: tickInfoRequest, dejavu } = QubicP2P.encodePacket(QubicP2P.MessageType.REQUEST_CURRENT_TICK_INFO);
assert.deepStrictEqual([...tickInfoRequest.subarray(0, 4)], [8, 0, 0, 27]);
assert.strictEqual(tickInfoRequest.readUInt32LE(4), dejavu);
assert.notStrictEqual(dejavu, 0);

// Tick info reply split across three chunks
const tickInfoPayload = Buffer.alloc(16);
tickInfoPayload.writeUInt16LE(2, 0);
tickInfoPayload.writeUInt16LE(180, 2);
tickInfoPayload.writeUInt32LE(30_000_123, 4);
tickInfoPayload.writeUInt16LE(451, 8);
tickInfoPayload.writeUInt16LE(3, 10);
tickInfoPayload.writeUInt32LE(30_000_000, 12);
const tickInfoReply = QubicP2P.encodePacket(QubicP2P.MessageType.RESPOND_CURRENT_TICK_INFO, tickInfoPayload, 42).buffer;

const reader = new QubicP2P.PacketReader();
assert.deepStrictEqual(reader.push(tickInfoReply.subarray(0, 5)), []);
assert.deepStrictEqual(reader.push(tickInfoReply.subarray(5, 13)), []);
const [packet] = reader.push(tickInfoReply.subarray(13));
assert.strictEqual(packet!.type, 28);
assert.strictEqual(packet!.dejavu, 42);
assert.deepStrictEqual(QubicP2P.decodeTickInfo(packet!.payload), {
    tickDuration: 2,
    epoch: 180,
    tick: 30_000_123,
    alignedVotes: 451,
    misalignedVotes: 3,
    initialTick: 30_000_000,
});

// Two packets in one chunk, second one partial until the next push
const endResponse = QubicP2P.encodePacket(QubicP2P.MessageType.END_RESPONSE, undefined, 7).buffer;
const merged = Buffer.concat([endResponse, tickInfoReply]);
assert.strictEqual(reader.push(merged.subarray(0, 20)).length, 1);
assert.strictEqual(reader.push(merged.subarray(20)).length, 1);

// Size below the header is a protocol error
assert.throws(() => new QubicP2P.PacketReader().push(Buffer.from([4, 0, 0, 27, 0, 0, 0, 0])));

// Oversized header is rejected as soon as the header arrives, before any body is buffered
assert.throws(() => new QubicP2P.PacketReader().push(Buffer.from([0, 0, 0x40, 8, 0, 0, 0, 0])));

console.log("qubic-p2p codec OK");
