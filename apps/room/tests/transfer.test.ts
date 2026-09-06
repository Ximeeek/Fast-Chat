import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
import { createZipArchive } from '../src/lib/transfer/archive.ts';
import { FileSender } from '../src/lib/transfer/sender.ts';
import {
	FileReceiver,
	isFileSystemAccessSupported,
	RAM_WARNING_THRESHOLD_BYTES,
	RAM_HARD_LIMIT_BYTES,
	shouldWarnLargeFile,
	shouldRejectLargeBlobFile
} from '../src/lib/transfer/receiver.ts';
import {
	transferStore,
	activeUploads,
	activeDownloads,
	completedFiles,
	historicalTransfers,
	hasLargeFileRamWarning,
	hasActiveUpload
} from '../src/lib/stores/transfer.ts';
import { FileTransferSyncManager } from '../src/lib/transfer/sync.ts';
import {
	FILE_LOG_SYNC_TYPE,
	FILE_REQUEST_TYPE,
	FILE_UNAVAILABLE_TYPE,
	type FileLogEntry,
	type SentFileRecord
} from '../src/lib/transfer/types.ts';
import { PeerConnectionSession } from '../src/lib/webrtc/peer.ts';
import { WebRtcManager } from '../src/lib/webrtc/manager.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';
import { decryptChunk } from '../src/lib/crypto/cipher.ts';
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

	describe('4. Chromium File System Access API Direct Streaming Receiver', () => {
		test('acceptWithFileSystem creates writable stream and handles chunks without buffering in RAM', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-sender', true);
			const dc = rawPc!.localDataChannels[0];
			dc.open();

			// Mock FileSystemWritableFileStream
			const writtenChunks: Uint8Array[] = [];
			let streamClosed = false;
			const mockWritable = {
				write: async (chunk: Uint8Array) => {
					writtenChunks.push(new Uint8Array(chunk));
				},
				close: async () => {
					streamClosed = true;
				}
			};

			const mockHandle = {
				createWritable: async () => mockWritable
			};

			let suggestedNameReceived = '';
			const mockSavePicker = async (options?: any) => {
				suggestedNameReceived = options?.suggestedName || '';
				return mockHandle;
			};

			const receiver = new FileReceiver({
				webRtcManager: manager,
				showSaveFilePicker: mockSavePicker
			});

			// 1. Sender offers file
			await receiver.handleControlMessage('peer-sender', {
				type: 'file-meta',
				transferId: 'trans-stream-1',
				fileName: 'video.mp4',
				fileSize: 32 * 1024,
				fileType: 'video/mp4',
				chunkSize: 16 * 1024,
				totalChunks: 2,
				sender: 'sender-alice',
				senderPeerId: 'peer-sender',
				timestamp: Date.now()
			});

			const offered = receiver.getTransfer('trans-stream-1');
			assert.ok(offered);
			assert.equal(offered.fileName, 'video.mp4');
			assert.equal(offered.status, 'offered');

			// 2. User accepts with File System Access API
			await receiver.acceptWithFileSystem('trans-stream-1');

			assert.equal(suggestedNameReceived, 'video.mp4');
			assert.equal(offered.status, 'receiving');
			assert.equal(offered.storageMode, 'filesystem');

			// Check that file-ready message was encrypted and sent across data channel
			assert.equal(dc.sentPackets.length, 1);
			const decrypted = await decryptChunk(testKey, dc.sentPackets[0] as ArrayBuffer);
			const sentPayloadStr = new TextDecoder().decode(decrypted);
			assert.ok(sentPayloadStr.includes('file-ready'));
			assert.ok(sentPayloadStr.includes('trans-stream-1'));

			// 3. Ingest chunk 0 directly
			const chunk0Data = new Uint8Array(16 * 1024).fill(0xaa);
			await receiver.handleBinaryChunk({
				transferId: 'trans-stream-1',
				chunkIndex: 0,
				totalChunks: 2,
				data: chunk0Data
			});

			assert.equal(writtenChunks.length, 1);
			assert.equal(writtenChunks[0].byteLength, 16 * 1024);
			assert.equal(offered.receivedChunks, 1);
			assert.equal(offered.bytesReceived, 16 * 1024);
			assert.equal(streamClosed, false);

			// 4. Ingest chunk 1 (final chunk)
			const chunk1Data = new Uint8Array(16 * 1024).fill(0xbb);
			await receiver.handleBinaryChunk({
				transferId: 'trans-stream-1',
				chunkIndex: 1,
				totalChunks: 2,
				data: chunk1Data
			});

			assert.equal(writtenChunks.length, 2);
			assert.equal(offered.receivedChunks, 2);
			assert.equal(offered.status, 'completed');
			assert.equal(streamClosed, true);

			// Check completed records
			const completed = receiver.getCompletedRecords();
			assert.equal(completed.length, 1);
			assert.equal(completed[0].fileName, 'video.mp4');
			assert.equal(completed[0].storageMode, 'filesystem');

			manager.destroy();
		});

		test('aborting transfer closes and cleans up filesystem stream', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-sender', true);
			const dc = rawPc!.localDataChannels[0];
			dc.open();

			let streamAborted = false;
			const mockWritable = {
				write: async () => {},
				abort: async () => {
					streamAborted = true;
				}
			};

			const receiver = new FileReceiver({
				webRtcManager: manager,
				showSaveFilePicker: async () => ({ createWritable: async () => mockWritable })
			});

			await receiver.handleControlMessage('peer-sender', {
				type: 'file-meta',
				transferId: 'trans-abort-1',
				fileName: 'test.bin',
				fileSize: 16 * 1024,
				fileType: 'application/octet-stream',
				chunkSize: 16 * 1024,
				totalChunks: 1,
				sender: 'sender',
				senderPeerId: 'peer-sender',
				timestamp: Date.now()
			});

			await receiver.acceptWithFileSystem('trans-abort-1');
			await receiver.abortTransfer('trans-abort-1', 'Aborted by user');

			assert.equal(streamAborted, true);
			const t = receiver.getTransfer('trans-abort-1')!;
			assert.equal(t.status, 'cancelled');

			manager.destroy();
		});
	});

	describe('5. In-Memory Blob Assembly Fallback (Firefox & Safari)', () => {
		test('acceptWithBlob accumulates chunks into a unified Blob upon completion', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-firefox-sender', true);
			const dc = rawPc!.localDataChannels[0];
			dc.open();

			const receiver = new FileReceiver({ webRtcManager: manager });

			// 1. Offer file
			await receiver.handleControlMessage('peer-firefox-sender', {
				type: 'file-meta',
				transferId: 'trans-blob-1',
				fileName: 'document.pdf',
				fileSize: 32 * 1024,
				fileType: 'application/pdf',
				chunkSize: 16 * 1024,
				totalChunks: 2,
				sender: 'bob',
				senderPeerId: 'peer-firefox-sender',
				timestamp: Date.now()
			});

			const transfer = receiver.getTransfer('trans-blob-1')!;
			assert.equal(transfer.status, 'offered');

			// 2. Accept via Blob fallback
			await receiver.acceptWithBlob('trans-blob-1');
			assert.equal(transfer.status, 'receiving');
			assert.equal(transfer.storageMode, 'blob');

			// Check file-ready was sent across WebRTC
			assert.equal(dc.sentPackets.length, 1);

			// 3. Send 2 chunks
			const chunk0 = new Uint8Array(16 * 1024).fill(0x11);
			const chunk1 = new Uint8Array(16 * 1024).fill(0x22);

			await receiver.handleBinaryChunk({
				transferId: 'trans-blob-1',
				chunkIndex: 0,
				totalChunks: 2,
				data: chunk0
			});

			assert.equal(transfer.receivedChunks, 1);

			await receiver.handleBinaryChunk({
				transferId: 'trans-blob-1',
				chunkIndex: 1,
				totalChunks: 2,
				data: chunk1
			});

			// Transfer auto-completes on last chunk
			assert.equal(transfer.status, 'completed');
			assert.ok(transfer.blob instanceof Blob);
			assert.equal(transfer.blob.size, 32 * 1024);
			assert.equal(transfer.blob.type, 'application/pdf');

			// Verify data integrity of assembled Blob
			const assembledArray = new Uint8Array(await transfer.blob.arrayBuffer());
			assert.equal(assembledArray[0], 0x11);
			assert.equal(assembledArray[16 * 1024], 0x22);

			const completed = receiver.getCompletedRecords();
			assert.equal(completed.length, 1);
			assert.equal(completed[0].storageMode, 'blob');

			manager.destroy();
		});
	});

	describe('6. High RAM Consumption Alert (>500MB) & 1GB Blob Fallback Hard Limit', () => {
		test('RAM_WARNING_THRESHOLD_BYTES is configured to exactly 500MB', () => {
			assert.equal(RAM_WARNING_THRESHOLD_BYTES, 500 * 1024 * 1024);
		});

		test('RAM_HARD_LIMIT_BYTES is configured to exactly 1GB', () => {
			assert.equal(RAM_HARD_LIMIT_BYTES, 1024 * 1024 * 1024);
		});

		test('shouldWarnLargeFile and shouldRejectLargeBlobFile differentiate memory tiers', () => {
			// In node environment, isFileSystemAccessSupported is false
			assert.equal(shouldWarnLargeFile(100 * 1024 * 1024), false); // Under 500MB
			assert.equal(shouldWarnLargeFile(500 * 1024 * 1024), false); // Exactly 500MB
			assert.equal(shouldWarnLargeFile(750 * 1024 * 1024), true); // Between 500MB and 1GB
			assert.equal(shouldWarnLargeFile(1024 * 1024 * 1024), true); // Exactly 1GB
			assert.equal(shouldWarnLargeFile(1200 * 1024 * 1024), false); // Above 1GB (rejected, not merely warned)

			assert.equal(shouldRejectLargeBlobFile(750 * 1024 * 1024), false); // Under 1GB
			assert.equal(shouldRejectLargeBlobFile(1024 * 1024 * 1024), false); // Exactly 1GB
			assert.equal(shouldRejectLargeBlobFile(1024 * 1024 * 1024 + 1), true); // Over 1GB
		});

		test('flags ramWarning for files between 500MB and 1GB, and ramLimitExceeded for files > 1GB', async () => {
			let rawPc: MockBackpressureRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockBackpressureRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			const receiver = new FileReceiver({ webRtcManager: manager });

			// Large file: 750 MB (> 500MB, <= 1GB) -> ramWarning = true, ramLimitExceeded = false
			const largeFileSize = 750 * 1024 * 1024;
			await receiver.handleControlMessage('peer-safari-sender', {
				type: 'file-meta',
				transferId: 'trans-large-1',
				fileName: 'large-archive.iso',
				fileSize: largeFileSize,
				fileType: 'application/octet-stream',
				chunkSize: 16 * 1024,
				totalChunks: calculateTotalChunks(largeFileSize),
				sender: 'charlie',
				senderPeerId: 'peer-safari-sender',
				timestamp: Date.now()
			});

			const transfer = receiver.getTransfer('trans-large-1')!;
			assert.equal(transfer.ramWarning, true);
			assert.equal(transfer.ramLimitExceeded, false);

			// Huge file: 1.5 GB (> 1GB hard limit) -> ramLimitExceeded = true, ramWarning = false
			const hugeFileSize = 1536 * 1024 * 1024;
			await receiver.handleControlMessage('peer-safari-sender', {
				type: 'file-meta',
				transferId: 'trans-huge-1',
				fileName: 'database-dump.sql',
				fileSize: hugeFileSize,
				fileType: 'application/sql',
				chunkSize: 16 * 1024,
				totalChunks: calculateTotalChunks(hugeFileSize),
				sender: 'charlie',
				senderPeerId: 'peer-safari-sender',
				timestamp: Date.now()
			});

			const hugeTransfer = receiver.getTransfer('trans-huge-1')!;
			assert.equal(hugeTransfer.ramLimitExceeded, true);
			assert.equal(hugeTransfer.ramWarning, false);

			// Small file: 100 MB (< 500MB)
			await receiver.handleControlMessage('peer-safari-sender', {
				type: 'file-meta',
				transferId: 'trans-small-1',
				fileName: 'small.zip',
				fileSize: 100 * 1024 * 1024,
				fileType: 'application/zip',
				chunkSize: 16 * 1024,
				totalChunks: calculateTotalChunks(100 * 1024 * 1024),
				sender: 'charlie',
				senderPeerId: 'peer-safari-sender',
				timestamp: Date.now()
			});

			const smallTransfer = receiver.getTransfer('trans-small-1')!;
			assert.equal(smallTransfer.ramWarning, false);
			assert.equal(smallTransfer.ramLimitExceeded, false);

			// Attempting acceptWithBlob on the >1GB file must reject and throw
			let errorThrown: Error | null = null;
			try {
				await receiver.acceptWithBlob('trans-huge-1');
			} catch (err: any) {
				errorThrown = err;
			}
			assert.ok(errorThrown !== null, 'acceptWithBlob must throw on file exceeding hard limit');
			assert.match(errorThrown!.message, /exceeds in-memory Blob assembly limit/i);
			assert.equal(hugeTransfer.status, 'failed');

			manager.destroy();
		});
	});

	describe('7. Reactive Transfer Store Lifecycle', () => {
		test('registers transfers, updates progress, and tracks completed records', () => {
			transferStore.reset();

			let uploads: any[] = [];
			let downloads: any[] = [];
			let completed: any[] = [];
			let ramWarning = false;

			const unsubUp = activeUploads.subscribe((v) => (uploads = v));
			const unsubDown = activeDownloads.subscribe((v) => (downloads = v));
			const unsubComp = completedFiles.subscribe((v) => (completed = v));
			const unsubWarn = hasLargeFileRamWarning.subscribe((v) => (ramWarning = v));

			assert.equal(uploads.length, 0);
			assert.equal(downloads.length, 0);
			assert.equal(completed.length, 0);
			assert.equal(ramWarning, false);

			// Add incoming transfer with ram warning
			transferStore.addIncomingTransfer({
				transferId: 't-store-1',
				fileName: 'dump.tar',
				fileSize: 600 * 1024 * 1024,
				fileType: 'application/x-tar',
				totalChunks: 1000,
				receivedChunks: 10,
				bytesReceived: 160 * 1024,
				sender: 'alice',
				senderPeerId: 'peer-1',
				status: 'receiving',
				storageMode: 'blob',
				ramWarning: true,
				startedAt: Date.now()
			});

			assert.equal(downloads.length, 1);
			assert.equal(ramWarning, true);

			// Add completed record
			transferStore.addCompletedRecord({
				transferId: 't-comp-1',
				fileName: 'photo.jpg',
				fileSize: 50000,
				fileType: 'image/jpeg',
				storageMode: 'blob',
				completedAt: Date.now()
			});

			assert.equal(completed.length, 1);
			assert.equal(completed[0].fileName, 'photo.jpg');

			// Reset flushes all
			transferStore.reset();
			assert.equal(downloads.length, 0);
			assert.equal(completed.length, 0);
			assert.equal(ramWarning, false);

			unsubUp();
			unsubDown();
			unsubComp();
			unsubWarn();
		});

		test('hasActiveUpload tracks active outbound file streaming states', () => {
			transferStore.reset();

			let activeUpload = false;
			const unsub = hasActiveUpload.subscribe((v) => (activeUpload = v));

			assert.equal(activeUpload, false);

			// Add active outgoing transfer with status 'offered'
			const recipients = new Map();
			recipients.set('peer-1', {
				peerId: 'peer-1',
				bytesSent: 0,
				totalBytes: 1024,
				chunksSent: 0,
				totalChunks: 1,
				percentage: 0,
				status: 'offered'
			});

			transferStore.addOutgoingTransfer({
				transferId: 'out-1',
				file: new Blob(['test']),
				fileName: 'test.txt',
				fileSize: 1024,
				fileType: 'text/plain',
				totalChunks: 1,
				recipients,
				status: 'offered',
				createdAt: Date.now()
			});

			assert.equal(activeUpload, true, 'hasActiveUpload must be true when transfer is offered');

			// Transition recipient to completed
			transferStore.updateOutgoingProgress('out-1', 'peer-1', {
				peerId: 'peer-1',
				bytesSent: 1024,
				totalBytes: 1024,
				chunksSent: 1,
				totalChunks: 1,
				percentage: 100,
				status: 'completed'
			});

			assert.equal(activeUpload, false, 'hasActiveUpload must be false when all recipients complete');

			unsub();
		});
	});

	describe('8. Client-Side Multi-File ZIP Archive Export via fflate', () => {
		test('createZipArchive bundles multiple binary files into valid ZIP without server roundtrip', async () => {
			const file1Data = new TextEncoder().encode('Content of file 1');
			const file2Data = new TextEncoder().encode('Content of file 2 with more bytes');

			const zipBlob = await createZipArchive([
				{ name: 'document1.txt', data: file1Data },
				{ name: 'document2.txt', data: file2Data }
			]);

			assert.ok(zipBlob instanceof Blob);
			assert.equal(zipBlob.type, 'application/zip');
			assert.ok(zipBlob.size > 0);

			// Verify standard ZIP magic PK\x03\x04
			const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
			assert.equal(zipBytes[0], 0x50); // 'P'
			assert.equal(zipBytes[1], 0x4b); // 'K'
			assert.equal(zipBytes[2], 0x03);
			assert.equal(zipBytes[3], 0x04);
		});

		test('de-duplicates duplicate filenames automatically in ZIP archive table', async () => {
			const fileData = new Uint8Array([1, 2, 3, 4]);

			const zipBlob = await createZipArchive([
				{ name: 'test.pdf', data: fileData },
				{ name: 'test.pdf', data: fileData }
			]);

			assert.ok(zipBlob instanceof Blob);
			assert.ok(zipBlob.size > 0);
		});
	});

	describe('9. End-to-End Encrypted File Transfer & Large Multi-Chunk Roundtrip', () => {
		test('encrypts outbound chunks and decrypts inbound chunks across mock WebRTC mesh', async () => {
			let pcAlice: MockBackpressureRTCPeerConnection | null = null;
			let pcBob: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockBackpressureRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});

			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockBackpressureRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerBob.getOrCreateSession('peer-alice', false);

			const dcAlice = pcAlice!.localDataChannels[0];
			const dcBob = new MockBackpressureRTCDataChannel('fastchat-data');
			dcAlice.peerChannel = dcBob;
			dcBob.peerChannel = dcAlice;

			pcBob!.ondatachannel?.({ channel: dcBob });
			dcAlice.open();
			dcBob.open();

			const sender = new FileSender(managerAlice);
			const receiver = new FileReceiver({ webRtcManager: managerBob });

			// Wire incoming messages on Bob to receiver
			managerBob.onMessage((peerId, payload) => {
				if (isFileChunkPacket(payload)) {
					const parsed = parseFileChunkPacket(payload);
					if (parsed) receiver.handleBinaryChunk(parsed);
					return;
				}

				if (payload.length > 0 && payload[0] === 0x7b) {
					try {
						const json = JSON.parse(new TextDecoder().decode(payload));
						receiver.handleControlMessage(peerId, json);
					} catch {}
				}
			});

			// Wire incoming messages on Alice to sender
			managerAlice.onMessage((peerId, payload) => {
				if (payload.length > 0 && payload[0] === 0x7b) {
					try {
						const json = JSON.parse(new TextDecoder().decode(payload));
						sender.handleControlMessage(peerId, json);
					} catch {}
				}
			});

			// Create 64KB random buffer (4 chunks of 16KB)
			const fileLength = 64 * 1024;
			const rawSource = new Uint8Array(fileLength);
			for (let i = 0; i < fileLength; i++) {
				rawSource[i] = (i * 7 + 13) % 256;
			}
			const sourceBlob = new Blob([rawSource], { type: 'application/octet-stream' });

			// Alice initiates send
			const transfer = await sender.sendFile(sourceBlob, {
				fileName: 'large-payload.dat',
				targetPeers: ['peer-bob'],
				senderUsername: 'alice'
			});

			// Await async microtask message propagation
			await new Promise((r) => setTimeout(r, 20));

			const offeredOnBob = receiver.getTransfer(transfer.transferId);
			assert.ok(offeredOnBob);
			assert.equal(offeredOnBob.fileName, 'large-payload.dat');
			assert.equal(offeredOnBob.totalChunks, 4);

			// Bob accepts via Blob mode
			await receiver.acceptWithBlob(transfer.transferId);

			// Await transfer streaming across channels
			await new Promise((r) => setTimeout(r, 60));

			const completedOnBob = receiver.getTransfer(transfer.transferId)!;
			assert.equal(completedOnBob.status, 'completed');
			assert.equal(completedOnBob.receivedChunks, 4);
			assert.ok(completedOnBob.blob instanceof Blob);
			assert.equal(completedOnBob.blob.size, fileLength);

			// Assert byte-for-byte exact equality between sent and received file
			const receivedBytes = new Uint8Array(await completedOnBob.blob.arrayBuffer());
			assert.deepEqual(receivedBytes, rawSource);

			managerAlice.destroy();
			managerBob.destroy();
		});
	});

	describe('10. Zero Server Footprint & Zero Persistence Audit', () => {
		test('no localStorage or sessionStorage references present in transfer source files', () => {
			const transferFiles = [
				'src/lib/transfer/chunking.ts',
				'src/lib/transfer/sender.ts',
				'src/lib/transfer/receiver.ts',
				'src/lib/transfer/archive.ts',
				'src/lib/transfer/types.ts',
				'src/lib/transfer/sync.ts',
				'src/lib/transfer/index.ts',
				'src/lib/stores/transfer.ts',
				'src/lib/transfer/FileTransfer.svelte'
			];

			for (const relPath of transferFiles) {
				const fullPath = new URL(`../${relPath}`, import.meta.url);
				if (fs.existsSync(fullPath)) {
					const code = fs.readFileSync(fullPath, 'utf8');
					assert.equal(
						code.includes('localStorage'),
						false,
						`Forbidden localStorage detected in ${relPath}`
					);
					assert.equal(
						code.includes('sessionStorage'),
						false,
						`Forbidden sessionStorage detected in ${relPath}`
					);
				}
			}
		});
	});

	describe('11. Historical File Log Synchronization & On-Demand Retransmission', () => {
		test('in-memory File handle retention stores File reference without extra memory overhead', async () => {
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: () => new MockBackpressureRTCPeerConnection() as unknown as RTCPeerConnection
			});

			const sender = new FileSender(manager);
			const rawBytes = new Uint8Array(32 * 1024).fill(0x77);
			const mockBlob = new Blob([rawBytes], { type: 'application/octet-stream' });

			sender.recordSentFile({
				fileId: 'file-session-123',
				file: mockBlob,
				fileName: 'session-doc.bin',
				fileSize: mockBlob.size,
				fileType: mockBlob.type,
				senderPeerId: 'peer-alice',
				senderUsername: 'alice',
				timestamp: Date.now()
			});

			const retrieved = sender.getSentFile('file-session-123');
			assert.ok(retrieved);
			assert.equal(retrieved.fileName, 'session-doc.bin');
			assert.equal(retrieved.file, mockBlob);

			const all = sender.getAllSentFiles();
			assert.equal(all.length, 1);
			assert.equal(all[0].fileId, 'file-session-123');

			// Clearing sender drops file reference from RAM
			sender.clearSentFileLog();
			assert.equal(sender.getSentFile('file-session-123'), undefined);
			assert.equal(sender.getAllSentFiles().length, 0);

			manager.destroy();
		});

		test('late-joining peer receives FILE_LOG_SYNC and displays earlier transfer as available', async () => {
			transferStore.reset();
			let pcAlice: MockBackpressureRTCPeerConnection | null = null;
			let pcBob: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockBackpressureRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});
			(managerAlice as any).localPeerId = 'peer-alice';

			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockBackpressureRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});
			(managerBob as any).localPeerId = 'peer-bob';

			const senderAlice = new FileSender(managerAlice);
			const syncAlice = new FileTransferSyncManager(managerAlice, { fileSender: senderAlice });
			const syncBob = new FileTransferSyncManager(managerBob);

			// Alice records a sent file from an earlier transfer
			const fileBytes = new Uint8Array(16 * 1024).fill(0x42);
			const fileBlob = new Blob([fileBytes], { type: 'application/pdf' });
			senderAlice.recordSentFile({
				fileId: 'file-hist-001',
				file: fileBlob,
				fileName: 'whitepaper.pdf',
				fileSize: fileBlob.size,
				fileType: 'application/pdf',
				senderPeerId: 'peer-alice',
				senderUsername: 'alice',
				timestamp: 1725600000000
			});

			// Setup WebRTC peer session
			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerBob.getOrCreateSession('peer-alice', false);

			const dcAlice = pcAlice!.localDataChannels[0];
			const dcBob = new MockBackpressureRTCDataChannel('fastchat-data');
			dcAlice.peerChannel = dcBob;
			dcBob.peerChannel = dcAlice;
			pcBob!.ondatachannel?.({ channel: dcBob });

			// Wire Bob's message handler to syncBob
			managerBob.onMessage((peerId, payload) => {
				syncBob.handleIncomingControlMessage(peerId, JSON.parse(new TextDecoder().decode(payload)), payload);
			});

			// Trigger data channel open: Alice automatically sends FILE_LOG_SYNC to Bob
			dcAlice.open();
			dcBob.open();

			await new Promise((r) => setTimeout(r, 20));

			// Verify Bob received the historical file log entry
			let bobHistory: any[] = [];
			const unsub = historicalTransfers.subscribe((list) => {
				bobHistory = list;
			});
			unsub();

			assert.equal(bobHistory.length, 1);
			assert.equal(bobHistory[0].fileId, 'file-hist-001');
			assert.equal(bobHistory[0].fileName, 'whitepaper.pdf');
			assert.equal(bobHistory[0].fileSize, 16 * 1024);
			assert.equal(bobHistory[0].senderPeerId, 'peer-alice');
			assert.equal(bobHistory[0].status, 'available');

			syncAlice.destroy();
			syncBob.destroy();
			managerAlice.destroy();
			managerBob.destroy();
			transferStore.reset();
		});

		test('on-demand retransmission delivers byte-for-byte identical file to late joiner', async () => {
			transferStore.reset();
			let pcAlice: MockBackpressureRTCPeerConnection | null = null;
			let pcBob: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockBackpressureRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});
			(managerAlice as any).localPeerId = 'peer-alice';

			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockBackpressureRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});
			(managerBob as any).localPeerId = 'peer-bob';

			const senderAlice = new FileSender(managerAlice);
			const receiverBob = new FileReceiver({
				webRtcManager: managerBob
			});

			const syncAlice = new FileTransferSyncManager(managerAlice, { fileSender: senderAlice });
			const syncBob = new FileTransferSyncManager(managerBob, {
				fileReceiver: receiverBob,
				store: transferStore
			});
			receiverBob.setAutoAcceptPredicate((id: string) => syncBob.isRequestPending(id));

			// 48KB source file (3 x 16KB chunks)
			const fileLength = 48 * 1024;
			const originalBytes = new Uint8Array(fileLength);
			for (let i = 0; i < fileLength; i++) {
				originalBytes[i] = (i * 13 + 7) % 256;
			}
			const sourceBlob = new Blob([originalBytes], { type: 'application/octet-stream' });
			const fileId = 'file-retransmit-test-99';

			senderAlice.recordSentFile({
				fileId,
				file: sourceBlob,
				fileName: 'archive.tar',
				fileSize: fileLength,
				fileType: 'application/octet-stream',
				senderPeerId: 'peer-alice',
				senderUsername: 'alice',
				timestamp: Date.now()
			});

			// Setup WebRTC peer channels
			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerBob.getOrCreateSession('peer-alice', false);

			const dcAlice = pcAlice!.localDataChannels[0];
			const dcBob = new MockBackpressureRTCDataChannel('fastchat-data');
			dcAlice.peerChannel = dcBob;
			dcBob.peerChannel = dcAlice;
			pcBob!.ondatachannel?.({ channel: dcBob });

			// Wire messages between Alice and Bob
			managerBob.onMessage((peerId, payload) => {
				if (isFileChunkPacket(payload)) {
					const chunk = parseFileChunkPacket(payload);
					if (chunk) receiverBob.handleBinaryChunk(chunk);
					return;
				}
				if (payload.length > 0 && payload[0] === 0x7b) {
					const data = JSON.parse(new TextDecoder().decode(payload));
					if (data.type === 'file-meta' || data.type === 'file-complete') {
						receiverBob.handleControlMessage(peerId, data);
					} else {
						syncBob.handleIncomingControlMessage(peerId, data, payload);
					}
				}
			});

			managerAlice.onMessage((peerId, payload) => {
				if (payload.length > 0 && payload[0] === 0x7b) {
					const data = JSON.parse(new TextDecoder().decode(payload));
					if (data.type === 'file-ready' || data.type === 'file-cancel') {
						senderAlice.handleControlMessage(peerId, data);
					} else {
						syncAlice.handleIncomingControlMessage(peerId, data, payload);
					}
				}
			});

			dcAlice.open();
			dcBob.open();
			await new Promise((r) => setTimeout(r, 20));

			// Bob's store now has the available historical file
			let bobRecords: any[] = [];
			historicalTransfers.subscribe((l) => (bobRecords = l))();
			assert.equal(bobRecords.length, 1);
			assert.equal(bobRecords[0].status, 'available');

			// Bob clicks Download -> dispatches FILE_REQUEST to Alice
			const requested = await syncBob.requestFile(fileId);
			assert.equal(requested, true);

			// Let streaming execute across the data channels
			await new Promise((r) => setTimeout(r, 70));

			historicalTransfers.subscribe((l) => (bobRecords = l))();
			assert.equal(bobRecords[0].status, 'completed');
			assert.equal(bobRecords[0].progress, 100);
			assert.ok(bobRecords[0].blob instanceof Blob);
			assert.equal(bobRecords[0].blob.size, fileLength);

			// Assert byte-for-byte exact equality between Alice's source and Bob's received file
			const assembledBytes = new Uint8Array(await bobRecords[0].blob.arrayBuffer());
			assert.deepEqual(assembledBytes, originalBytes);

			syncAlice.destroy();
			syncBob.destroy();
			senderAlice.reset();
			receiverBob.reset();
			managerAlice.destroy();
			managerBob.destroy();
			transferStore.reset();
		});

		test('departure resilience: requesting file after original sender departs immediately flags file unavailable', async () => {
			transferStore.reset();
			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: () => new MockBackpressureRTCPeerConnection() as unknown as RTCPeerConnection
			});
			(managerBob as any).localPeerId = 'peer-bob';

			const syncBob = new FileTransferSyncManager(managerBob, { store: transferStore });

			// Simulate Bob having a historical entry from Alice
			transferStore.addHistoricalFiles([
				{
					fileId: 'file-departed-123',
					fileName: 'departed-plan.pdf',
					fileSize: 1024,
					fileType: 'application/pdf',
					senderPeerId: 'peer-alice',
					senderUsername: 'alice',
					timestamp: Date.now()
				}
			]);

			// Peer Alice is NOT in room / dataChannel is not open
			const success = await syncBob.requestFile('file-departed-123');
			assert.equal(success, false);

			let history: any[] = [];
			historicalTransfers.subscribe((l) => (history = l))();
			assert.equal(history.length, 1);
			assert.equal(history[0].status, 'unavailable');
			assert.ok(history[0].error?.includes('sender left the room'));

			syncBob.destroy();
			managerBob.destroy();
			transferStore.reset();
		});

		test('in-flight request is marked unavailable when sender departure is signaled', async () => {
			transferStore.reset();
			let pcAlice: MockBackpressureRTCPeerConnection | null = null;
			let pcBob: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockBackpressureRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});
			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockBackpressureRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			const syncBob = new FileTransferSyncManager(managerBob, { store: transferStore });

			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerBob.getOrCreateSession('peer-alice', false);
			const dcAlice = pcAlice!.localDataChannels[0];
			const dcBob = new MockBackpressureRTCDataChannel('fastchat-data');
			dcAlice.peerChannel = dcBob;
			dcBob.peerChannel = dcAlice;
			pcBob!.ondatachannel?.({ channel: dcBob });
			dcAlice.open();
			dcBob.open();

			transferStore.addHistoricalFiles([
				{
					fileId: 'file-inflight-456',
					fileName: 'active-stream.bin',
					fileSize: 50000,
					senderPeerId: 'peer-alice',
					timestamp: Date.now()
				}
			]);

			await syncBob.requestFile('file-inflight-456');
			assert.equal(syncBob.isRequestPending('file-inflight-456'), true);

			// Signaling indicates Alice left the room
			syncBob.handlePeerLeft('peer-alice');

			let history: any[] = [];
			historicalTransfers.subscribe((l) => (history = l))();
			assert.equal(history[0].status, 'unavailable');
			assert.ok(history[0].error?.includes('sender left the room'));
			assert.equal(syncBob.isRequestPending('file-inflight-456'), false);

			syncBob.destroy();
			managerAlice.destroy();
			managerBob.destroy();
			transferStore.reset();
		});

		test('sender returns FILE_UNAVAILABLE when requested file reference is missing', async () => {
			transferStore.reset();
			let pcAlice: MockBackpressureRTCPeerConnection | null = null;
			let pcBob: MockBackpressureRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockBackpressureRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});
			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockBackpressureRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			const senderAlice = new FileSender(managerAlice);
			const syncAlice = new FileTransferSyncManager(managerAlice, { fileSender: senderAlice });
			const syncBob = new FileTransferSyncManager(managerBob, { store: transferStore });

			await managerAlice.getOrCreateSession('peer-bob', true);
			await managerBob.getOrCreateSession('peer-alice', false);
			const dcAlice = pcAlice!.localDataChannels[0];
			const dcBob = new MockBackpressureRTCDataChannel('fastchat-data');
			dcAlice.peerChannel = dcBob;
			dcBob.peerChannel = dcAlice;
			pcBob!.ondatachannel?.({ channel: dcBob });

			managerBob.onMessage((peerId, payload) => {
				syncBob.handleIncomingControlMessage(peerId, JSON.parse(new TextDecoder().decode(payload)), payload);
			});
			managerAlice.onMessage((peerId, payload) => {
				syncAlice.handleIncomingControlMessage(peerId, JSON.parse(new TextDecoder().decode(payload)), payload);
			});

			dcAlice.open();
			dcBob.open();

			transferStore.addHistoricalFiles([
				{
					fileId: 'file-purged-999',
					fileName: 'purged.bin',
					fileSize: 1000,
					senderPeerId: 'peer-alice',
					timestamp: Date.now()
				}
			]);

			// Bob requests file which Alice does NOT have in sentFileLog
			await syncBob.requestFile('file-purged-999');
			await new Promise((r) => setTimeout(r, 20));

			let history: any[] = [];
			historicalTransfers.subscribe((l) => (history = l))();
			assert.equal(history[0].status, 'unavailable');
			assert.ok(history[0].error?.includes('no longer available'));

			syncAlice.destroy();
			syncBob.destroy();
			managerAlice.destroy();
			managerBob.destroy();
			transferStore.reset();
		});

		test('room exit resets all file references, sync state, and pending requests', () => {
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: () => new MockBackpressureRTCPeerConnection() as unknown as RTCPeerConnection
			});

			const sender = new FileSender(manager);
			const sync = new FileTransferSyncManager(manager, { fileSender: sender });

			sender.recordSentFile({
				fileId: 'file-to-purge',
				file: new Blob([new Uint8Array(100)]),
				fileName: 'test.bin',
				fileSize: 100,
				fileType: 'application/octet-stream',
				senderPeerId: 'alice',
				timestamp: Date.now()
			});

			assert.equal(sender.getAllSentFiles().length, 1);

			// Exiting room
			sync.destroy();
			sender.reset();
			transferStore.reset();

			assert.equal(sender.getAllSentFiles().length, 0);
			assert.equal(sender.getSentFile('file-to-purge'), undefined);

			let hist: any[] = [];
			historicalTransfers.subscribe((l) => (hist = l))();
			assert.equal(hist.length, 0);

			manager.destroy();
		});
	});
});



