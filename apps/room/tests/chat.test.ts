import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateUsername } from '../src/lib/chat/username.ts';
import type {
	ChatMessage,
	ChatWirePayload,
	MessageSegment,
	ChatHistoryItem,
	ChatHistorySyncWirePayload
} from '../src/lib/chat/types.ts';
import { CHAT_HISTORY_SYNC_TYPE } from '../src/lib/chat/types.ts';
import {
	serializeChatMessage,
	deserializeChatMessage,
	serializeChatHistorySync,
	deserializeChatHistorySync,
	MAX_HISTORY_SYNC_MESSAGES
} from '../src/lib/chat/transport.ts';
import { ChatHistorySyncManager } from '../src/lib/chat/historySync.ts';
import { formatChatLog, downloadChatLog } from '../src/lib/chat/export.ts';

import {
	countLines,
	isLongPastedText,
	formatPastedLabel,
	composeFinalMessage,
	createPastedBlock,
	buildMessageSegments,
	setPastedBlockLanguageMode,
	updatePastedBlockContent,
	type PastedBlock,
	type ComposerBlock
} from '../src/lib/chat/pastedSnippet.ts';
import { isCodeSnippet } from '../src/lib/chat/codeDetection.ts';
import {
	detectLanguage,
	getLanguageDisplayName,
	SUPPORTED_LANGUAGES,
	type SupportedLanguage
} from '../src/lib/chat/languageDetection.ts';
import {
	highlightCode,
	escapeHtml,
	loadLanguageGrammar
} from '../src/lib/chat/highlighter.ts';
import { chatStore, createChatStore, type ChatState } from '../src/lib/stores/chat.ts';

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
		const original: ChatWirePayload = {
			type: 'chat',
			id: 'msg-1234-uuid',
			sender: 'swift-fox-42',
			timestamp: 1725555555000,
			segments: [{ type: 'text', text: 'Hello, encrypted WebRTC world!' }]
		};

		const bytes = serializeChatMessage(original);
		assert.ok(bytes instanceof Uint8Array);
		assert.ok(bytes.byteLength > 0);

		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, original);
	});

	test('handles Unicode, emojis, multiline strings, and whitespace', () => {
		const complexContent = 'Zażółć gęślą jaźń! 🚀✨\nSecond line with spaces   and symbols: &<>"\'' ;
		const original: ChatWirePayload = {
			type: 'chat',
			id: 'msg-unicode-test',
			sender: 'keen-otter-99',
			timestamp: Date.now(),
			segments: [{ type: 'text', text: complexContent }]
		};

		const bytes = serializeChatMessage(original);
		const deserialized = deserializeChatMessage(bytes);
		assert.ok(deserialized);
		assert.equal(deserialized.segments[0].type, 'text');
		assert.equal((deserialized.segments[0] as any).text, complexContent);
	});

	test('rejects corrupt, incomplete, or malformed byte packets safely', () => {
		const invalidPayloads: (Uint8Array | string)[] = [
			new Uint8Array([]),
			new Uint8Array([0, 1, 2, 3]),
			new TextEncoder().encode('not-json'),
			new TextEncoder().encode('{"type":"other"}'),
			new TextEncoder().encode('{"type":"chat"}'), // missing fields
			new TextEncoder().encode('{"type":"chat","id":"","sender":"a","timestamp":1,"segments":[]}'), // empty id
			new TextEncoder().encode('{"type":"chat","id":"1","sender":"a","timestamp":1,"segments":[]}'), // empty segments array
			new TextEncoder().encode('{"type":"chat","id":"1","sender":"a","timestamp":1,"segments":"invalid"}'), // non-array segments
			new TextEncoder().encode('{"type":"chat","id":"1","sender":"a","timestamp":1,"segments":[{}]}'), // malformed segment
			new TextEncoder().encode('{"type":"chat","id":"1","sender":"a","timestamp":1,"segments":[{"type":"unknown"}]}') // unknown segment type
		];

		for (const item of invalidPayloads) {
			const bytes = item instanceof Uint8Array ? item : new TextEncoder().encode(item);
			const result = deserializeChatMessage(bytes);
			assert.equal(result, null, 'Should return null for invalid payload');
		}
	});

	test('rejects payloads exceeding MAX_SEGMENTS_PER_MESSAGE bound', () => {
		const tooManySegments: MessageSegment[] = Array.from({ length: 51 }, (_, i) => ({
			type: 'text' as const,
			text: `Line ${i}`
		}));
		const payload: ChatWirePayload = {
			type: 'chat',
			id: 'msg-oversized-segments',
			sender: 'swift-fox-42',
			timestamp: Date.now(),
			segments: tooManySegments
		};
		const bytes = serializeChatMessage(payload);
		const deserialized = deserializeChatMessage(bytes);
		assert.equal(deserialized, null, 'Should reject payload with > 50 segments');
	});

	test('serializes and deserializes code messages with detected or manual language', () => {
		const codeMessage: ChatWirePayload = {
			type: 'chat',
			id: 'msg-code-payload-1',
			sender: 'swift-fox-42',
			timestamp: 1725555555000,
			segments: [{
				type: 'code',
				code: 'fn main() {\n    println!("hello");\n}',
				language: 'rust'
			}]
		};

		const bytes = serializeChatMessage(codeMessage);
		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, codeMessage);
	});

	test('serializes and deserializes code messages with null language', () => {
		const codeMessage: ChatWirePayload = {
			type: 'chat',
			id: 'msg-code-payload-2',
			sender: 'swift-fox-42',
			timestamp: 1725555555000,
			segments: [{
				type: 'code',
				code: 'echo "plain code snippet"',
				language: null
			}]
		};

		const bytes = serializeChatMessage(codeMessage);
		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, codeMessage);
	});

	test('serializes and deserializes multi-segment payload with mixed text and code', () => {
		const multiSegmentMessage: ChatWirePayload = {
			type: 'chat',
			id: 'msg-multi-1',
			sender: 'swift-fox-42',
			timestamp: 1725555555000,
			segments: [
				{ type: 'text', text: 'Here is the implementation:' },
				{ type: 'code', code: 'const x = 42;', language: 'javascript' },
				{ type: 'text', text: 'And here is what we do next.' }
			]
		};

		const bytes = serializeChatMessage(multiSegmentMessage);
		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, multiSegmentMessage);
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
		const msg1: ChatMessage = {
			id: 'msg-1',
			sender: 'swift-fox-42',
			segments: [{ type: 'text', text: 'First message' }],
			timestamp: 1000,
			isSelf: true
		};

		const msg2: ChatMessage = {
			id: 'msg-2',
			sender: 'brave-wolf-88',
			segments: [{ type: 'text', text: 'Second message' }],
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
			segments: [{ type: 'text', text: 'Hello' }],
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

	test('addSystemMessage appends system announcements with proper attributes', () => {
		chatStore.reset();
		chatStore.addSystemMessage('Room created.');
		chatStore.addSystemMessage('Peer peer-123 joined the room.');

		let state!: ChatState;
		const unsub = chatStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.messages.length, 2);
		assert.equal(state.messages[0].sender, 'System');
		assert.deepEqual(state.messages[0].segments, [{ type: 'text', text: 'Room created.' }]);
		assert.equal(state.messages[0].isSystem, true);
		assert.equal(state.messages[0].isSelf, false);
		assert.match(state.messages[0].id, /^sys-\d+-[a-z0-9]+$/);

		assert.equal(state.messages[1].sender, 'System');
		assert.deepEqual(state.messages[1].segments, [{ type: 'text', text: 'Peer peer-123 joined the room.' }]);
		assert.equal(state.messages[1].isSystem, true);
		assert.equal(state.messages[1].isSelf, false);

		// Verify export formatting
		const log = formatChatLog('1234-5678-9012', state.messages);
		assert.match(log, /\[SYSTEM\]: Room created\./);
		assert.match(log, /\[SYSTEM\]: Peer peer-123 joined the room\./);
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
		const chatWire: ChatWirePayload = {
			type: 'chat',
			id: 'chat-uuid-001',
			sender: 'swift-fox-42',
			segments: [{ type: 'text', text: 'Secret peer message encrypted with AES-256-GCM' }],
			timestamp: 1725555599000
		};

		const serialized = serializeChatMessage(chatWire);
		await managerAlice.broadcast(serialized);

		// Allow microtask delivery
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(bobReceivedMessages.length, 1);
		assert.equal(bobReceivedMessages[0].id, 'chat-uuid-001');
		assert.equal(bobReceivedMessages[0].sender, 'swift-fox-42');
		assert.deepEqual(bobReceivedMessages[0].segments, [{ type: 'text', text: 'Secret peer message encrypted with AES-256-GCM' }]);
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

describe('Client-Side Chat Log Formatting & Export', () => {
	test('formats empty chat log with session header and empty notice', () => {
		const exportDate = new Date('2026-09-05T18:30:00.000Z');
		const result = formatChatLog('1234-5678-9012', [], exportDate);

		assert.ok(result.includes('FastChat Room Chat Log'));
		assert.ok(result.includes('Room Code:    1234-5678-9012'));
		assert.ok(result.includes('Exported At:  2026-09-05 18:30:00 UTC'));
		assert.ok(result.includes('Messages:     0'));
		assert.ok(result.includes('(No messages recorded in this session)'));
		assert.ok(result.includes('End of Chat Log'));
	});

	test('formats populated chat history with chronological timestamps and sender badges', () => {
		const messages: ChatMessage[] = [
			{
				id: 'm1',
				sender: 'swift-fox-42',
				segments: [{ type: 'text', text: 'Hello everyone!' }],
				timestamp: new Date('2026-09-05T18:00:15.000Z').getTime(),
				isSelf: true
			},
			{
				id: 'm2',
				sender: 'calm-badger-19',
				segments: [{ type: 'text', text: 'Hey swift-fox, encrypted P2P mesh established.' }],
				timestamp: new Date('2026-09-05T18:01:05.000Z').getTime(),
				isSelf: false
			}
		];

		const result = formatChatLog('0000-1111-2222', messages, new Date('2026-09-05T18:05:00.000Z'));

		assert.ok(result.includes('Room Code:    0000-1111-2222'));
		assert.ok(result.includes('Messages:     2'));
		assert.ok(result.includes('[18:00:15] swift-fox-42 (You): Hello everyone!'));
		assert.ok(result.includes('[18:01:05] calm-badger-19: Hey swift-fox, encrypted P2P mesh established.'));
	});

	test('downloadChatLog executes cleanly and creates anchor download in browser environment', () => {
		// Verify no-op in SSR without window
		assert.doesNotThrow(() => {
			downloadChatLog('test.txt', 'sample content');
		});

		// Simulate browser DOM environment
		let createdBlob: Blob | null = null;
		let objectUrlCreated = '';
		let revokedUrl = '';
		let clicked = false;
		let appendedChild: any = null;
		let removedChild: any = null;

		const mockAnchor = {
			href: '',
			download: '',
			style: { display: '' },
			click: () => {
				clicked = true;
			}
		};

		const originalWindow = (global as any).window;
		const originalDocument = (global as any).document;
		const originalURL = (global as any).URL;

		try {
			(global as any).window = {};
			(global as any).document = {
				createElement: (tag: string) => {
					if (tag === 'a') return mockAnchor;
					return {};
				},
				body: {
					appendChild: (el: any) => {
						appendedChild = el;
					},
					removeChild: (el: any) => {
						removedChild = el;
					}
				}
			};
			(global as any).URL = {
				createObjectURL: (b: Blob) => {
					createdBlob = b;
					objectUrlCreated = 'blob:http://localhost/test-uuid';
					return objectUrlCreated;
				},
				revokeObjectURL: (u: string) => {
					revokedUrl = u;
				}
			};

			downloadChatLog('fastchat-export.txt', 'Decrypted log payload');

			assert.ok(createdBlob);
			assert.equal((createdBlob as any).type, 'text/plain;charset=utf-8');
			assert.equal(mockAnchor.download, 'fastchat-export.txt');
			assert.equal(mockAnchor.href, 'blob:http://localhost/test-uuid');
			assert.equal(clicked, true);
			assert.equal(appendedChild, mockAnchor);
			assert.equal(removedChild, mockAnchor);
			assert.equal(revokedUrl, 'blob:http://localhost/test-uuid');
		} finally {
			(global as any).window = originalWindow;
			(global as any).document = originalDocument;
			(global as any).URL = originalURL;
		}
	});
});

describe('Pasted Snippet Drafting & Containment', () => {
	test('counts lines accurately across CRLF, LF, and CR delimiters', () => {
		assert.equal(countLines(''), 0);
		assert.equal(countLines('single line text'), 1);
		assert.equal(countLines('line 1\nline 2\nline 3'), 3);
		assert.equal(countLines('line 1\r\nline 2\r\nline 3\r\nline 4'), 4);
		assert.equal(countLines('line 1\rline 2'), 2);
	});

	test('isLongPastedText detects multiline or long text exceeding thresholds', () => {
		// Short text under 3 lines and under 250 characters -> false
		assert.equal(isLongPastedText('hello world'), false);
		assert.equal(isLongPastedText('line one\nline two'), false);
		assert.equal(isLongPastedText(''), false);

		// 3 or more lines -> true
		assert.equal(isLongPastedText('one\ntwo\nthree'), true);
		assert.equal(isLongPastedText('one\r\ntwo\r\nthree\r\nfour'), true);

		// Long single line > 250 characters -> true
		const longSingleLine = 'a'.repeat(251);
		assert.equal(isLongPastedText(longSingleLine), true);

		// Single line <= 250 characters -> false
		const shortSingleLine = 'a'.repeat(250);
		assert.equal(isLongPastedText(shortSingleLine), false);
	});

	test('formatPastedLabel generates clean singular and plural labels', () => {
		assert.equal(formatPastedLabel(1), '[ Pasted 1 Line of Text ]');
		assert.equal(formatPastedLabel(2), '[ Pasted 2 Lines of Text ]');
		assert.equal(formatPastedLabel(15), '[ Pasted 15 Lines of Text ]');
		assert.equal(formatPastedLabel(0), '[ Pasted 1 Line of Text ]');
	});

	test('formatPastedLabel generates clean labels with detected or manual language', () => {
		assert.equal(formatPastedLabel(47, 'javascript', true), '[ Pasted 47 Lines · JavaScript ]');
		assert.equal(formatPastedLabel(1, 'rust', true), '[ Pasted 1 Line · Rust ]');
		assert.equal(formatPastedLabel(12, null, true), '[ Pasted 12 Lines · Code ]');
		assert.equal(formatPastedLabel(8, 'python'), '[ Pasted 8 Lines · Python ]');
		assert.equal(formatPastedLabel(10, null, false), '[ Pasted 10 Lines of Text ]');
	});

	test('composeFinalMessage joins input text and pasted snippet blocks cleanly', () => {
		const blocks: PastedBlock[] = [
			createPastedBlock('const x = 1;\nconsole.log(x);', { id: 'b1' }),
			createPastedBlock('Some extra log line', { id: 'b2' })
		];

		// Both typed input and blocks
		const result1 = composeFinalMessage('Check this snippet:', blocks);
		assert.equal(
			result1,
			'Check this snippet:\n\nconst x = 1;\nconsole.log(x);\n\nSome extra log line'
		);

		// Only blocks, empty typed input
		const result2 = composeFinalMessage('   ', blocks);
		assert.equal(result2, 'const x = 1;\nconsole.log(x);\n\nSome extra log line');

		// Only typed input, empty blocks
		const result3 = composeFinalMessage('Hello peer', []);
		assert.equal(result3, 'Hello peer');

		// Empty input and empty blocks
		assert.equal(composeFinalMessage('', []), '');
	});

	test('buildMessageSegments creates separate segments for text preceding a pasted code block without gluing', () => {
		const jsCode = 'const calculateTotal = (items) => {\n  return items.reduce((a, b) => a + b, 0);\n};';
		const codeBlock = createPastedBlock(jsCode, { id: 'p1' });

		const composerSequence: ComposerBlock[] = [
			{ kind: 'text', id: 't1', text: 'Here is the helper function:' },
			{ kind: 'paste', ...codeBlock }
		];

		const segments = buildMessageSegments(composerSequence);
		assert.equal(segments.length, 2, 'Must yield exactly two segments');
		assert.deepEqual(segments[0], {
			type: 'text',
			text: 'Here is the helper function:'
		});
		assert.deepEqual(segments[1], {
			type: 'code',
			code: jsCode,
			language: 'javascript'
		});
	});

	test('buildMessageSegments creates separate segments for companion text following a pasted code block without gluing', () => {
		const rustCode = 'fn main() {\n    println!("WebRTC mesh running");\n}';
		const codeBlock = createPastedBlock(rustCode, { id: 'p2' });

		const composerSequence: ComposerBlock[] = [
			{ kind: 'paste', ...codeBlock }
		];

		const segments = buildMessageSegments(composerSequence, 'What do you think of this Rust implementation?');
		assert.equal(segments.length, 2, 'Must yield exactly two segments');
		assert.deepEqual(segments[0], {
			type: 'code',
			code: rustCode,
			language: 'rust'
		});
		assert.deepEqual(segments[1], {
			type: 'text',
			text: 'What do you think of this Rust implementation?'
		});
	});

	test('buildMessageSegments preserves multiple independent code blocks with their individual detected languages', () => {
		const jsCode = 'const sum = (a, b) => {\n  console.log(a, b);\n  return a + b;\n};';
		const rustCode = 'fn compute() -> Result<u32, ()> {\n    let mut total = 0;\n    Ok(total)\n}';

		const block1 = createPastedBlock(jsCode, { id: 'paste-js' });
		const block2 = createPastedBlock(rustCode, { id: 'paste-rust' });

		assert.equal(block1.language, 'javascript');
		assert.equal(block2.language, 'rust');

		const composerSequence: ComposerBlock[] = [
			{ kind: 'text', id: 'intro', text: 'Comparing JS and Rust implementations:' },
			{ kind: 'paste', ...block1 },
			{ kind: 'text', id: 'mid', text: 'And the Rust equivalent:' },
			{ kind: 'paste', ...block2 }
		];

		const segments = buildMessageSegments(composerSequence, 'Both handle summation correctly.');
		assert.equal(segments.length, 5);
		assert.deepEqual(segments[0], { type: 'text', text: 'Comparing JS and Rust implementations:' });
		assert.deepEqual(segments[1], { type: 'code', code: jsCode, language: 'javascript' });
		assert.deepEqual(segments[2], { type: 'text', text: 'And the Rust equivalent:' });
		assert.deepEqual(segments[3], { type: 'code', code: rustCode, language: 'rust' });
		assert.deepEqual(segments[4], { type: 'text', text: 'Both handle summation correctly.' });
	});

	test('selecting "Plain Text" on a detected C++ snippet permanently sets contentType to text and never reverts on edits', () => {
		const cppCode = '#include <iostream>\n\nint main() {\n    std::cout << "FastChat Room" << std::endl;\n    return 0;\n}';
		const block = createPastedBlock(cppCode, { id: 'cpp-block' });

		// Auto-detection initially identifies C++
		assert.equal(block.languageMode, 'auto');
		assert.equal(block.contentType, 'code');
		assert.equal(block.language, 'cpp');

		// User explicitly chooses "Plain Text" from the dropdown
		setPastedBlockLanguageMode(block, 'text');
		assert.equal(block.languageMode, 'manual');
		assert.equal(block.contentType, 'text');
		assert.equal(block.language, null);

		// Subsequent user edit with more C++ code must NEVER revert to C++
		const updatedCpp = '#include <vector>\n#include <algorithm>\n\nint main() {\n    std::vector<int> v = {1, 2, 3};\n    return 0;\n}';
		updatePastedBlockContent(block, updatedCpp);

		assert.equal(block.languageMode, 'manual');
		assert.equal(block.contentType, 'text');
		assert.equal(block.language, null, 'Must remain plain text without language tags');

		// Final outbound segment must be a plain text segment
		const segments = buildMessageSegments([{ kind: 'paste', ...block }]);
		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0], {
			type: 'text',
			text: updatedCpp
		});
	});

	test('selecting "Plain Code" permanently locks unhighlighted code with language null across edits', () => {
		const jsCode = 'const data = [1, 2, 3];\nconsole.log(data);';
		const block = createPastedBlock(jsCode, { id: 'plain-code-block' });

		assert.equal(block.languageMode, 'auto');
		assert.equal(block.language, 'javascript');

		// User explicitly chooses "Plain Code"
		setPastedBlockLanguageMode(block, 'code');
		assert.equal(block.languageMode, 'manual');
		assert.equal(block.contentType, 'code');
		assert.equal(block.language, null);

		// User edits snippet to Python code - manual lock must hold
		const pyCode = 'def process_items():\n    for item in range(10):\n        print(item)';
		updatePastedBlockContent(block, pyCode);

		assert.equal(block.languageMode, 'manual');
		assert.equal(block.contentType, 'code');
		assert.equal(block.language, null, 'Language must remain null even if edited with recognizable language syntax');

		const segments = buildMessageSegments([{ kind: 'paste', ...block }]);
		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0], {
			type: 'code',
			code: pyCode,
			language: null
		});
	});

	test('explicitly choosing "auto" restores reactive heuristic detection', () => {
		const block = createPastedBlock('Some unclassified text', { id: 'revert-auto' });
		setPastedBlockLanguageMode(block, 'rust');
		assert.equal(block.languageMode, 'manual');
		assert.equal(block.language, 'rust');

		// Explicit user action to re-enable auto detection
		const sqlCode = 'SELECT id, username FROM users WHERE active = 1 ORDER BY id DESC;';
		block.content = sqlCode;
		setPastedBlockLanguageMode(block, 'auto');

		assert.equal(block.languageMode, 'auto');
		assert.equal(block.contentType, 'code');
		assert.equal(block.language, 'sql');
	});
});

describe('Heuristic Code Detection (isCodeSnippet)', () => {
	test('positively identifies JavaScript and TypeScript code blocks', () => {
		const jsFunction = 'function multiply(x, y) {\n  return x * y;\n}';
		const tsArrow = 'const add = (a: number, b: number): number => {\n  return a + b;\n};';
		const oneLiner = 'const x = [1, 2, 3].map(n => n * 2);';

		assert.equal(isCodeSnippet(jsFunction), true);
		assert.equal(isCodeSnippet(tsArrow), true);
		assert.equal(isCodeSnippet(oneLiner), true);
	});

	test('positively identifies Python code blocks', () => {
		const pyFunc = 'def calculate_total(items):\n    total = 0\n    for item in items:\n        total += item.price\n    return total';
		assert.equal(isCodeSnippet(pyFunc), true);
	});

	test('positively identifies Rust code blocks', () => {
		const rustCode = 'fn main() {\n    let mut count = 0;\n    println!("count: {}", count);\n}';
		assert.equal(isCodeSnippet(rustCode), true);
	});

	test('positively identifies Go code blocks', () => {
		const goCode = 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello WebRTC")\n}';
		assert.equal(isCodeSnippet(goCode), true);
	});

	test('positively identifies HTML and markup blocks', () => {
		const htmlSnippet = '<div class="container">\n  <p>Encrypted P2P payload</p>\n</div>';
		assert.equal(isCodeSnippet(htmlSnippet), true);
	});

	test('positively identifies JSON data structures', () => {
		const jsonSnippet = '{\n  "name": "FastChat",\n  "encrypted": true,\n  "count": 42\n}';
		assert.equal(isCodeSnippet(jsonSnippet), true);
	});

	test('positively identifies SQL query statements', () => {
		const sqlSnippet = 'SELECT id, username, email FROM users WHERE is_active = 1 ORDER BY created_at DESC;';
		assert.equal(isCodeSnippet(sqlSnippet), true);
	});

	test('positively identifies Bash shell commands and scripts', () => {
		const bashSnippet = '#!/bin/bash\necho "Starting deployment..."\nsudo systemctl restart fastchat';
		const npmSnippet = 'npm install -D tailwindcss @sveltejs/kit';
		assert.equal(isCodeSnippet(bashSnippet), true);
		assert.equal(isCodeSnippet(npmSnippet), true);
	});

	test('positively identifies CSS stylesheet rules', () => {
		const cssSnippet = '.card {\n  display: flex;\n  margin: 10px;\n  color: #ffffff;\n}';
		assert.equal(isCodeSnippet(cssSnippet), true);
	});

	test('does NOT falsely identify normal conversational text as code', () => {
		const conversational1 = 'Hello, how are you doing today?';
		const conversational2 = 'Cześć! Co tam u Ciebie? Spotkamy się dzisiaj o 18:00?';
		const conversational3 = 'The quick brown fox jumps over the lazy dog. It was a sunny afternoon.';
		const conversational4 = 'Yes, I agree with your proposal. Let us discuss this tomorrow morning.';
		const conversational5 = 'Please review the document attached in the email.';
		const conversational6 = 'Thanks for the update! Everything looks great so far.';
		const conversational7 = 'Can you send me the link? https://example.com/page?id=123';
		const numberedList = '1. First step\n2. Second step\n3. Third step';

		assert.equal(isCodeSnippet(conversational1), false);
		assert.equal(isCodeSnippet(conversational2), false);
		assert.equal(isCodeSnippet(conversational3), false);
		assert.equal(isCodeSnippet(conversational4), false);
		assert.equal(isCodeSnippet(conversational5), false);
		assert.equal(isCodeSnippet(conversational6), false);
		assert.equal(isCodeSnippet(conversational7), false);
		assert.equal(isCodeSnippet(numberedList), false);
	});

	test('handles edge cases: empty strings, whitespace, null/undefined', () => {
		assert.equal(isCodeSnippet(''), false);
		assert.equal(isCodeSnippet('   \n  \t '), false);
		assert.equal(isCodeSnippet(null as any), false);
		assert.equal(isCodeSnippet(undefined as any), false);
	});
});

describe('Heuristic Language Detection (detectLanguage)', () => {
	test('correctly identifies JavaScript and TypeScript', () => {
		const jsCode = 'const greet = (name) => {\n  console.log("Hello " + name);\n};';
		assert.equal(detectLanguage(jsCode), 'javascript');

		const tsCode = 'interface UserProfile {\n  id: string;\n  count: number;\n}\nconst role = "admin" as const;';
		assert.equal(detectLanguage(tsCode), 'typescript');
	});

	test('correctly identifies Python', () => {
		const pyCode = 'def fetch_records(limit):\n    records = []\n    for idx in range(limit):\n        records.append(idx)\n    return records';
		assert.equal(detectLanguage(pyCode), 'python');
	});

	test('correctly identifies Rust', () => {
		const rustCode = 'fn compute() -> Result<u32, &str> {\n    let mut sum: u32 = 0;\n    println!("sum: {}", sum);\n    Ok(sum)\n}';
		assert.equal(detectLanguage(rustCode), 'rust');
	});

	test('correctly identifies Go', () => {
		const goCode = 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("P2P Mesh")\n}';
		assert.equal(detectLanguage(goCode), 'go');
	});

	test('correctly identifies Java', () => {
		const javaCode = 'public class RoomManager {\n    public static void main(String[] args) {\n        System.out.println("Room init");\n    }\n}';
		assert.equal(detectLanguage(javaCode), 'java');
	});

	test('correctly identifies C and C++', () => {
		const cCode = '#include <stdio.h>\n\nint main() {\n    printf("Encrypted bytes\\n");\n    return 0;\n}';
		assert.equal(detectLanguage(cCode), 'c');

		const cppCode = '#include <iostream>\n\nint main() {\n    std::cout << "FastChat Room" << std::endl;\n    return 0;\n}';
		assert.equal(detectLanguage(cppCode), 'cpp');
	});

	test('correctly identifies C#', () => {
		const csCode = 'using System;\n\nnamespace FastChat {\n    public class PeerHandler {\n        public string Name { get; set; }\n    }\n}';
		assert.equal(detectLanguage(csCode), 'csharp');
	});

	test('correctly identifies HTML and CSS', () => {
		const htmlCode = '<!DOCTYPE html>\n<html>\n<body>\n  <div class="box"><p>Content</p></div>\n</body>\n</html>';
		assert.equal(detectLanguage(htmlCode), 'html');

		const cssCode = '.terminal-container {\n  display: flex;\n  background: #030407;\n  color: #00e5ff;\n  padding: 16px;\n}';
		assert.equal(detectLanguage(cssCode), 'css');
	});

	test('correctly identifies JSON', () => {
		const jsonCode = '{\n  "status": "connected",\n  "peerCount": 4,\n  "encryption": "AES-256-GCM"\n}';
		assert.equal(detectLanguage(jsonCode), 'json');
	});

	test('correctly identifies SQL', () => {
		const sqlCode = 'SELECT users.id, accounts.balance FROM users JOIN accounts ON users.id = accounts.user_id WHERE balance > 1000;';
		assert.equal(detectLanguage(sqlCode), 'sql');
	});

	test('correctly identifies Bash shell scripts', () => {
		const bashCode = '#!/bin/bash\necho "Running test"\nsudo apt update';
		assert.equal(detectLanguage(bashCode), 'bash');
	});

	test('correctly identifies PHP', () => {
		const phpCode = '<?php\necho "Hello from server";\n$response = $_GET["action"];';
		assert.equal(detectLanguage(phpCode), 'php');
	});

	test('returns null for ambiguous or unrecognized code snippets', () => {
		assert.equal(detectLanguage('x = 1'), null);
		assert.equal(detectLanguage(''), null);
		assert.equal(detectLanguage(null as any), null);
	});

	test('getLanguageDisplayName returns formatted names', () => {
		assert.equal(getLanguageDisplayName('javascript'), 'JavaScript');
		assert.equal(getLanguageDisplayName('typescript'), 'TypeScript');
		assert.equal(getLanguageDisplayName('python'), 'Python');
		assert.equal(getLanguageDisplayName('rust'), 'Rust');
		assert.equal(getLanguageDisplayName('cpp'), 'C++');
		assert.equal(getLanguageDisplayName('csharp'), 'C#');
		assert.equal(getLanguageDisplayName(null), 'Code');
		assert.equal(getLanguageDisplayName('unknown-lang'), 'UNKNOWN-LANG');
	});
});

describe('Syntax Highlighting & Safe Fallback (highlighter.ts)', () => {
	test('escapeHtml sanitizes all dangerous HTML characters', () => {
		const raw = '<script>alert("XSS & theft")</script>\'test\'';
		const escaped = escapeHtml(raw);
		assert.equal(escaped.includes('<script>'), false);
		assert.equal(escaped.includes('&lt;script&gt;'), true);
		assert.equal(escaped.includes('&amp;'), true);
		assert.equal(escaped.includes('&quot;'), true);
		assert.equal(escaped.includes('&#039;'), true);
	});

	test('highlightCode safely returns escaped HTML for empty or null language', async () => {
		const snippet = '<div>Plain text or unclassified code</div>';
		const resultNull = await highlightCode(snippet, null);
		assert.equal(resultNull, '&lt;div&gt;Plain text or unclassified code&lt;/div&gt;');

		const resultEmpty = await highlightCode(snippet, '');
		assert.equal(resultEmpty, '&lt;div&gt;Plain text or unclassified code&lt;/div&gt;');
	});

	test('highlightCode dynamically loads grammar and returns highlighted tokens for JavaScript', async () => {
		const jsCode = 'const count = 42;';
		const result = await highlightCode(jsCode, 'javascript');
		assert.ok(result.includes('token keyword'));
		assert.ok(result.includes('token number'));
		assert.ok(result.includes('42'));
	});

	test('highlightCode dynamically loads grammar and returns highlighted tokens for Python', async () => {
		const pyCode = 'def calculate(): pass';
		const result = await highlightCode(pyCode, 'python');
		assert.ok(result.includes('token keyword'));
		assert.ok(result.includes('token function'));
	});

	test('highlightCode dynamically loads grammar and returns highlighted tokens for Rust', async () => {
		const rustCode = 'fn compute() { println!("hi"); }';
		const result = await highlightCode(rustCode, 'rust');
		assert.ok(result.includes('token keyword'));
		assert.ok(result.includes('token function'));
	});

	test('highlightCode falls back cleanly to escaped text for unknown language', async () => {
		const snippet = 'some-custom-syntax { flag: true }';
		const result = await highlightCode(snippet, 'nonexistent-lang');
		assert.equal(result, 'some-custom-syntax { flag: true }');
	});

	test('loadLanguageGrammar reports false for unsupported languages without throwing', async () => {
		const loaded = await loadLanguageGrammar('unsupported-xyz');
		assert.equal(loaded, false);
	});
});

describe('Zero Persistence & Zero Signaling Plaintext Audit', () => {
	test('no localStorage or sessionStorage present in chat source files', () => {
		const files = [
			'src/lib/chat/username.ts',
			'src/lib/chat/types.ts',
			'src/lib/chat/transport.ts',
			'src/lib/chat/export.ts',
			'src/lib/chat/pastedSnippet.ts',
			'src/lib/chat/codeDetection.ts',
			'src/lib/chat/languageDetection.ts',
			'src/lib/chat/highlighter.ts',
			'src/lib/chat/historySync.ts',
			'src/lib/stores/chat.ts'
		];


		for (const relPath of files) {
			const fullPath = new URL(`../${relPath}`, import.meta.url);
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

describe('P2P Chat History Synchronization Wire Protocol', () => {
	test('successfully serializes and deserializes chat history payloads', () => {
		const originalHistory: ChatMessage[] = [
			{
				id: 'hist-1',
				sender: 'swift-fox-42',
				timestamp: 1725555000000,
				segments: [{ type: 'text', text: 'First historical message' }],
				isSelf: true
			},
			{
				id: 'hist-2',
				sender: 'brave-badger-19',
				timestamp: 1725555050000,
				segments: [
					{ type: 'text', text: 'Here is the helper function:' },
					{ type: 'code', code: 'fn run() -> bool { true }', language: 'rust' }
				],
				isSelf: false
			}
		];

		const serialized = serializeChatHistorySync(originalHistory);
		assert.ok(serialized instanceof Uint8Array);
		assert.ok(serialized.byteLength > 0);

		const deserialized = deserializeChatHistorySync(serialized);
		assert.ok(deserialized);
		assert.equal(deserialized.type, CHAT_HISTORY_SYNC_TYPE);
		assert.equal(deserialized.messages.length, 2);

		assert.equal(deserialized.messages[0].id, 'hist-1');
		assert.equal(deserialized.messages[0].sender, 'swift-fox-42');
		assert.equal(deserialized.messages[0].timestamp, 1725555000000);
		assert.deepEqual(deserialized.messages[0].segments, [{ type: 'text', text: 'First historical message' }]);

		assert.equal(deserialized.messages[1].id, 'hist-2');
		assert.equal(deserialized.messages[1].sender, 'brave-badger-19');
		assert.equal(deserialized.messages[1].timestamp, 1725555050000);
		assert.equal(deserialized.messages[1].segments.length, 2);
		assert.deepEqual(deserialized.messages[1].segments[0], { type: 'text', text: 'Here is the helper function:' });
		assert.deepEqual(deserialized.messages[1].segments[1], { type: 'code', code: 'fn run() -> bool { true }', language: 'rust' });
	});

	test('serializes empty chat history array to valid wire frame', () => {
		const serialized = serializeChatHistorySync([]);
		assert.ok(serialized instanceof Uint8Array);

		const deserialized = deserializeChatHistorySync(serialized);
		assert.ok(deserialized);
		assert.equal(deserialized.type, CHAT_HISTORY_SYNC_TYPE);
		assert.deepEqual(deserialized.messages, []);
	});

	test('rejects corrupt, incomplete, or malformed history sync payloads', () => {
		const invalidPayloads: (Uint8Array | string)[] = [
			new Uint8Array([]),
			new Uint8Array([1, 2, 3]),
			new TextEncoder().encode('not-json'),
			new TextEncoder().encode('{"type":"wrong_type","messages":[]}'),
			new TextEncoder().encode('{"type":"CHAT_HISTORY_SYNC"}'),
			new TextEncoder().encode('{"type":"CHAT_HISTORY_SYNC","messages":"not-array"}'),
			new TextEncoder().encode('{"type":"CHAT_HISTORY_SYNC","messages":null}')
		];

		for (const payload of invalidPayloads) {
			const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
			const res = deserializeChatHistorySync(bytes);
			assert.equal(res, null);
		}
	});

	test('deserializes lowercase type chat_history_sync safely', () => {
		const wire = {
			type: 'chat_history_sync',
			messages: [
				{
					id: 'm1',
					sender: 'alice',
					timestamp: 1000,
					segments: [{ type: 'text', text: 'hello' }]
				}
			]
		};
		const bytes = new TextEncoder().encode(JSON.stringify(wire));
		const res = deserializeChatHistorySync(bytes);
		assert.ok(res);
		assert.equal(res.messages.length, 1);
		assert.equal(res.messages[0].id, 'm1');
	});

	test('safely skips malformed items inside messages array while keeping valid ones', () => {
		const wire = {
			type: 'CHAT_HISTORY_SYNC',
			messages: [
				{ id: '', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'skip: empty id' }] },
				{ id: 'valid-1', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'keep: valid' }] },
				{ id: 'bad-2', sender: 'bob', timestamp: 3000, segments: [] },
				{ id: 'bad-3', sender: 'bob', timestamp: 4000, segments: [{ type: 'unknown' }] }
			]
		};
		const bytes = new TextEncoder().encode(JSON.stringify(wire));
		const res = deserializeChatHistorySync(bytes);
		assert.ok(res);
		assert.equal(res.messages.length, 1);
		assert.equal(res.messages[0].id, 'valid-1');
	});
});

describe('Chat Store mergeHistory Deduplication & Chronological Ordering', () => {
	let store: ReturnType<typeof createChatStore>;

	beforeEach(() => {
		store = createChatStore();
	});

	test('merges historical messages into empty store in chronological order', () => {
		const history: ChatMessage[] = [
			{ id: 'm2', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'Second' }], isSelf: false, isHistory: true },
			{ id: 'm1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'First' }], isSelf: false, isHistory: true },
			{ id: 'm3', sender: 'alice', timestamp: 3000, segments: [{ type: 'text', text: 'Third' }], isSelf: false, isHistory: true }
		];

		store.mergeHistory(history);

		let state!: ChatState;
		store.subscribe((s) => (state = s))();

		assert.equal(state.messages.length, 3);
		assert.equal(state.messages[0].id, 'm1');
		assert.equal(state.messages[1].id, 'm2');
		assert.equal(state.messages[2].id, 'm3');
	});

	test('deduplicates identical message IDs across multiple sync payloads', () => {
		const payload1: ChatMessage[] = [
			{ id: 'm1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'Hi' }], isSelf: false, isHistory: true },
			{ id: 'm2', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'Hey' }], isSelf: false, isHistory: true }
		];

		const payload2: ChatMessage[] = [
			{ id: 'm2', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'Hey' }], isSelf: false, isHistory: true },
			{ id: 'm3', sender: 'carol', timestamp: 3000, segments: [{ type: 'text', text: 'Welcome' }], isSelf: false, isHistory: true }
		];

		store.mergeHistory(payload1);
		store.mergeHistory(payload2);

		let state!: ChatState;
		store.subscribe((s) => (state = s))();

		assert.equal(state.messages.length, 3);
		assert.equal(state.messages[0].id, 'm1');
		assert.equal(state.messages[1].id, 'm2');
		assert.equal(state.messages[2].id, 'm3');
	});

	test('interleaves historical messages with existing local live messages chronologically', () => {
		store.addMessage({
			id: 'live-1',
			sender: 'self',
			timestamp: 2500,
			segments: [{ type: 'text', text: 'Live message sent earlier' }],
			isSelf: true
		});

		const history: ChatMessage[] = [
			{ id: 'h1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'Past message 1' }], isSelf: false, isHistory: true },
			{ id: 'h2', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'Past message 2' }], isSelf: false, isHistory: true },
			{ id: 'h3', sender: 'alice', timestamp: 3000, segments: [{ type: 'text', text: 'Past message 3' }], isSelf: false, isHistory: true }
		];

		store.mergeHistory(history);

		let state!: ChatState;
		store.subscribe((s) => (state = s))();

		assert.equal(state.messages.length, 4);
		assert.equal(state.messages[0].id, 'h1');
		assert.equal(state.messages[1].id, 'h2');
		assert.equal(state.messages[2].id, 'live-1');
		assert.equal(state.messages[3].id, 'h3');
	});

	test('handles duplicate message IDs within the incoming batch itself', () => {
		const batchWithInternalDuplicates: ChatMessage[] = [
			{ id: 'dup-1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'First instance' }], isSelf: false, isHistory: true },
			{ id: 'dup-1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'Second instance' }], isSelf: false, isHistory: true },
			{ id: 'm-2', sender: 'bob', timestamp: 2000, segments: [{ type: 'text', text: 'Second message' }], isSelf: false, isHistory: true }
		];

		store.mergeHistory(batchWithInternalDuplicates);

		let state!: ChatState;
		store.subscribe((s) => (state = s))();

		assert.equal(state.messages.length, 2);
		assert.equal(state.messages[0].id, 'dup-1');
		assert.equal(state.messages[1].id, 'm-2');
	});

	test('deterministic tie-breaker sorts by ID when timestamps are identical', () => {
		const sameTimestamp: ChatMessage[] = [
			{ id: 'b-id', sender: 'bob', timestamp: 5000, segments: [{ type: 'text', text: 'B' }], isSelf: false, isHistory: true },
			{ id: 'a-id', sender: 'alice', timestamp: 5000, segments: [{ type: 'text', text: 'A' }], isSelf: false, isHistory: true }
		];

		store.mergeHistory(sameTimestamp);

		let state!: ChatState;
		store.subscribe((s) => (state = s))();

		assert.equal(state.messages.length, 2);
		assert.equal(state.messages[0].id, 'a-id');
		assert.equal(state.messages[1].id, 'b-id');
	});
});

describe('WebRTC P2P Chat History Synchronization (2 Peers: A -> B)', () => {
	test('Peer A sends messages, Peer B connects later and receives full encrypted history', async () => {
		const roomKey = await deriveInitialKey('1234-5678-9012', 'history-test-salt');

		let pcAlice: MockRTCPeerConnection | null = null;
		let pcBob: MockRTCPeerConnection | null = null;

		const storeAlice = createChatStore();
		const storeBob = createChatStore();

		// Peer A sends two messages while alone in the room
		storeAlice.addMessage({
			id: 'msg-alice-1',
			sender: 'swift-fox-42',
			timestamp: 1000,
			segments: [{ type: 'text', text: 'Hello, room created!' }],
			isSelf: true
		});
		storeAlice.addMessage({
			id: 'msg-alice-2',
			sender: 'swift-fox-42',
			timestamp: 2000,
			segments: [{ type: 'code', code: 'const x = 42;', language: 'javascript' }],
			isSelf: true
		});

		const managerAlice = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcAlice = new MockRTCPeerConnection(cfg);
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcBob = new MockRTCPeerConnection(cfg);
				return pcBob as unknown as RTCPeerConnection;
			}
		});

		const syncAlice = new ChatHistorySyncManager(managerAlice, {
			autoListen: true,
			chatStore: storeAlice
		});
		const syncBob = new ChatHistorySyncManager(managerBob, {
			autoListen: true,
			chatStore: storeBob
		});

		// Sessions created
		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);

		// Link data channels
		const aliceDc = pcAlice!.localDataChannels[0];
		const bobDc = new MockRTCDataChannel('fastchat-data');
		aliceDc.peerChannel = bobDc;
		bobDc.peerChannel = aliceDc;
		pcBob!.ondatachannel?.({ channel: bobDc });

		// Open data channels -> triggers onDataChannelOpen on both peers
		aliceDc.open();
		bobDc.open();

		// Wait for microtask delivery and cryptographic decryption
		await new Promise((r) => setTimeout(r, 50));

		// Verify Peer B received the complete earlier history from Peer A
		let stateBob!: ChatState;
		storeBob.subscribe((s) => (stateBob = s))();

		assert.equal(stateBob.messages.length, 2, 'Peer B must receive exactly 2 historical messages');
		assert.equal(stateBob.messages[0].id, 'msg-alice-1');
		assert.equal(stateBob.messages[0].sender, 'swift-fox-42');
		assert.equal(stateBob.messages[0].isSelf, false);
		assert.equal(stateBob.messages[0].isHistory, true);
		assert.deepEqual(stateBob.messages[0].segments, [{ type: 'text', text: 'Hello, room created!' }]);

		assert.equal(stateBob.messages[1].id, 'msg-alice-2');
		assert.equal(stateBob.messages[1].isSelf, false);
		assert.equal(stateBob.messages[1].isHistory, true);
		assert.deepEqual(stateBob.messages[1].segments, [{ type: 'code', code: 'const x = 42;', language: 'javascript' }]);

		// Verify that payload transmitted over DataChannel was AES-256-GCM encrypted
		assert.ok(aliceDc.sentPackets.length >= 1);
		const rawEncryptedBytes = new Uint8Array(aliceDc.sentPackets[0] as ArrayBuffer);
		const rawString = new TextDecoder().decode(rawEncryptedBytes);
		assert.equal(rawString.includes('Hello, room created!'), false, 'Ciphertext must not expose plaintext');
		assert.equal(rawString.includes('msg-alice-1'), false, 'Ciphertext must not expose message IDs');

		// Verify that history is sent ONCE: subsequent open events do NOT retransmit
		const packetCountBefore = aliceDc.sentPackets.length;
		await syncAlice.syncHistoryToPeer('bob'); // Idempotency check
		assert.equal(aliceDc.sentPackets.length, packetCountBefore, 'Must not resend history to already-synced peer');

		syncAlice.destroy();
		syncBob.destroy();
		managerAlice.destroy();
		managerBob.destroy();
	});
});

describe('WebRTC Mesh P2P Chat History Synchronization (3-Peer Mesh: A, B, C)', () => {
	test('Peer C joins mesh after A and B have chatted, receiving full unified history without duplicates in chronological order', async () => {
		const roomKey = await deriveInitialKey('1234-5678-9012', 'mesh-3peer-salt');

		const storeAlice = createChatStore();
		const storeBob = createChatStore();
		const storeCarol = createChatStore();

		let pcAliceToBob: MockRTCPeerConnection | null = null;
		let pcBobToAlice: MockRTCPeerConnection | null = null;

		let pcAliceToCarol: MockRTCPeerConnection | null = null;
		let pcCarolToAlice: MockRTCPeerConnection | null = null;

		let pcBobToCarol: MockRTCPeerConnection | null = null;
		let pcCarolToBob: MockRTCPeerConnection | null = null;

		const managerAlice = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				const pc = new MockRTCPeerConnection(cfg);
				if (!pcAliceToBob) pcAliceToBob = pc;
				else pcAliceToCarol = pc;
				return pc as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				const pc = new MockRTCPeerConnection(cfg);
				if (!pcBobToAlice) pcBobToAlice = pc;
				else pcBobToCarol = pc;
				return pc as unknown as RTCPeerConnection;
			}
		});

		const managerCarol = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				const pc = new MockRTCPeerConnection(cfg);
				if (!pcCarolToAlice) pcCarolToAlice = pc;
				else pcCarolToBob = pc;
				return pc as unknown as RTCPeerConnection;
			}
		});

		const syncAlice = new ChatHistorySyncManager(managerAlice, { autoListen: true, chatStore: storeAlice });
		const syncBob = new ChatHistorySyncManager(managerBob, { autoListen: true, chatStore: storeBob });
		const syncCarol = new ChatHistorySyncManager(managerCarol, { autoListen: true, chatStore: storeCarol });

		// Phase 1: Alice creates message 1
		storeAlice.addMessage({
			id: 'msg-1-alice',
			sender: 'alice-01',
			timestamp: 1000,
			segments: [{ type: 'text', text: 'Message 1 from Alice' }],
			isSelf: true
		});

		// Phase 2: Bob connects to Alice
		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);

		const dcAliceToBob = pcAliceToBob!.localDataChannels[0];
		const dcBobToAlice = new MockRTCDataChannel('fastchat-data');
		dcAliceToBob.peerChannel = dcBobToAlice;
		dcBobToAlice.peerChannel = dcAliceToBob;
		pcBobToAlice!.ondatachannel?.({ channel: dcBobToAlice });

		dcAliceToBob.open();
		dcBobToAlice.open();

		await new Promise((r) => setTimeout(r, 40));

		// Bob now has message 1 from Alice
		let stateBob!: ChatState;
		storeBob.subscribe((s) => (stateBob = s))();
		assert.equal(stateBob.messages.length, 1);
		assert.equal(stateBob.messages[0].id, 'msg-1-alice');

		// Phase 3: Bob sends message 2 live to Alice
		const msg2: { id: string; sender: string; timestamp: number; segments: MessageSegment[] } = {
			id: 'msg-2-bob',
			sender: 'bob-02',
			timestamp: 2000,
			segments: [{ type: 'text', text: 'Message 2 from Bob' }]
		};
		storeBob.addMessage({ ...msg2, isSelf: true });


		// Bob broadcasts live message 2 to Alice
		managerBob.onMessage((_, payload) => {
			const chat = deserializeChatMessage(payload);
			if (chat) storeBob.addMessage({ ...chat, isSelf: false });
		});
		managerAlice.onMessage((_, payload) => {
			const chat = deserializeChatMessage(payload);
			if (chat) storeAlice.addMessage({ ...chat, isSelf: false });
		});

		await managerBob.broadcast(serializeChatMessage({ type: 'chat', ...msg2 }));
		await new Promise((r) => setTimeout(r, 40));

		// Verify both Alice and Bob have [msg-1-alice, msg-2-bob]
		let stateAlice!: ChatState;
		storeAlice.subscribe((s) => (stateAlice = s))();
		assert.equal(stateAlice.messages.length, 2);
		assert.equal(stateAlice.messages[0].id, 'msg-1-alice');
		assert.equal(stateAlice.messages[1].id, 'msg-2-bob');

		storeBob.subscribe((s) => (stateBob = s))();
		assert.equal(stateBob.messages.length, 2);
		assert.equal(stateBob.messages[0].id, 'msg-1-alice');
		assert.equal(stateBob.messages[1].id, 'msg-2-bob');

		// Phase 4: Peer Carol joins the room later!
		// Carol establishes mesh connections to BOTH Alice and Bob
		await managerAlice.getOrCreateSession('carol', true);
		await managerCarol.getOrCreateSession('alice', false);

		const dcAliceToCarol = pcAliceToCarol!.localDataChannels[0];
		const dcCarolToAlice = new MockRTCDataChannel('fastchat-data');
		dcAliceToCarol.peerChannel = dcCarolToAlice;
		dcCarolToAlice.peerChannel = dcAliceToCarol;
		pcCarolToAlice!.ondatachannel?.({ channel: dcCarolToAlice });

		await managerBob.getOrCreateSession('carol', true);
		await managerCarol.getOrCreateSession('bob', false);

		const dcBobToCarol = pcBobToCarol!.localDataChannels[0];
		const dcCarolToBob = new MockRTCDataChannel('fastchat-data');
		dcBobToCarol.peerChannel = dcCarolToBob;
		dcCarolToBob.peerChannel = dcBobToCarol;
		pcCarolToBob!.ondatachannel?.({ channel: dcCarolToBob });

		// Both Alice and Bob open DataChannels with Carol concurrently
		dcAliceToCarol.open();
		dcCarolToAlice.open();
		dcBobToCarol.open();
		dcCarolToBob.open();

		// Wait for both history payloads to arrive, decrypt, and merge on Carol
		await new Promise((r) => setTimeout(r, 80));

		// Verify Carol's unified chat store
		let stateCarol!: ChatState;
		storeCarol.subscribe((s) => (stateCarol = s))();

		assert.equal(
			stateCarol.messages.length,
			2,
			`Carol must contain exactly 2 messages without duplicates, received: ${stateCarol.messages.length}`
		);
		assert.equal(stateCarol.messages[0].id, 'msg-1-alice');
		assert.equal(stateCarol.messages[0].timestamp, 1000);
		assert.equal(stateCarol.messages[0].isHistory, true);

		assert.equal(stateCarol.messages[1].id, 'msg-2-bob');
		assert.equal(stateCarol.messages[1].timestamp, 2000);
		assert.equal(stateCarol.messages[1].isHistory, true);

		syncAlice.destroy();
		syncBob.destroy();
		syncCarol.destroy();
		managerAlice.destroy();
		managerBob.destroy();
		managerCarol.destroy();
	});
});

describe('Concurrent Live Messages & History Sync Interleaving', () => {
	test('live messages arriving during or immediately after history sync are never dropped or duplicated', async () => {
		const roomKey = await deriveInitialKey('1234-5678-9012', 'concurrent-test-salt');
		const storeAlice = createChatStore();
		const storeBob = createChatStore();

		// Alice has historical message
		storeAlice.addMessage({
			id: 'm1',
			sender: 'alice',
			timestamp: 1000,
			segments: [{ type: 'text', text: 'Historical msg 1' }],
			isSelf: true
		});

		let pcAlice: MockRTCPeerConnection | null = null;
		let pcBob: MockRTCPeerConnection | null = null;

		const managerAlice = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcAlice = new MockRTCPeerConnection(cfg);
				return pcAlice as unknown as RTCPeerConnection;
			}
		});

		const managerBob = new WebRtcManager({
			activeKey: roomKey,
			iceServers: [],
			rtcPeerConnectionFactory: (cfg) => {
				pcBob = new MockRTCPeerConnection(cfg);
				return pcBob as unknown as RTCPeerConnection;
			}
		});

		// Set up history sync and live message listener on Bob
		const syncAlice = new ChatHistorySyncManager(managerAlice, { autoListen: true, chatStore: storeAlice });
		const syncBob = new ChatHistorySyncManager(managerBob, { autoListen: true, chatStore: storeBob });

		managerBob.onMessage((peerId, payload) => {
			const chat = deserializeChatMessage(payload);
			if (chat) {
				storeBob.addMessage({
					id: chat.id,
					sender: chat.sender,
					segments: chat.segments,
					timestamp: chat.timestamp,
					isSelf: false,
					senderPeerId: peerId
				});
			}
		});

		await managerAlice.getOrCreateSession('bob', true);
		await managerBob.getOrCreateSession('alice', false);

		const aliceDc = pcAlice!.localDataChannels[0];
		const bobDc = new MockRTCDataChannel('fastchat-data');
		aliceDc.peerChannel = bobDc;
		bobDc.peerChannel = aliceDc;
		pcBob!.ondatachannel?.({ channel: bobDc });

		// Open channel
		aliceDc.open();
		bobDc.open();

		// Concurrently send live message m2 while history sync is in transit
		const livePayload = serializeChatMessage({
			type: 'chat',
			id: 'm2',
			sender: 'alice',
			timestamp: 1500,
			segments: [{ type: 'text', text: 'Concurrent live message' }]
		});
		await managerAlice.send('bob', livePayload);

		// Wait for delivery
		await new Promise((r) => setTimeout(r, 60));

		let stateBob!: ChatState;
		storeBob.subscribe((s) => (stateBob = s))();

		assert.equal(stateBob.messages.length, 2, 'Must contain both m1 and m2');
		assert.equal(stateBob.messages[0].id, 'm1');
		assert.equal(stateBob.messages[0].timestamp, 1000);
		assert.equal(stateBob.messages[1].id, 'm2');
		assert.equal(stateBob.messages[1].timestamp, 1500);

		// Simulate duplicate arrival of m2 via a delayed history sync packet
		syncBob.handleSyncPayload(
			'alice',
			serializeChatHistorySync([
				{ id: 'm1', sender: 'alice', timestamp: 1000, segments: [{ type: 'text', text: 'm1' }] },
				{ id: 'm2', sender: 'alice', timestamp: 1500, segments: [{ type: 'text', text: 'm2' }] }
			])
		);

		storeBob.subscribe((s) => (stateBob = s))();
		assert.equal(stateBob.messages.length, 2, 'Duplicate m1 and m2 in history sync must be skipped');

		syncAlice.destroy();
		syncBob.destroy();
		managerAlice.destroy();
		managerBob.destroy();
	});
});


