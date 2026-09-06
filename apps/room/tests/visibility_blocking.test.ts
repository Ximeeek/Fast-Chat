import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WebRtcManager } from '../src/lib/webrtc/manager.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';
import { ChatHistorySyncManager } from '../src/lib/chat/historySync.ts';
import { createChatStore } from '../src/lib/stores/chat.ts';
import { FileSender } from '../src/lib/transfer/sender.ts';
import { FileReceiver } from '../src/lib/transfer/receiver.ts';
import { FileTransferSyncManager } from '../src/lib/transfer/sync.ts';
import { createTransferStore } from '../src/lib/stores/transfer.ts';
import { roomStore } from '../src/lib/stores/room.ts';
import { serializeChatMessage, deserializeChatMessage } from '../src/lib/chat/transport.ts';

class MockDataChannel {
	public label: string;
	public ordered: boolean;
	public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
	public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
	public onopen: (() => void) | null = null;
	public onclose: (() => void) | null = null;
	public onerror: ((ev: any) => void) | null = null;
	public onmessage: ((ev: { data: any }) => void) | null = null;
	public sentPackets: (string | Blob | ArrayBuffer | ArrayBufferView)[] = [];
	public peerChannel: MockDataChannel | null = null;

	constructor(label: string, options?: RTCDataChannelInit) {
		this.label = label;
		this.ordered = options?.ordered ?? true;
	}

	public open(): void {
		this.readyState = 'open';
		this.onopen?.();
	}

	public send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 'open') {
			throw new Error('RTCDataChannel is not open');
		}
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

	public close(): void {
		if (this.readyState !== 'closed') {
			this.readyState = 'closed';
			this.onclose?.();
		}
	}
}

class MockPeerConnection {
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
	public localDataChannels: MockDataChannel[] = [];
	public configuration: RTCConfiguration;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const dc = new MockDataChannel(label, options);
		this.localDataChannels.push(dc);
		return dc as unknown as RTCDataChannel;
	}

	public async createOffer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
	}

	public async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };
	}

	public async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = desc;
	}

	public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = desc;
	}

	public async addIceCandidate(): Promise<void> {}
	public async getStats(): Promise<Map<string, any>> {
		return new Map();
	}
	public close(): void {
		this.connectionState = 'closed';
	}
}

function connectMeshPair(
	managerA: WebRtcManager,
	peerIdA: string,
	managerB: WebRtcManager,
	peerIdB: string,
	pcA: MockPeerConnection,
	pcB: MockPeerConnection
): { dcA: MockDataChannel; dcB: MockDataChannel } {
	const dcA = pcA.localDataChannels[pcA.localDataChannels.length - 1];
	const dcB = new MockDataChannel('fastchat-data');
	dcA.peerChannel = dcB;
	dcB.peerChannel = dcA;
	pcB.ondatachannel?.({ channel: dcB } as any);
	dcA.open();
	dcB.open();
	return { dcA, dcB };
}

describe('Selective Visibility Blocking (Chat & Files)', () => {
	let testKey: CryptoKey;

	beforeEach(async () => {
		testKey = await deriveInitialKey('1234-5678-9012', 'visibility-test-salt-1234');
		roomStore.reset();
	});

	test('Chat Visibility: broadcast skips chat-blocked peers but reaches unblocked peers', async () => {
		let pcAliceToBob!: MockPeerConnection;
		let pcAliceToCarol!: MockPeerConnection;

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				const pc = new MockPeerConnection();
				if (!pcAliceToBob) pcAliceToBob = pc;
				else pcAliceToCarol = pc;
				return pc as unknown as RTCPeerConnection;
			}
		});

		let pcBobToAlice = new MockPeerConnection();
		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcBobToAlice as unknown as RTCPeerConnection
		});

		let pcCarolToAlice = new MockPeerConnection();
		const managerCarol = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcCarolToAlice as unknown as RTCPeerConnection
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerBob, 'bob', pcAliceToBob, pcBobToAlice);

		await managerAlice.getOrCreateSession('carol', true);
		await managerCarol.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerCarol, 'carol', pcAliceToCarol, pcCarolToAlice);

		const receivedBob: any[] = [];
		const receivedCarol: any[] = [];
		managerBob.onMessage((sender, payload) => receivedBob.push({ sender, payload }));
		managerCarol.onMessage((sender, payload) => receivedCarol.push({ sender, payload }));

		// Alice broadcasts message with bob excluded
		const chatBlockedPeers = ['bob'];
		const chatPayload = serializeChatMessage({
			type: 'chat',
			id: 'msg-1',
			sender: 'Alice',
			timestamp: Date.now(),
			segments: [{ type: 'text', text: 'Hello Carol!' }]
		});

		await managerAlice.broadcast(chatPayload, chatBlockedPeers);
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(receivedBob.length, 0, 'Bob (chat-blocked) must not receive chat message');
		assert.equal(receivedCarol.length, 1, 'Carol (unblocked) must receive chat message');

		const msgCarol = deserializeChatMessage(receivedCarol[0].payload);
		assert.equal(msgCarol?.id, 'msg-1');
		assert.deepEqual(msgCarol?.segments, [{ type: 'text', text: 'Hello Carol!' }]);

		managerAlice.destroy();
		managerBob.destroy();
		managerCarol.destroy();
	});

	test('Chat Visibility: chat-blocked peer CAN broadcast to unblocked peers', async () => {
		let pcBobToAlice = new MockPeerConnection();
		let pcBobToCarol = new MockPeerConnection();

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				if (!pcBobToAlice.localDataChannels.length) return pcBobToAlice as unknown as RTCPeerConnection;
				return pcBobToCarol as unknown as RTCPeerConnection;
			}
		});

		let pcAliceToBob = new MockPeerConnection();
		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcAliceToBob as unknown as RTCPeerConnection
		});

		let pcCarolToBob = new MockPeerConnection();
		const managerCarol = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcCarolToBob as unknown as RTCPeerConnection
		});

		await managerBob.getOrCreateSession('alice', true);
		await managerAlice.getOrCreateSession('bob', false);
		connectMeshPair(managerBob, 'bob', managerAlice, 'alice', pcBobToAlice, pcAliceToBob);

		await managerBob.getOrCreateSession('carol', true);
		await managerCarol.getOrCreateSession('bob', false);
		connectMeshPair(managerBob, 'bob', managerCarol, 'carol', pcBobToCarol, pcCarolToBob);

		const receivedAlice: any[] = [];
		const receivedCarol: any[] = [];
		managerAlice.onMessage((sender, payload) => receivedAlice.push({ sender, payload }));
		managerCarol.onMessage((sender, payload) => receivedCarol.push({ sender, payload }));

		// Bob is blocked, but Bob's chatBlockedPeers contains ['bob'].
		// When Bob broadcasts, Bob passes chatBlockedPeers=['bob']. Bob has sessions to alice and carol, not bob.
		const chatBlockedPeers = ['bob'];
		const chatPayload = serializeChatMessage({
			type: 'chat',
			id: 'msg-from-bob',
			sender: 'Bob',
			timestamp: Date.now(),
			segments: [{ type: 'text', text: 'Hello from blocked Bob!' }]
		});

		await managerBob.broadcast(chatPayload, chatBlockedPeers);
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(receivedAlice.length, 1, 'Alice must receive message sent by Bob');
		assert.equal(receivedCarol.length, 1, 'Carol must receive message sent by Bob');

		managerBob.destroy();
		managerAlice.destroy();
		managerCarol.destroy();
	});

	test('Chat History Sync: ChatHistorySyncManager skips chat-blocked late joiners', async () => {
		let pcAlice!: MockPeerConnection;
		let pcBob = new MockPeerConnection();

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				pcAlice = new MockPeerConnection();
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcBob as unknown as RTCPeerConnection
		});

		const storeAlice = createChatStore();
		storeAlice.addMessage({
			id: 'hist-1',
			sender: 'Alice',
			segments: [{ type: 'text', text: 'Secret pre-join chat message' }],
			timestamp: Date.now(),
			isSelf: true
		});

		const storeBob = createChatStore();

		// Configure Alice's sync manager with isChatBlocked checking if peer is 'bob'
		const syncAlice = new ChatHistorySyncManager(managerAlice, {
			autoListen: true,
			chatStore: storeAlice,
			isChatBlocked: (peerId) => peerId === 'bob'
		});

		const syncBob = new ChatHistorySyncManager(managerBob, {
			autoListen: true,
			chatStore: storeBob
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerBob, 'bob', pcAlice, pcBob);

		await new Promise((r) => setTimeout(r, 50));

		let stateBob: any;
		storeBob.subscribe((s) => (stateBob = s))();

		assert.equal(stateBob.messages.length, 0, 'Bob (chat-blocked) must NOT receive historical messages upon join');

		syncAlice.destroy();
		syncBob.destroy();
		managerAlice.destroy();
		managerBob.destroy();
	});

	test('File Visibility: FileSender filters out file-blocked peers from outbound transfer', async () => {
		let pcAliceToBob!: MockPeerConnection;
		let pcAliceToCarol!: MockPeerConnection;

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				const pc = new MockPeerConnection();
				if (!pcAliceToBob) pcAliceToBob = pc;
				else pcAliceToCarol = pc;
				return pc as unknown as RTCPeerConnection;
			}
		});

		let pcBob = new MockPeerConnection();
		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcBob as unknown as RTCPeerConnection
		});

		let pcCarol = new MockPeerConnection();
		const managerCarol = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcCarol as unknown as RTCPeerConnection
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerBob, 'bob', pcAliceToBob, pcBob);

		await managerAlice.getOrCreateSession('carol', true);
		await managerCarol.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerCarol, 'carol', pcAliceToCarol, pcCarol);

		const receivedBob: any[] = [];
		const receivedCarol: any[] = [];
		managerBob.onMessage((sender, payload) => receivedBob.push({ sender, payload }));
		managerCarol.onMessage((sender, payload) => receivedCarol.push({ sender, payload }));

		// FileSender with bob file-blocked
		const senderAlice = new FileSender(managerAlice, {
			isFileBlocked: (peerId) => peerId === 'bob'
		});

		const fileData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const blob = new Blob([fileData], { type: 'application/octet-stream' });

		const transfer = await senderAlice.sendFile(blob, {
			fileName: 'confidential.bin',
			senderUsername: 'Alice'
		});

		await new Promise((r) => setTimeout(r, 50));

		assert.equal(transfer.recipients.has('bob'), false, 'Bob must not be in recipients');
		assert.equal(transfer.recipients.has('carol'), true, 'Carol must be in recipients');

		assert.equal(receivedBob.length, 0, 'Bob must not receive file announcement');
		assert.equal(receivedCarol.length, 1, 'Carol must receive file announcement');

		const metaCarol = JSON.parse(new TextDecoder().decode(receivedCarol[0].payload));
		assert.equal(metaCarol.type, 'file-meta');
		assert.equal(metaCarol.fileName, 'confidential.bin');

		managerAlice.destroy();
		managerBob.destroy();
		managerCarol.destroy();
	});

	test('File Visibility: startStreamToPeer aborts if peer is file-blocked', async () => {
		let pcAlice!: MockPeerConnection;
		let pcBob = new MockPeerConnection();

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				pcAlice = new MockPeerConnection();
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcBob as unknown as RTCPeerConnection
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerBob, 'bob', pcAlice, pcBob);

		let isBobBlocked = false;
		const senderAlice = new FileSender(managerAlice, {
			isFileBlocked: (peerId) => isBobBlocked && peerId === 'bob'
		});

		const fileData = new Uint8Array([10, 20, 30, 40]);
		const blob = new Blob([fileData], { type: 'application/octet-stream' });
		const transfer = await senderAlice.sendFile(blob, {
			fileName: 'data.bin',
			targetPeers: ['bob']
		});

		// Now block Bob before streaming
		isBobBlocked = true;

		// Simulate Bob sending file-ready
		await senderAlice.handleControlMessage('bob', {
			type: 'file-ready',
			transferId: transfer.transferId,
			peerId: 'bob'
		});

		assert.equal(transfer.recipients.get('bob')?.status, 'offered', 'Streaming must not start for file-blocked peer');

		managerAlice.destroy();
		managerBob.destroy();
	});

	test('File Log Sync: syncFileLogToPeer and handleFileRequest skip file-blocked peers', async () => {
		let pcAlice!: MockPeerConnection;
		let pcBob = new MockPeerConnection();

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				pcAlice = new MockPeerConnection();
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcBob as unknown as RTCPeerConnection
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);
		connectMeshPair(managerAlice, 'alice', managerBob, 'bob', pcAlice, pcBob);

		const receivedBob: any[] = [];
		managerBob.onMessage((sender, payload) => receivedBob.push({ sender, payload }));

		const senderAlice = new FileSender(managerAlice);
		const fileData = new Uint8Array([1, 2, 3]);
		const blob = new Blob([fileData]);
		const transfer = await senderAlice.sendFile(blob, {
			fileName: 'log-file.txt',
			targetPeers: ['bob']
		});

		// Create sync manager with bob file-blocked
		const syncAlice = new FileTransferSyncManager(managerAlice, {
			fileSender: senderAlice,
			isFileBlocked: (peerId) => peerId === 'bob'
		});

		// Wait for initial sendFile to finish transit before testing sync
		await new Promise((r) => setTimeout(r, 50));
		receivedBob.length = 0;
		await syncAlice.syncFileLogToPeer('bob');
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(receivedBob.length, 0, 'syncFileLogToPeer must NOT send FILE_LOG_SYNC to file-blocked peer');

		// Bob tries to request the file anyway
		await syncAlice.handleFileRequest('bob', transfer.transferId);
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(receivedBob.length, 0, 'handleFileRequest must NOT stream file to file-blocked peer');

		syncAlice.destroy();
		managerAlice.destroy();
		managerBob.destroy();
	});

	test('File Visibility: file-blocked peer CAN send files to unblocked peers', async () => {
		let pcBob!: MockPeerConnection;
		let pcAlice = new MockPeerConnection();

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => {
				pcBob = new MockPeerConnection();
				return pcBob as unknown as RTCPeerConnection;
			}
		});

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: () => pcAlice as unknown as RTCPeerConnection
		});

		await managerBob.getOrCreateSession('alice', true);
		await managerAlice.getOrCreateSession('bob', false);
		connectMeshPair(managerBob, 'bob', managerAlice, 'alice', pcBob, pcAlice);

		const receivedAlice: any[] = [];
		managerAlice.onMessage((sender, payload) => receivedAlice.push({ sender, payload }));

		// Bob is file-blocked, but checkIsFileBlocked checks target peers (Alice is unblocked)
		const senderBob = new FileSender(managerBob, {
			isFileBlocked: (peerId) => peerId === 'bob'
		});

		const fileData = new Uint8Array([99, 98, 97]);
		const blob = new Blob([fileData]);
		const transfer = await senderBob.sendFile(blob, {
			fileName: 'bobs-file.bin',
			senderUsername: 'Bob'
		});

		await new Promise((r) => setTimeout(r, 50));

		assert.equal(transfer.recipients.has('alice'), true, 'Alice must be an active recipient of Bob');
		assert.equal(receivedAlice.length, 1, 'Alice must receive file-meta from Bob');

		const meta = JSON.parse(new TextDecoder().decode(receivedAlice[0].payload));
		assert.equal(meta.type, 'file-meta');
		assert.equal(meta.fileName, 'bobs-file.bin');

		managerBob.destroy();
		managerAlice.destroy();
	});
});
