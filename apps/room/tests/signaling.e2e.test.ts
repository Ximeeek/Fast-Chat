import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { validateRoomCode } from '../src/lib/utils/roomCode.ts';

const SERVER_PORT = 3456;
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/health`;
const ICE_URL = `http://127.0.0.1:${SERVER_PORT}/api/ice-servers`;

describe('Signaling Protocol End-to-End Integration', () => {
	let serverProcess: ChildProcess;

	before(async () => {
		const exePath = join(
			process.cwd(),
			'..',
			'..',
			'services',
			'signaling',
			'target',
			'debug',
			'fastchat-signaling.exe'
		);

		serverProcess = spawn(exePath, [], {
			env: {
				...process.env,
				PORT: String(SERVER_PORT),
				HOST: '127.0.0.1',
				RUST_LOG: 'info'
			},
			stdio: 'pipe'
		});

		serverProcess.stderr?.on('data', (d) => {
			// Uncomment if debugging: console.error(`[SERVER] ${d}`);
		});

		// Wait for server health endpoint to become ready
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

	test('health endpoint reports service status', async () => {
		const res = await fetch(HEALTH_URL);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.status, 'ok');
		assert.equal(data.service, 'fastchat-signaling');
	});

	test('GET /api/ice-servers returns STUN configuration', async () => {
		const res = await fetch(ICE_URL);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.ok(Array.isArray(data.ice_servers || data.iceServers));
		const servers = data.iceServers || data.ice_servers;
		assert.ok(servers.length > 0);
		assert.ok(servers[0].urls.some((u: string) => u.includes('stun.cloudflare.com')));
	});

	test('full WebSocket protocol flow: CREATE_ROOM, JOIN_ROOM, SDP, ICE, ICE_SERVERS, PING', async () => {
		// Client 1 (Room Creator)
		const ws1 = new WebSocket(WS_URL);
		await new Promise<void>((resolve, reject) => {
			ws1.onopen = () => resolve();
			ws1.onerror = (e) => reject(e);
		});

		// Helper to wait for specific message type
		function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`Timeout waiting for message type ${type}`));
				}, timeoutMs);

				const handler = (event: MessageEvent) => {
					try {
						const msg = JSON.parse(event.data);
						if (msg.type === type) {
							clearTimeout(timer);
							ws.removeEventListener('message', handler);
							resolve(msg);
						}
					} catch {}
				};

				ws.addEventListener('message', handler);
			});
		}

		// 1. CREATE_ROOM
		const roomCreatedPromise = waitForMessage(ws1, 'ROOM_CREATED');
		ws1.send(JSON.stringify({ type: 'CREATE_ROOM' }));
		const roomCreated = await roomCreatedPromise;

		assert.equal(roomCreated.type, 'ROOM_CREATED');
		assert.ok(roomCreated.code);
		assert.equal(validateRoomCode(roomCreated.code), true, 'Room code must conform to 0000-0000-0000 format');
		assert.ok(roomCreated.salt);
		assert.ok(roomCreated.expires_at || roomCreated.expiresAt);
		const client1PeerId = roomCreated.peer_id || roomCreated.peerId;
		assert.ok(client1PeerId);

		// 2. Client 2 (Joining Peer)
		const ws2 = new WebSocket(WS_URL);
		await new Promise<void>((resolve, reject) => {
			ws2.onopen = () => resolve();
			ws2.onerror = (e) => reject(e);
		});

		// Setup listeners for JOIN_OK (on ws2) and PEER_JOINED (on ws1)
		const joinOkPromise = waitForMessage(ws2, 'JOIN_OK');
		const peerJoinedPromise = waitForMessage(ws1, 'PEER_JOINED');

		ws2.send(
			JSON.stringify({
				type: 'JOIN_ROOM',
				code: roomCreated.code
			})
		);

		const [joinOk, peerJoined] = await Promise.all([joinOkPromise, peerJoinedPromise]);

		assert.equal(joinOk.type, 'JOIN_OK');
		assert.equal(joinOk.status, 'OK');
		assert.equal(joinOk.code, roomCreated.code);
		const client2PeerId = joinOk.peer_id || joinOk.peerId;
		assert.ok(client2PeerId);
		assert.deepEqual(joinOk.peers, [client1PeerId]);

		assert.equal(peerJoined.type, 'PEER_JOINED');
		assert.equal(peerJoined.peer_id || peerJoined.peerId, client2PeerId);

		// 3. Transparent SDP Offer relay: Client 1 -> Client 2
		const sdpOfferPromise = waitForMessage(ws2, 'SDP_OFFER');
		ws1.send(
			JSON.stringify({
				type: 'SDP_OFFER',
				target_peer_id: client2PeerId,
				sdp: { type: 'offer', sdp: 'v=0 dummy sdp' }
			})
		);
		const sdpOffer = await sdpOfferPromise;
		assert.equal(sdpOffer.type, 'SDP_OFFER');
		assert.equal(sdpOffer.sender_peer_id || sdpOffer.senderPeerId, client1PeerId);
		assert.equal(sdpOffer.sdp.sdp, 'v=0 dummy sdp');

		// 4. Transparent SDP Answer relay: Client 2 -> Client 1
		const sdpAnswerPromise = waitForMessage(ws1, 'SDP_ANSWER');
		ws2.send(
			JSON.stringify({
				type: 'SDP_ANSWER',
				target_peer_id: client1PeerId,
				sdp: { type: 'answer', sdp: 'v=0 dummy answer' }
			})
		);
		const sdpAnswer = await sdpAnswerPromise;
		assert.equal(sdpAnswer.type, 'SDP_ANSWER');
		assert.equal(sdpAnswer.sender_peer_id || sdpAnswer.senderPeerId, client2PeerId);
		assert.equal(sdpAnswer.sdp.sdp, 'v=0 dummy answer');

		// 5. Transparent ICE Candidates relay: Client 1 -> Client 2
		const iceCandidatePromise = waitForMessage(ws2, 'ICE_CANDIDATES');
		ws1.send(
			JSON.stringify({
				type: 'ICE_CANDIDATES',
				target_peer_id: client2PeerId,
				candidate: { candidate: 'candidate:1 1 UDP 12345 1.2.3.4 5678 typ host' }
			})
		);
		const iceCandidate = await iceCandidatePromise;
		assert.equal(iceCandidate.type, 'ICE_CANDIDATES');
		assert.equal(iceCandidate.sender_peer_id || iceCandidate.senderPeerId, client1PeerId);

		// 6. REQUEST_ICE_SERVERS over WebSocket
		const iceServersPromise = waitForMessage(ws1, 'ICE_SERVERS');
		ws1.send(JSON.stringify({ type: 'REQUEST_ICE_SERVERS' }));
		const iceServers = await iceServersPromise;
		assert.equal(iceServers.type, 'ICE_SERVERS');
		assert.ok(Array.isArray(iceServers.ice_servers || iceServers.iceServers));

		// 7. Heartbeat PING -> PONG
		const pongPromise = waitForMessage(ws1, 'PONG');
		ws1.send(JSON.stringify({ type: 'PING' }));
		const pong = await pongPromise;
		assert.equal(pong.type, 'PONG');

		// 8. PEER_LEFT on disconnect
		const peerLeftPromise = waitForMessage(ws1, 'PEER_LEFT');
		ws2.close();
		const peerLeft = await peerLeftPromise;
		assert.equal(peerLeft.type, 'PEER_LEFT');
		assert.equal(peerLeft.peer_id || peerLeft.peerId, client2PeerId);

		ws1.close();
	});
});
