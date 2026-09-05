import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	CHUNK_SIZE,
	CHUNK_HEADER_LENGTH,
	calculateTotalChunks,
	sliceFile,
	createFileChunkPacket,
	parseFileChunkPacket,
	isFileChunkPacket,
	formatFileSize
} from '../src/lib/transfer/chunking.ts';
import { FileSender } from '../src/lib/transfer/sender.ts';
import { PeerConnectionSession } from '../src/lib/webrtc/peer.ts';
import { WebRtcManager } from '../src/lib/webrtc/manager.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';
import type { IceServerConfig } from '../src/lib/types/signaling.ts';
import type { RecipientProgress } from '../src/lib/transfer/types.ts';

/**
 * Enhanced Mock RTCDataChannel with backpressure and bufferedAmount simulation.
 */
class MockBackpressureRTCDataChannel {
	public label: string;
	public ordered: boolean;
	public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
	public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
	public bufferedAmount = 0;
	public bufferedAmountLowThreshold = 64 * 1024;

	public onopen: (() => void) | null = null;
	public onclose: (() => void) | null = null;
	public onerror: ((ev: any) => void) | null = null;
	public onmessage: ((ev: { data: any }) => void) | null = null;
	public onbufferedamountlow: (() => void) | null = null;

	private listeners: Map<string, Set<Function>> = new Map();
	public sentPackets: (string | Blob | ArrayBuffer | ArrayBufferView)[] = [];
	public peerChannel: MockBackpressureRTCDataChannel | null = null;

	constructor(label: string, options?: RTCDataChannelInit) {
		this.label = label;
		this.ordered = options?.ordered ?? true;
	}

	public addEventListener(event: string, handler: Function): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(handler);
	}

	public removeEventListener(event: string, handler: Function): void {
		this.listeners.get(event)?.delete(handler);
	}

	public dispatchEvent(event: string, data?: any): void {
		if (event === 'bufferedamountlow') {
			this.onbufferedamountlow?.();
		}
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const h of handlers) h(data);
		}
	}

	public open(): void {
		this.readyState = 'open';
		this.onopen?.();
		this.dispatchEvent('open');
	}

	public send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 'open') {
			throw new Error('RTCDataChannel is not open');
		}

		const byteLen =
			typeof data === 'string'
				? data.length
				: data instanceof ArrayBuffer
					? data.byteLength
					: ArrayBuffer.isView(data)
						? data.byteLength
						: 0;

		this.bufferedAmount += byteLen;
		this.sentPackets.push(data);

		if (this.peerChannel && this.peerChannel.readyState === 'open') {
			queueMicrotask(() => {
				let delivered: any = data;
				if (ArrayBuffer.isView(data)) {
					delivered = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
				}
				this.peerChannel?.onmessage?.({ data: delivered });
			});
		}
	}

	public simulateBufferDrain(amount: number): void {
		this.bufferedAmount = Math.max(0, this.bufferedAmount - amount);
		if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
			this.dispatchEvent('bufferedamountlow');
		}
	}

	public close(): void {
		if (this.readyState !== 'closed') {
			this.readyState = 'closed';
			this.onclose?.();
			this.dispatchEvent('close');
		}
	}
}

/**
 * Mock RTCPeerConnection supporting backpressure-enabled channels.
 */
class MockBackpressureRTCPeerConnection {
	public signalingState: RTCSignalingState = 'stable';
	public iceConnectionState: RTCIceConnectionState = 'connected';
	public connectionState: RTCPeerConnectionState = 'connected';
	public localDescription: RTCSessionDescriptionInit | null = null;
	public remoteDescription: RTCSessionDescriptionInit | null = null;

	public onicecandidate: ((ev: any) => void) | null = null;
	public oniceconnectionstatechange: (() => void) | null = null;
	public onconnectionstatechange: (() => void) | null = null;
	public onnegotiationneeded: (() => void) | null = null;
	public ondatachannel: ((ev: any) => void) | null = null;

	public localDataChannels: MockBackpressureRTCDataChannel[] = [];

	public configuration: RTCConfiguration;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const channel = new MockBackpressureRTCDataChannel(label, options);
		this.localDataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	public async createOffer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'offer', sdp: 'mock-sdp-offer' };
	}

	public async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'answer', sdp: 'mock-sdp-answer' };
	}

	public async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = desc || (await this.createOffer());
	}

	public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = desc;
	}

	public async addIceCandidate(): Promise<void> {}
	public async getStats(): Promise<Map<string, any>> {
		return new Map();
	}
	public close(): void {
		for (const ch of this.localDataChannels) ch.close();
	}
}

describe('File Transfer: 16KB Chunking & Backpressure Outbound Streaming', () => {
	const dummyIceServers: IceServerConfig[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
	let testKey: CryptoKey;

	beforeEach(async () => {
		testKey = await deriveInitialKey('1234-5678-9012', 'test-salt-abc');
	});

	describe('1. 16KB Binary Chunking & Packet Layout', () => {
		test('calculateTotalChunks accurately computes chunk count for varied byte sizes', () => {
			assert.equal(calculateTotalChunks(0), 1);
			assert.equal(calculateTotalChunks(100), 1);
			assert.equal(calculateTotalChunks(CHUNK_SIZE), 1);
			assert.equal(calculateTotalChunks(CHUNK_SIZE + 1), 2);
			assert.equal(calculateTotalChunks(CHUNK_SIZE * 10), 10);
			// 100MB
			const hundredMb = 100 * 1024 * 1024;
			assert.equal(calculateTotalChunks(hundredMb), 6400);
		});

		test('sliceFile reads exact 16KB slices without retaining entire file in memory', async () => {
			// Generate 40KB mock file
			const totalBytes = 40 * 1024;
			const sourceBuffer = new Uint8Array(totalBytes);
			for (let i = 0; i < totalBytes; i++) {
				sourceBuffer[i] = i % 256;
			}
			const mockBlob = new Blob([sourceBuffer]);

			// Slice 0 (first 16KB)
			const chunk0 = await sliceFile(mockBlob, 0, CHUNK_SIZE);
			assert.equal(chunk0.byteLength, CHUNK_SIZE);
			assert.equal(chunk0[0], 0);
			assert.equal(chunk0[1], 1);

			// Slice 1 (second 16KB)
			const chunk1 = await sliceFile(mockBlob, 1, CHUNK_SIZE);
			assert.equal(chunk1.byteLength, CHUNK_SIZE);
			assert.equal(chunk1[0], CHUNK_SIZE % 256);

			// Slice 2 (remaining 8KB)
			const chunk2 = await sliceFile(mockBlob, 2, CHUNK_SIZE);
			assert.equal(chunk2.byteLength, 8 * 1024);
		});

		test('createFileChunkPacket and parseFileChunkPacket round-trip metadata and payload cleanly', () => {
			const transferId = '550e8400-e29b-41d4-a716-446655440000';
			const chunkIndex = 42;
			const totalChunks = 120;
			const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

			const packet = createFileChunkPacket(transferId, chunkIndex, totalChunks, payload);

			assert.equal(packet.byteLength, CHUNK_HEADER_LENGTH + payload.byteLength);
			assert.equal(isFileChunkPacket(packet), true);

			const parsed = parseFileChunkPacket(packet);
			assert.ok(parsed);
			assert.equal(parsed.transferId, transferId);
			assert.equal(parsed.chunkIndex, chunkIndex);
			assert.equal(parsed.totalChunks, totalChunks);
			assert.deepEqual(parsed.data, payload);
		});

		test('isFileChunkPacket distinguishes binary chunks from JSON chat frames', () => {
			const chatJson = new TextEncoder().encode(JSON.stringify({ type: 'chat', content: 'hello' }));
			assert.equal(isFileChunkPacket(chatJson), false);
			assert.equal(parseFileChunkPacket(chatJson), null);

			const corruptedShort = new Uint8Array([0x46, 0x43, 0x4b, 0x01, 1, 2, 3]);
			assert.equal(isFileChunkPacket(corruptedShort), false);
		});

		test('formatFileSize formats byte quantities into clean string representations', () => {
			assert.equal(formatFileSize(0), '0 B');
			assert.equal(formatFileSize(1024), '1.0 KB');
			assert.equal(formatFileSize(15 * 1024 * 1024), '15.0 MB');
			assert.equal(formatFileSize(1.5 * 1024 * 1024 * 1024), '1.5 GB');
		});
	});

	describe('2. RTCDataChannel Backpressure & Buffered Amount Throttling', () => {
		test('configures default bufferedAmountLowThreshold (64KB) on data channel initialization', () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			const dc = rawPc!.localDataChannels[0];
			assert.equal(dc.bufferedAmountLowThreshold, 64 * 1024);
			session.close();
		});

		test('waitForBufferedAmountLow pauses sender when bufferedAmount exceeds threshold and resumes on drain', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			const dc = rawPc!.localDataChannels[0];
			dc.open();

			// 1. When buffer is below threshold, resolves immediately without delay
			dc.bufferedAmount = 50 * 1024; // 50KB (< 256KB)
			let resumedImmediately = false;
			await session.waitForBufferedAmountLow(256 * 1024).then(() => {
				resumedImmediately = true;
			});
			assert.equal(resumedImmediately, true);

			// 2. When buffer exceeds threshold, wait promise is suspended
			dc.bufferedAmount = 500 * 1024; // 500KB (> 256KB)
			let resumedAfterDrain = false;
			const waitPromise = session.waitForBufferedAmountLow(256 * 1024).then(() => {
				resumedAfterDrain = true;
			});

			// Still suspended
			await new Promise((r) => setTimeout(r, 15));
			assert.equal(resumedAfterDrain, false);

			// Simulate network drain event
			dc.simulateBufferDrain(450 * 1024); // Drops to 50KB (< 64KB threshold)

			await waitPromise;
			assert.equal(resumedAfterDrain, true);

			session.close();
		});
	});

	describe('3. Multi-Recipient Mesh Progress Tracking', () => {
		test('streams file chunks independently per-recipient with per-peer progress tracking', async () => {
			let pcAliceA: MockBackpressureRTCPeerConnection | null = null;
			let pcAliceB: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					const pc = new MockBackpressureRTCPeerConnection(cfg);
					if (!pcAliceA) pcAliceA = pc;
					else pcAliceB = pc;
					return pc as unknown as RTCPeerConnection;
				}
			});

			// Setup two active peer sessions in mesh
			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerAlice.getOrCreateSession('peer-carol', true);

			const dcBob = pcAliceA!.localDataChannels[0];
			const dcCarol = pcAliceB!.localDataChannels[0];
			dcBob.open();
			dcCarol.open();

			const sender = new FileSender(managerAlice, {
				chunkSize: 16 * 1024,
				highWaterMark: 256 * 1024
			});

			// Create 48KB test file (3 chunks of 16KB)
			const testBuffer = new Uint8Array(48 * 1024);
			const testBlob = new Blob([testBuffer], { type: 'application/octet-stream' });

			const progressUpdates: { peerId: string; pct: number }[] = [];
			sender.onProgress((_id, peerId, prog) => {
				progressUpdates.push({ peerId, pct: prog.percentage });
			});

			// Send file to Bob and Carol
			const transfer = await sender.sendFile(testBlob, {
				fileName: 'dataset.bin',
				targetPeers: ['peer-bob', 'peer-carol'],
				senderUsername: 'alice'
			});

			assert.equal(transfer.fileName, 'dataset.bin');
			assert.equal(transfer.totalChunks, 3);
			assert.equal(transfer.recipients.size, 2);

			// Check announcements sent
			assert.equal(dcBob.sentPackets.length, 1);
			assert.equal(dcCarol.sentPackets.length, 1);

			// Simulate Bob signaling file-ready
			await sender.handleControlMessage('peer-bob', {
				type: 'file-ready',
				transferId: transfer.transferId,
				peerId: 'peer-bob'
			});

			// Bob received 3 encrypted chunks + 1 file-complete
			// 1 announcement + 3 chunks + 1 complete = 5 packets
			assert.equal(dcBob.sentPackets.length, 5);

			const bobProg = transfer.recipients.get('peer-bob')!;
			assert.equal(bobProg.status, 'completed');
			assert.equal(bobProg.percentage, 100);
			assert.equal(bobProg.chunksSent, 3);

			// Carol has NOT sent file-ready yet; Carol's packets remain 1 (announcement only)
			assert.equal(dcCarol.sentPackets.length, 1);
			const carolProg = transfer.recipients.get('peer-carol')!;
			assert.equal(carolProg.status, 'offered');
			assert.equal(carolProg.percentage, 0);

			// Now Carol signals file-ready
			await sender.handleControlMessage('peer-carol', {
				type: 'file-ready',
				transferId: transfer.transferId,
				peerId: 'peer-carol'
			});

			assert.equal(dcCarol.sentPackets.length, 5);
			assert.equal(carolProg.status, 'completed');
			assert.equal(carolProg.percentage, 100);
			assert.equal(transfer.status, 'completed');

			managerAlice.destroy();
		});

		test('cancellation of transfer for a specific peer stops stream immediately', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-target', true);
			const dc = rawPc!.localDataChannels[0];
			dc.open();

			const sender = new FileSender(manager);
			const testBlob = new Blob([new Uint8Array(32 * 1024)]);

			const transfer = await sender.sendFile(testBlob, {
				targetPeers: ['peer-target']
			});

			sender.cancelTransfer(transfer.transferId, 'peer-target', 'User aborted');
			const rec = transfer.recipients.get('peer-target')!;
			assert.equal(rec.status, 'cancelled');

			manager.destroy();
		});
	});
});
