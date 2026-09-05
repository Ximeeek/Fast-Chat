import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { validateRoomCode, normalizeRoomCode, formatRoomCodeInput } from '../src/lib/utils/roomCode.ts';
import { roomStore, peerCount, type RoomState } from '../src/lib/stores/room.ts';

describe('Room Code Validation & Formatting', () => {
	test('validateRoomCode accepts strict 0000-0000-0000 format', () => {
		assert.equal(validateRoomCode('1234-5678-9012'), true);
		assert.equal(validateRoomCode('0000-0000-0000'), true);
		assert.equal(validateRoomCode('9999-9999-9999'), true);
	});

	test('validateRoomCode rejects invalid formats', () => {
		assert.equal(validateRoomCode(''), false);
		assert.equal(validateRoomCode('1234-5678-901'), false);
		assert.equal(validateRoomCode('1234-5678-90123'), false);
		assert.equal(validateRoomCode('123456789012'), false);
		assert.equal(validateRoomCode('1234_5678_9012'), false);
		assert.equal(validateRoomCode('abcd-efgh-ijkl'), false);
		assert.equal(validateRoomCode('123a-5678-9012'), false);
		assert.equal(validateRoomCode(' 1234-5678-9012 '), true);
	});

	test('formatRoomCodeInput formats raw digits into hyphens progressively', () => {
		assert.equal(formatRoomCodeInput(''), '');
		assert.equal(formatRoomCodeInput('123'), '123');
		assert.equal(formatRoomCodeInput('1234'), '1234');
		assert.equal(formatRoomCodeInput('12345'), '1234-5');
		assert.equal(formatRoomCodeInput('12345678'), '1234-5678');
		assert.equal(formatRoomCodeInput('123456789'), '1234-5678-9');
		assert.equal(formatRoomCodeInput('123456789012'), '1234-5678-9012');
		assert.equal(formatRoomCodeInput('1234-5678-9012 extra'), '1234-5678-9012');
		assert.equal(formatRoomCodeInput('abc1234def5678ghi9012xxx'), '1234-5678-9012');
	});

	test('normalizeRoomCode trims whitespace', () => {
		assert.equal(normalizeRoomCode('  1234-5678-9012  '), '1234-5678-9012');
		assert.equal(normalizeRoomCode(''), '');
	});
});

describe('In-Memory Room Store Lifecycle', () => {
	beforeEach(() => {
		roomStore.reset();
	});

	test('initial state has null room code and disconnected status', () => {
		let state!: RoomState;
		const unsub = roomStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.code, null);
		assert.equal(state.isOwner, false);
		assert.equal(state.connectionState, 'disconnected');
		assert.equal(state.lifecycle, 'idle');
		assert.deepEqual(state.peers, []);
	});

	test('setCreated updates state with owner privileges', () => {
		roomStore.setCreated({
			type: 'ROOM_CREATED',
			code: '1234-5678-9012',
			peer_id: 'peer-owner',
			salt: 'aabbcc112233',
			expires_at: 1800000000
		});

		let state!: RoomState;
		const unsub = roomStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.code, '1234-5678-9012');
		assert.equal(state.peerId, 'peer-owner');
		assert.equal(state.isOwner, true);
		assert.equal(state.salt, 'aabbcc112233');
		assert.equal(state.expiresAt, 1800000000);
		assert.equal(state.lifecycle, 'joined');
	});

	test('setJoined updates state with participant peers', () => {
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: '1234-5678-9012',
			peer_id: 'peer-client',
			is_owner: false,
			salt: 'aabbcc112233',
			expires_at: 1800000000,
			peers: ['peer-owner', 'peer-other']
		});

		let state!: RoomState;
		const unsub = roomStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.code, '1234-5678-9012');
		assert.equal(state.peerId, 'peer-client');
		assert.equal(state.isOwner, false);
		assert.deepEqual(state.peers, ['peer-owner', 'peer-other']);
	});

	test('peer joined and left updates peer roster reactively', () => {
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: '1234-5678-9012',
			peer_id: 'peer-client',
			is_owner: false,
			salt: 'aabbcc112233',
			expires_at: 1800000000,
			peers: ['peer-owner']
		});

		roomStore.addPeer('peer-bob');
		roomStore.addPeer('peer-bob');

		let state!: RoomState;
		let count!: number;
		const unsub1 = roomStore.subscribe((s) => {
			state = s;
		});
		const unsub2 = peerCount.subscribe((c) => {
			count = c;
		});
		unsub1();
		unsub2();

		assert.deepEqual(state.peers, ['peer-owner', 'peer-bob']);
		assert.equal(count, 2);

		roomStore.removePeer('peer-owner');

		const unsub3 = roomStore.subscribe((s) => {
			state = s;
		});
		unsub3();
		assert.deepEqual(state.peers, ['peer-bob']);
	});

	test('room lifecycle transitions: closing and closed', () => {
		roomStore.setClosing(1800000010, 1800000000);

		let state!: RoomState;
		const unsub1 = roomStore.subscribe((s) => {
			state = s;
		});
		unsub1();

		assert.equal(state.lifecycle, 'closing');
		assert.equal(state.closingDeadline, 1800000010);

		roomStore.setClosed('Room lifetime expired');

		const unsub2 = roomStore.subscribe((s) => {
			state = s;
		});
		unsub2();

		assert.equal(state.lifecycle, 'closed');
		assert.equal(state.closureReason, 'Room lifetime expired');
		assert.equal(state.connectionState, 'closed');
	});
});

describe('Zero Storage Policy Audit', () => {
	test('no localStorage or sessionStorage present in src directory', () => {
		function scanDir(dir: string): void {
			const files = readdirSync(dir);
			for (const file of files) {
				const fullPath = join(dir, file);
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					scanDir(fullPath);
				} else if (file.endsWith('.ts') || file.endsWith('.svelte') || file.endsWith('.js')) {
					const content = readFileSync(fullPath, 'utf8');
					assert.equal(
						content.includes('localStorage'),
						false,
						`Forbidden localStorage detected in ${fullPath}`
					);
					assert.equal(
						content.includes('sessionStorage'),
						false,
						`Forbidden sessionStorage detected in ${fullPath}`
					);
				}
			}
		}

		scanDir(join(process.cwd(), 'src'));
	});
});
