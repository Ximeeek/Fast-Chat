import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateUsername } from '../src/lib/chat/username.ts';
import { serializeChatMessage, deserializeChatMessage } from '../src/lib/chat/transport.ts';
import { formatChatLog, downloadChatLog } from '../src/lib/chat/export.ts';
import {
	countLines,
	isLongPastedText,
	formatPastedLabel,
	composeFinalMessage,
	type PastedBlock
} from '../src/lib/chat/pastedSnippet.ts';
import { isCodeSnippet } from '../src/lib/chat/codeDetection.ts';
import {
	detectLanguage,
	getLanguageDisplayName,
	SUPPORTED_LANGUAGES,
	type SupportedLanguage
} from '../src/lib/chat/languageDetection.ts';
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

	test('serializes and deserializes code messages with detected or manual language', () => {
		const codeMessage = {
			type: 'chat' as const,
			id: 'msg-code-payload-1',
			sender: 'swift-fox-42',
			content: 'fn main() {\n    println!("hello");\n}',
			timestamp: 1725555555000,
			contentType: 'code' as const,
			language: 'rust'
		};

		const bytes = serializeChatMessage(codeMessage);
		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, codeMessage);
	});

	test('serializes and deserializes code messages with null language', () => {
		const codeMessage = {
			type: 'chat' as const,
			id: 'msg-code-payload-2',
			sender: 'swift-fox-42',
			content: 'echo "plain code snippet"',
			timestamp: 1725555555000,
			contentType: 'code' as const,
			language: null
		};

		const bytes = serializeChatMessage(codeMessage);
		const deserialized = deserializeChatMessage(bytes);
		assert.deepEqual(deserialized, codeMessage);
	});

	test('deserializes legacy Phase 9 packets without contentType or language fields', () => {
		const legacyJson = JSON.stringify({
			type: 'chat',
			id: 'legacy-msg-100',
			sender: 'calm-badger-19',
			content: 'Legacy message from Phase 9 client',
			timestamp: 1725555555000
		});
		const bytes = new TextEncoder().encode(legacyJson);
		const deserialized = deserializeChatMessage(bytes);

		assert.ok(deserialized);
		assert.equal(deserialized.id, 'legacy-msg-100');
		assert.equal(deserialized.sender, 'calm-badger-19');
		assert.equal(deserialized.content, 'Legacy message from Phase 9 client');
		assert.equal(deserialized.contentType, undefined);
		assert.equal(deserialized.language, undefined);
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
		assert.equal(state.messages[0].content, 'Room created.');
		assert.equal(state.messages[0].isSystem, true);
		assert.equal(state.messages[0].isSelf, false);
		assert.match(state.messages[0].id, /^sys-\d+-[a-z0-9]+$/);

		assert.equal(state.messages[1].sender, 'System');
		assert.equal(state.messages[1].content, 'Peer peer-123 joined the room.');
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
		const messages = [
			{
				id: 'm1',
				sender: 'swift-fox-42',
				content: 'Hello everyone!',
				timestamp: new Date('2026-09-05T18:00:15.000Z').getTime(),
				isSelf: true
			},
			{
				id: 'm2',
				sender: 'calm-badger-19',
				content: 'Hey swift-fox, encrypted P2P mesh established.',
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
			{ id: 'b1', content: 'const x = 1;\nconsole.log(x);', lineCount: 2, isExpanded: false },
			{ id: 'b2', content: 'Some extra log line', lineCount: 1, isExpanded: false }
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

