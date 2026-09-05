import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateUsername } from '../src/lib/chat/username.ts';
import { serializeChatMessage, deserializeChatMessage } from '../src/lib/chat/transport.ts';
import { chatStore, type ChatState } from '../src/lib/stores/chat.ts';
import { WebRtcManager } from '../src/lib/webrtc/index.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';

/**
 * Mock RTCDataChannel delivering binary frames asynchronously across peers.
 */
class MockRTCDataChannel {
	public label: string;
	public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
	public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
	public onopen: (() => void) | null = null;
	public onclose: (() => void) | null = null;
	public onerror: ((ev: any) => void) | null = null;
	public onmessage: ((ev: { data: any }) => void) | null = null;

	public sentPackets: (string | Blob | ArrayBuffer | ArrayBufferView)[] = [];
	public peerChannel: MockRTCDataChannel | null = null;

	constructor(label: string) {
		this.label = label;
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

/**
 * Mock RTCPeerConnection for testing WebRtcManager mesh exchange.
 */
class MockRTCPeerConnection {
	public configuration: RTCConfiguration;
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

	public localDataChannels: MockRTCDataChannel[] = [];
	public isClosed = false;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public createDataChannel(label: string): RTCDataChannel {
		const channel = new MockRTCDataChannel(label);
		this.localDataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	public async createOffer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'offer', sdp: 'v=0\r\no=fastchat-test 0 0 IN IP4 127.0.0.1' };
	}

	public async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'answer', sdp: 'v=0\r\no=fastchat-test 0 0 IN IP4 127.0.0.1' };
	}

	public async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = desc;
	}

	public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = desc;
	}

	public async addIceCandidate(): Promise<void> {}

	public async getStats(): Promise<any> {
		return new Map();
	}

	public close(): void {
		this.isClosed = true;
		for (const ch of this.localDataChannels) {
			ch.close();
		}
	}
}

describe('Cosmetic Username Generation', () => {
	test('generates username matching adjective-noun-number format', () => {
		const pattern = /^[a-z]+-[a-z]+-\d{2}$/;
		for (let i = 0; i < 50; i++) {
			const username = generateUsername();
			assert.match(
				username,
				pattern,
				`Username "${username}" does not match required format <adjective>-<noun>-<number>`
			);
		}
	});

	test('generates 2-digit numbers between 10 and 99 inclusive', () => {
		for (let i = 0; i < 100; i++) {
			const username = generateUsername();
			const parts = username.split('-');
			assert.equal(parts.length, 3);
			const num = parseInt(parts[2], 10);
			assert.ok(num >= 10 && num <= 99, `Number ${num} out of expected [10, 99] bounds`);
		}
	});

	test('exhibits high entropy with distinct outputs across multiple calls', () => {
		const names = new Set<string>();
		const count = 100;
		for (let i = 0; i < count; i++) {
			names.add(generateUsername());
		}
		// With 34 adjectives * 28 nouns * 90 numbers = 85,680 combinations,
		// 100 samples should produce overwhelmingly unique names.
		assert.ok(
			names.size > 85,
			`Expected high entropy (>85 unique out of 100), received ${names.size}`
		);
	});
});

describe('Chat Wire Serialization and Deserialization', () => {
	test('successfully serializes and deserializes standard chat payloads', () => {
		const original = {
			type: 'chat' as const,
			id: 'msg-1234-uuid',
			sender: 'swift-fox-42',
			content: 'Hello, encrypted WebRTC world!',
			timestamp: 1725555555000
		};

		const bytes = serializeChatMessage(original);
		assert.ok(bytes instanceof Uint8Array);
		assert.ok(bytes.byteLength > 0);

		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, original);
	});

	test('handles Unicode, emojis, multiline strings, and whitespace', () => {
		const complexContent = 'Zażółć gęślą jaźń! 🚀✨\nSecond line with spaces   and symbols: &<>"\'' ;
		const original = {
			type: 'chat' as const,
			id: 'msg-unicode-test',
			sender: 'keen-otter-99',
			content: complexContent,
			timestamp: Date.now()
		};

		const bytes = serializeChatMessage(original);
		const deserialized = deserializeChatMessage(bytes);
		assert.ok(deserialized);
		assert.equal(deserialized.content, complexContent);
	});

	test('rejects corrupt, incomplete, or malformed byte packets safely', () => {
		const invalidPayloads: (Uint8Array | string)[] = [
			new Uint8Array([]),
			new Uint8Array([0, 1, 2, 3]),
			new TextEncoder().encode('not-json'),
			new TextEncoder().encode('{"type":"other"}'),
			new TextEncoder().encode('{"type":"chat"}'), // missing fields
			new TextEncoder().encode('{"type":"chat","id":"","sender":"a","content":"b","timestamp":1}'), // empty id
			new TextEncoder().encode('{"type":"chat","id":"1","sender":"a","content":123,"timestamp":1}') // invalid content type
		];

		for (const item of invalidPayloads) {
			const bytes = item instanceof Uint8Array ? item : new TextEncoder().encode(item);
			const result = deserializeChatMessage(bytes);
			assert.equal(result, null, 'Should return null for invalid payload');
		}
	});
});

describe('In-Memory Chat Store Lifecycle', () => {
	beforeEach(() => {
		chatStore.reset();
	});

	test('initial state has null username and empty messages array', () => {
		let state!: ChatState;
		const unsub = chatStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.username, null);
		assert.deepEqual(state.messages, []);
	});

	test('initUsername assigns cosmetic name idempotently', () => {
		const name1 = chatStore.initUsername();
		assert.ok(name1 && name1.includes('-'));

		const name2 = chatStore.initUsername('different-name-11');
		// Should remain name1 since it was already initialized
		assert.equal(name2, name1);

		let state!: ChatState;
		const unsub = chatStore.subscribe((s) => {
			state = s;
		});
		unsub();
		assert.equal(state.username, name1);
	});

	test('addMessage appends messages and deduplicates identical IDs', () => {
		const msg1 = {
			id: 'msg-1',
			sender: 'swift-fox-42',
			content: 'First message',
			timestamp: 1000,
			isSelf: true
		};

		const msg2 = {
			id: 'msg-2',
			sender: 'brave-wolf-88',
			content: 'Second message',
			timestamp: 2000,
			isSelf: false
		};

		chatStore.addMessage(msg1);
		chatStore.addMessage(msg2);
		chatStore.addMessage(msg1); // duplicate

		let state!: ChatState;
		const unsub = chatStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.messages.length, 2);
		assert.deepEqual(state.messages[0], msg1);
		assert.deepEqual(state.messages[1], msg2);
	});

	test('reset clears all messages and resets assigned username', () => {
		chatStore.initUsername('test-user-55');
		chatStore.addMessage({
			id: 'msg-x',
			sender: 'test-user-55',
			content: 'Hello',
			timestamp: 1000,
			isSelf: true
		});

		chatStore.reset();

		let state!: ChatState;
		const unsub = chatStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.username, null);
		assert.deepEqual(state.messages, []);
	});
});

describe('WebRTC Mesh Encrypted Chat Message Transmission', () => {
	test('transmits encrypted chat message between two peers via DataChannel', async () => {
		const testKey = await deriveInitialKey('1234-5678-9012', 'room-crypto-salt');

		let pcAlice: MockRTCPeerConnection | null = null;
		let pcBob: MockRTCPeerConnection | null = null;

		const managerAlice = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcAlice = new MockRTCPeerConnection(cfg);
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: testKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcBob = new MockRTCPeerConnection(cfg);
				return pcBob as unknown as RTCPeerConnection;
			}
		});

		// Alice creates session to Bob (Alice is initiator)
		await managerAlice.getOrCreateSession('bob', true);
		// Bob creates session to Alice
		await managerBob.getOrCreateSession('alice', false);

		// Wire up loopback mock data channels
		const aliceDc = pcAlice!.localDataChannels[0];
		const bobDc = new MockRTCDataChannel('fastchat-data');
		aliceDc.peerChannel = bobDc;
		bobDc.peerChannel = aliceDc;
		pcBob!.ondatachannel?.({ channel: bobDc });

		aliceDc.open();
		bobDc.open();

		// Track Bob's received chat messages
		const bobReceivedMessages: any[] = [];
		managerBob.onMessage((senderPeerId, payload) => {
			const chatPayload = deserializeChatMessage(payload);
			if (chatPayload) {
				bobReceivedMessages.push({
					...chatPayload,
					senderPeerId
				});
			}
		});

		// Alice broadcasts an encrypted chat message
		const chatWire = {
			type: 'chat' as const,
			id: 'chat-uuid-001',
			sender: 'swift-fox-42',
			content: 'Secret peer message encrypted with AES-256-GCM',
			timestamp: 1725555599000
		};

		const serialized = serializeChatMessage(chatWire);
		await managerAlice.broadcast(serialized);

		// Allow microtask delivery
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(bobReceivedMessages.length, 1);
		assert.equal(bobReceivedMessages[0].id, 'chat-uuid-001');
		assert.equal(bobReceivedMessages[0].sender, 'swift-fox-42');
		assert.equal(bobReceivedMessages[0].content, 'Secret peer message encrypted with AES-256-GCM');
		assert.equal(bobReceivedMessages[0].senderPeerId, 'alice');

		// Verify that the sent raw packet across the data channel was encrypted (ciphertext + tag)
		assert.equal(aliceDc.sentPackets.length, 1);
		const rawPacket = aliceDc.sentPackets[0] as ArrayBuffer;
		const rawPacketBytes = new Uint8Array(rawPacket);
		const rawString = new TextDecoder().decode(rawPacketBytes);

		// The raw transmitted frame must NOT contain plaintext words
		assert.equal(rawString.includes('Secret peer message'), false);
		assert.equal(rawString.includes('swift-fox-42'), false);

		managerAlice.destroy();
		managerBob.destroy();
	});
});

describe('Zero Persistence & Zero Signaling Plaintext Audit', () => {
	test('no localStorage or sessionStorage present in chat source files', () => {
		const files = [
			'src/lib/chat/username.ts',
			'src/lib/chat/types.ts',
			'src/lib/chat/transport.ts',
			'src/lib/stores/chat.ts'
		];

		for (const relPath of files) {
			const fullPath = join(process.cwd(), relPath);
			const content = readFileSync(fullPath, 'utf8');
			assert.equal(
				content.includes('localStorage'),
				false,
				`Forbidden localStorage found in ${relPath}`
			);
			assert.equal(
				content.includes('sessionStorage'),
				false,
				`Forbidden sessionStorage found in ${relPath}`
			);
		}
	});
});
