import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { SignalingClient } from '../src/lib/signaling/client.ts';
import { roomStore, isRoomActive } from '../src/lib/stores/room.ts';
import type { ClientSignalingMessage, ServerSignalingMessage } from '../src/lib/types/signaling.ts';

const SERVER_PORT = 3457;
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;

describe('SignalingClient Outgoing Message Contract Tests', () => {
	let client: SignalingClient;
	let sentMessages: Array<{ raw: string; parsed: Record<string, any> }> = [];

	before(() => {
		client = new SignalingClient();
		// Mock internal ws connection
		const mockWs = {
			readyState: 1, // WebSocket.OPEN
			send: (data: string) => {
				sentMessages.push({
					raw: data,
					parsed: JSON.parse(data)
				});
			},
			close: () => {}
		};
		(client as any).ws = mockWs;
	});

	function getLastSent(): Record<string, any> {
		assert.ok(sentMessages.length > 0, 'Expected at least one message sent');
		return sentMessages[sentMessages.length - 1].parsed;
	}

	function assertNoDuplicateAliases(payload: Record<string, any>) {
		const keys = Object.keys(payload);
		const aliasPairs: [string, string][] = [
			['peer_id', 'peerId'],
			['new_owner_peer_id', 'newOwnerPeerId'],
			['new_owner_peer_id', 'peerId'],
			['new_owner_peer_id', 'peer_id'],
			['target_peer_id', 'targetPeerId'],
			['target_peer_id', 'target'],
			['target_peer_id', 'to'],
			['duration_seconds', 'durationSeconds'],
			['has_password', 'hasPassword'],
			['room_code', 'roomCode']
		];

		for (const [snake, camel] of aliasPairs) {
			const hasSnake = keys.includes(snake) && payload[snake] !== undefined;
			const hasCamel = keys.includes(camel) && payload[camel] !== undefined;
			assert.ok(
				!(hasSnake && hasCamel),
				`Payload for ${payload.type} contains conflicting duplicate fields '${snake}' and '${camel}'`
			);
		}
	}

	test('transferOwnership serializes exclusively single new_owner_peer_id field without camelCase duplicate', () => {
		client.transferOwnership('peer-1234');
		const msg = getLastSent();

		assert.equal(msg.type, 'TRANSFER_OWNERSHIP');
		assert.equal(msg.new_owner_peer_id, 'peer-1234');
		assert.equal(msg.newOwnerPeerId, undefined);
		assert.equal(msg.peerId, undefined);
		assert.equal(msg.peer_id, undefined);
		assertNoDuplicateAliases(msg);
	});

	test('setChatVisibilityBlocked serializes exclusively single peer_id field without camelCase duplicate', () => {
		client.setChatVisibilityBlocked('peer-1234', true);
		const msg = getLastSent();

		assert.equal(msg.type, 'SET_CHAT_VISIBILITY_BLOCKED');
		assert.equal(msg.peer_id, 'peer-1234');
		assert.equal(msg.peerId, undefined);
		assert.equal(msg.blocked, true);
		assertNoDuplicateAliases(msg);

		client.setChatVisibilityBlocked('peer-1234', false);
		const msgUnblock = getLastSent();
		assert.equal(msgUnblock.blocked, false);
		assert.equal(msgUnblock.peerId, undefined);
		assertNoDuplicateAliases(msgUnblock);
	});

	test('setFileVisibilityBlocked serializes exclusively single peer_id field without camelCase duplicate', () => {
		client.setFileVisibilityBlocked('peer-5678', true);
		const msg = getLastSent();

		assert.equal(msg.type, 'SET_FILE_VISIBILITY_BLOCKED');
		assert.equal(msg.peer_id, 'peer-5678');
		assert.equal(msg.peerId, undefined);
		assert.equal(msg.blocked, true);
		assertNoDuplicateAliases(msg);

		client.setFileVisibilityBlocked('peer-5678', false);
		const msgUnblock = getLastSent();
		assert.equal(msgUnblock.blocked, false);
		assert.equal(msgUnblock.peerId, undefined);
		assertNoDuplicateAliases(msgUnblock);
	});

	test('all public message dispatch methods adhere to strict single-field contracts', async () => {
		sentMessages = [];

		const testInvocations: Array<{ name: string; invoke: () => Promise<void> | void; expectedType: string }> = [
			{
				name: 'sendSdpOffer',
				invoke: () => client.sendSdpOffer('peer-tgt', { type: 'offer', sdp: 'v=0...' }),
				expectedType: 'SDP_OFFER'
			},
			{
				name: 'sendSdpAnswer',
				invoke: () => client.sendSdpAnswer('peer-tgt', { type: 'answer', sdp: 'v=0...' }),
				expectedType: 'SDP_ANSWER'
			},
			{
				name: 'sendIceCandidates (single candidate)',
				invoke: () => client.sendIceCandidates('peer-tgt', { candidate: 'candidate:...' }),
				expectedType: 'ICE_CANDIDATES'
			},
			{
				name: 'sendIceCandidates (candidate array)',
				invoke: () => client.sendIceCandidates('peer-tgt', [{ candidate: 'c1' }, { candidate: 'c2' }]),
				expectedType: 'ICE_CANDIDATES'
			},
			{
				name: 'rekey',
				invoke: () => client.rekey('secret-hash', 'salt-123'),
				expectedType: 'REKEY'
			},
			{
				name: 'setRoomPassword',
				invoke: () => client.setRoomPassword('new-pass'),
				expectedType: 'SET_ROOM_PASSWORD'
			},
			{
				name: 'kickPeer',
				invoke: () => client.kickPeer('peer-kick-target'),
				expectedType: 'KICK_PEER'
			},
			{
				name: 'mutePeer (permanent)',
				invoke: () => client.mutePeer('peer-mute-target', null),
				expectedType: 'MUTE_PEER'
			},
			{
				name: 'mutePeer (duration)',
				invoke: () => client.mutePeer('peer-mute-target', 300),
				expectedType: 'MUTE_PEER'
			},
			{
				name: 'unmutePeer',
				invoke: () => client.unmutePeer('peer-mute-target'),
				expectedType: 'UNMUTE_PEER'
			},
			{
				name: 'setRoomLocked',
				invoke: () => client.setRoomLocked(true),
				expectedType: 'SET_ROOM_LOCKED'
			},
			{
				name: 'verifyPassword',
				invoke: () => {
					void client.verifyPassword('test-pwd').catch(() => {});
				},
				expectedType: 'VERIFY_PASSWORD'
			},
			{
				name: 'sendTurnUsageReport',
				invoke: () => client.sendTurnUsageReport(1024),
				expectedType: 'TURN_USAGE_REPORT'
			},
			{
				name: 'requestIceServers',
				invoke: async () => {
					void client.requestIceServers().catch(() => {});
					await new Promise((r) => setTimeout(r, 0));
				},
				expectedType: 'REQUEST_ICE_SERVERS'
			},
			{
				name: 'ping',
				invoke: () => client.ping(),
				expectedType: 'PING'
			},
			{
				name: 'detonateRoom',
				invoke: () => client.detonateRoom(),
				expectedType: 'DETONATE_ROOM'
			}
		];

		for (const testCase of testInvocations) {
			const countBefore = sentMessages.length;
			await testCase.invoke();
			assert.equal(sentMessages.length, countBefore + 1, `Method ${testCase.name} did not send a message`);

			const sent = getLastSent();
			assert.equal(sent.type, testCase.expectedType, `Unexpected message type for ${testCase.name}`);
			assertNoDuplicateAliases(sent);
		}
	});
});

describe('Live Signaling Server E2E Deserialization: Visibility & Ownership Actions', () => {
	let serverProcess: ChildProcess;

	before(async () => {
		const exePath = existsSync(
			join(process.cwd(), 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe')
		)
			? join(process.cwd(), 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe')
			: join(process.cwd(), '..', '..', 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe');

		serverProcess = spawn(exePath, [], {
			env: {
				...process.env,
				PORT: String(SERVER_PORT),
				HOST: '127.0.0.1',
				RUST_LOG: 'info'
			},
			stdio: 'pipe'
		});

		let ready = false;
		for (let i = 0; i < 50; i++) {
			try {
				const res = await fetch(HEALTH_URL);
				if (res.ok) {
					ready = true;
					break;
				}
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}

		if (!ready) {
			throw new Error('Signaling server failed to start within timeout');
		}
	});

	after(() => {
		if (serverProcess) {
			serverProcess.kill();
		}
	});

	function waitForMessageType(ws: WebSocket, type: string, timeoutMs = 4000): Promise<ServerSignalingMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.removeEventListener('message', handler);
				reject(new Error(`Timed out waiting for message ${type}`));
			}, timeoutMs);

			const handler = (evt: MessageEvent) => {
				const parsed = JSON.parse(evt.data) as ServerSignalingMessage;
				if (parsed.type === type) {
					clearTimeout(timer);
					ws.removeEventListener('message', handler);
					resolve(parsed);
				} else if (parsed.type === 'ERROR') {
					clearTimeout(timer);
					ws.removeEventListener('message', handler);
					reject(new Error(`Received unexpected ERROR from server: [${parsed.code}] ${parsed.message}`));
				}
			};

			ws.addEventListener('message', handler);
		});
	}

	test('real server parses SET_CHAT_VISIBILITY_BLOCKED, SET_FILE_VISIBILITY_BLOCKED and TRANSFER_OWNERSHIP without format errors', async () => {
		const clientA = new SignalingClient({ wsUrl: WS_URL });
		const clientB = new SignalingClient({ wsUrl: WS_URL });

		await clientA.connect();
		const room = await clientA.createRoom({ peerId: 'alice' });
		assert.ok(room.code);

		await clientB.connect();
		const joinB = await clientB.joinRoom(room.code, { peerId: 'bob' });
		assert.equal(joinB.peer_id, 'bob');

		// Access the underlying WebSockets to listen for broadcast events
		const wsA = (clientA as any).ws as WebSocket;
		const wsB = (clientB as any).ws as WebSocket;

		// 1. Block Chat Visibility
		const chatBlockPromise = waitForMessageType(wsA, 'CHAT_VISIBILITY_BLOCKED');
		clientA.setChatVisibilityBlocked('bob', true);
		const chatBlockMsg = (await chatBlockPromise) as any;
		assert.equal(chatBlockMsg.peer_id || chatBlockMsg.peerId, 'bob');
		assert.equal(chatBlockMsg.blocked, true);

		// 2. Block File Visibility
		const fileBlockPromise = waitForMessageType(wsA, 'FILE_VISIBILITY_BLOCKED');
		clientA.setFileVisibilityBlocked('bob', true);
		const fileBlockMsg = (await fileBlockPromise) as any;
		assert.equal(fileBlockMsg.peer_id || fileBlockMsg.peerId, 'bob');
		assert.equal(fileBlockMsg.blocked, true);

		// 3. Unblock Chat Visibility
		const chatUnblockPromise = waitForMessageType(wsA, 'CHAT_VISIBILITY_BLOCKED');
		clientA.setChatVisibilityBlocked('bob', false);
		const chatUnblockMsg = (await chatUnblockPromise) as any;
		assert.equal(chatUnblockMsg.blocked, false);

		// 4. Unblock File Visibility
		const fileUnblockPromise = waitForMessageType(wsA, 'FILE_VISIBILITY_BLOCKED');
		clientA.setFileVisibilityBlocked('bob', false);
		const fileUnblockMsg = (await fileUnblockPromise) as any;
		assert.equal(fileUnblockMsg.blocked, false);

		// 5. Transfer Ownership to Bob
		const transferPromise = waitForMessageType(wsA, 'ROOM_OWNER_CHANGED');
		clientA.transferOwnership('bob');
		const transferMsg = (await transferPromise) as any;
		assert.equal(transferMsg.owner_peer_id || transferMsg.ownerPeerId, 'bob');

		clientA.disconnect();
		clientB.disconnect();
	});

	test('SignalingClient routes non-fatal ERROR to actionError leaving active room intact, and fatal ERROR to setError', () => {
		const client = new SignalingClient();
		roomStore.reset();

		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: '1234-5678-9012',
			peer_id: 'peer-alice',
			is_owner: true,
			salt: 'aabbcc112233',
			expires_at: 1800000000,
			peers: ['peer-alice']
		});

		let active = false;
		const unsub = isRoomActive.subscribe((a: boolean) => (active = a));
		assert.equal(active, true);

		// 1. Simulate inbound non-fatal error: INVALID_MESSAGE_FORMAT
		(client as any).handleIncomingRawMessage(
			JSON.stringify({
				type: 'ERROR',
				code: 'INVALID_MESSAGE_FORMAT',
				message: 'Invalid message payload'
			})
		);

		let state: any;
		const unsubStore = roomStore.subscribe((s: any) => (state = s));
		unsubStore();

		assert.equal(state.lifecycle, 'joined', 'Lifecycle must remain joined');
		assert.equal(active, true, 'isRoomActive must remain true');
		assert.equal(state.error, null, 'Fatal error must be null');
		assert.ok(state.actionError, 'Action error must be populated');
		assert.equal(state.actionError.code, 'INVALID_MESSAGE_FORMAT');

		// 2. Simulate inbound fatal error: ROOM_CLOSED
		(client as any).handleIncomingRawMessage(
			JSON.stringify({
				type: 'ERROR',
				code: 'ROOM_CLOSED',
				message: 'Room has expired and closed'
			})
		);

		const unsubStore2 = roomStore.subscribe((s: any) => (state = s));
		unsubStore2();

		assert.equal(state.lifecycle, 'error', 'Fatal error must transition lifecycle to error');
		assert.equal(active, false, 'isRoomActive must be false');
		assert.equal(state.error?.code, 'ROOM_CLOSED');

		unsub();
	});

	test('Inbound ROOM_DETONATED transitions roomStore to closed with closureReason ROOM_DETONATED and closes connection', () => {
		const client = new SignalingClient();
		let state: any;
		let active: boolean | undefined;

		const unsub = isRoomActive.subscribe((val) => (active = val));
		const unsubStore = roomStore.subscribe((s) => (state = s));

		roomStore.setCreated({
			type: 'ROOM_CREATED',
			code: '1234-5678-9012',
			peer_id: 'alice',
			peerId: 'alice',
			salt: 'salt123',
			crypto_salt: 'salt123',
			expires_at: Math.floor(Date.now() / 1000) + 600,
			expiresAt: Math.floor(Date.now() / 1000) + 600
		});

		assert.equal(active, true);

		(client as any).handleIncomingRawMessage(
			JSON.stringify({
				type: 'ROOM_DETONATED',
				room_code: '1234-5678-9012'
			})
		);

		assert.equal(state.lifecycle, 'closed');
		assert.equal(state.closureReason, 'ROOM_DETONATED');
		assert.equal(state.connectionState, 'closed');
		assert.equal(active, false);

		unsub();
		unsubStore();
	});
});
