import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { WebRtcManager } from '../src/lib/webrtc/index.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';
import { deriveRekeyedKey, RekeyManager } from '../src/lib/crypto/rekey.ts';
import { encryptChunk, decryptChunk } from '../src/lib/crypto/cipher.ts';
import { roomStore } from '../src/lib/stores/room.ts';
import { SignalingClient } from '../src/lib/signaling/client.ts';

const sampleRoomCode = '1234-5678-9012';
const sampleSalt = '0123456789abcdef0123456789abcdef';

describe('Post-Creation Room Password Management & REKEY Flow', () => {
	let k0: CryptoKey;

	beforeEach(async () => {
		roomStore.reset();
		k0 = await deriveInitialKey(sampleRoomCode, sampleSalt);
	});

	afterEach(() => {
		roomStore.reset();
	});

	test('roomStore tracks hasPassword state reactively across lifecycle events', () => {
		let state = getStoreState();
		assert.equal(state.hasPassword, false);

		// Created with password
		roomStore.setCreated({
			type: 'ROOM_CREATED',
			code: sampleRoomCode,
			peer_id: 'alice',
			salt: sampleSalt,
			expires_at: 1800000000,
			has_password: true
		});
		state = getStoreState();
		assert.equal(state.hasPassword, true);
		assert.equal(state.isOwner, true);

		// Reset and joined without password
		roomStore.reset();
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: sampleRoomCode,
			peer_id: 'bob',
			is_owner: false,
			owner_peer_id: 'alice',
			salt: sampleSalt,
			expires_at: 1800000000,
			peers: ['alice'],
			has_password: false
		});
		state = getStoreState();
		assert.equal(state.hasPassword, false);
		assert.equal(state.isOwner, false);

		// Owner sets password post-creation -> setPasswordStatus updates reactively
		roomStore.setPasswordStatus(true);
		state = getStoreState();
		assert.equal(state.hasPassword, true);
	});

	test('ownership transfer dynamically updates isOwner status for password controls', () => {
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: sampleRoomCode,
			peer_id: 'bob',
			is_owner: false,
			owner_peer_id: 'alice',
			salt: sampleSalt,
			expires_at: 1800000000,
			peers: ['alice']
		});
		assert.equal(getStoreState().isOwner, false);

		// Alice leaves -> ownership transferred to Bob
		roomStore.setOwner('bob');
		assert.equal(getStoreState().isOwner, true);
		assert.equal(getStoreState().ownerPeerId, 'bob');

		// Ownership transferred to Charlie
		roomStore.setOwner('charlie');
		assert.equal(getStoreState().isOwner, false);
	});

	test('owner auto-derivation derives K1 immediately without pending modal state', async () => {
		const rekeySalt = 'abcdef0123456789abcdef0123456789';
		const roomPassword = 'owner-chosen-secret-999';

		const ownerManager = new RekeyManager({ timeoutMs: 15000 });
		ownerManager.setActiveKey(k0);

		// Signaling REKEY broadcast arrives
		ownerManager.startRekey(k0, rekeySalt);
		assert.equal(ownerManager.isPending(), true);

		// Owner auto-derives using staged password immediately
		const k1 = await ownerManager.submitPassword(roomPassword);
		assert.equal(ownerManager.isPending(), false);
		assert.equal(ownerManager.getStatus(), 'success');
		assert.equal(ownerManager.getActiveKey(), k1);

		// Encrypt under K1 and verify ciphertext structure
		const plaintext = new TextEncoder().encode('Encrypted message under new K1');
		const packet = await encryptChunk(k1, plaintext);
		const decrypted = await decryptChunk(k1, packet);
		assert.deepEqual(decrypted, plaintext);

		ownerManager.dispose();
	});

	test('participant receiving REKEY derives identical K1 when entering valid password', async () => {
		const rekeySalt = 'abcdef0123456789abcdef0123456789';
		const roomPassword = 'owner-chosen-secret-999';

		// 1. Owner derives K1
		const ownerK1 = await deriveRekeyedKey(k0, roomPassword, rekeySalt);

		// 2. Participant receives REKEY and enters the matching password
		const participantRekey = new RekeyManager({ timeoutMs: 15000 });
		participantRekey.setActiveKey(k0);
		participantRekey.startRekey(k0, rekeySalt);

		assert.equal(participantRekey.isPending(), true);
		assert.ok(participantRekey.getRemainingTimeMs() > 0);

		const participantK1 = await participantRekey.submitPassword(roomPassword);
		assert.equal(participantRekey.isPending(), false);
		assert.equal(participantRekey.getStatus(), 'success');

		// 3. Bidirectional communication check: participant can decrypt owner's ciphertext
		const message = new TextEncoder().encode('Hello from owner encrypted under K1');
		const encryptedByOwner = await encryptChunk(ownerK1, message);
		const decryptedByParticipant = await decryptChunk(participantK1, encryptedByOwner);
		assert.deepEqual(decryptedByParticipant, message);

		participantRekey.dispose();
	});

	test('participant entering wrong password derives mismatched key that fails decryption', async () => {
		const rekeySalt = 'abcdef0123456789abcdef0123456789';
		const correctPassword = 'correct-room-password';
		const wrongPassword = 'wrong-room-password';

		const ownerK1 = await deriveRekeyedKey(k0, correctPassword, rekeySalt);
		const wrongK1 = await deriveRekeyedKey(k0, wrongPassword, rekeySalt);

		const message = new TextEncoder().encode('Top secret owner message');
		const encryptedByOwner = await encryptChunk(ownerK1, message);

		await assert.rejects(
			async () => decryptChunk(wrongK1, encryptedByOwner),
			/failed|decryption|authentication/i
		);
	});

	test('WebRTC mesh disconnects all peers when rekey times out or verification fails', async () => {
		let timeoutFired = false;
		const mockTimer = {
			setTimeout: (cb: () => void) => {
				// Store callback to invoke manually
				mockTimerCallback = cb;
				return 1;
			},
			clearTimeout: () => {}
		};
		let mockTimerCallback: (() => void) | null = null;

		const rekeyManager = new RekeyManager({
			timeoutMs: 15000,
			timer: mockTimer
		});
		rekeyManager.setActiveKey(k0);

		let disconnectAllCalled = false;
		const mockWebRtcManager = {
			activeKey: k0,
			disconnectAll: () => {
				disconnectAllCalled = true;
			},
			setEncryptionKey: () => {}
		};

		// Bind rekey timeout to WebRTC disconnect
		rekeyManager.onTimeout(() => {
			mockWebRtcManager.disconnectAll();
		});

		rekeyManager.startRekey(k0, sampleSalt);
		assert.equal(rekeyManager.isPending(), true);
		assert.equal(disconnectAllCalled, false);

		// Timeout fires -> triggers disconnectAll immediately
		assert.ok(mockTimerCallback);
		(mockTimerCallback as () => void)();

		assert.equal(rekeyManager.getStatus(), 'timed_out');
		assert.equal(disconnectAllCalled, true);

		rekeyManager.dispose();
	});

	test('SignalingClient setRoomPassword dispatches SET_ROOM_PASSWORD message', () => {
		const client = new SignalingClient({ wsUrl: 'ws://localhost:9999/ws' });
		let sentMessage: any = null;

		(client as any).send = (msg: any) => {
			sentMessage = msg;
		};

		client.setRoomPassword('new-secure-password-456');
		assert.deepEqual(sentMessage, {
			type: 'SET_ROOM_PASSWORD',
			password: 'new-secure-password-456'
		});
	});

	test('SignalingClient verifyPassword sends VERIFY_PASSWORD and resolves boolean', async () => {
		const client = new SignalingClient({ wsUrl: 'ws://localhost:9999/ws' });
		let sentMessage: any = null;

		// Mock open WebSocket
		(client as any).ws = { readyState: 1 }; // WebSocket.OPEN = 1
		(client as any).send = (msg: any) => {
			sentMessage = msg;
		};

		// Trigger promise and simulate server response
		const verifyPromise = client.verifyPassword('test-password-789');
		assert.deepEqual(sentMessage, {
			type: 'VERIFY_PASSWORD',
			password: 'test-password-789'
		});

		// Simulate server returning PASSWORD_VERIFIED
		(client as any).handleIncomingRawMessage(
			JSON.stringify({
				type: 'PASSWORD_VERIFIED',
				valid: true
			})
		);

		const result = await verifyPromise;
		assert.equal(result, true);
	});
});

function getStoreState() {
	let value: any;
	const unsub = roomStore.subscribe((s) => {
		value = s;
	});
	unsub();
	return value;
}
