import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { validateRoomCode, normalizeRoomCode, formatRoomCodeInput, encodeRoomToken, decodeRoomToken, isRoomToken, resolveRoomIdentifier } from '../src/lib/utils/roomCode.ts';
import { roomStore, peerCount, type RoomState } from '../src/lib/stores/room.ts';
import { formatChatLog } from '../src/lib/chat/export.ts';

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
		assert.equal(validateRoomCode('http://localhost:5173/room/98e508ffd0ab09b3'), false);
		assert.equal(validateRoomCode('https://fastchat.room/room/98e508ffd0ab09b3'), false);
		assert.equal(validateRoomCode('98e508ffd0ab09b3'), false);
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

describe('Cryptographic Room Token Encryption & Resolution', () => {
	test('encodeRoomToken produces a 16-hex character token without raw digits', () => {
		const code = '1234-5678-9012';
		const token = encodeRoomToken(code);
		assert.equal(token.length, 16);
		assert.match(token, /^[0-9a-f]{16}$/);
		assert.equal(token.includes('1234'), false);
		assert.equal(token.includes('5678'), false);
		assert.equal(token.includes('9012'), false);
	});

	test('decodeRoomToken correctly reverses encodeRoomToken across boundary codes', () => {
		const testCodes = [
			'0000-0000-0000',
			'9999-9999-9999',
			'1234-5678-9012',
			'0001-0002-0003',
			'8472-1940-3829'
		];

		for (const code of testCodes) {
			const token = encodeRoomToken(code);
			const decoded = decodeRoomToken(token);
			assert.equal(decoded, code, `Expected ${code} to roundtrip through token ${token}`);
		}
	});

	test('decodeRoomToken rejects corrupted or tampered tokens via 24-bit integrity tag', () => {
		const validToken = encodeRoomToken('1234-5678-9012');

		// Tamper with first character
		const tamperedChar = validToken[0] === 'a' ? 'b' : 'a';
		const tamperedToken = tamperedChar + validToken.slice(1);
		assert.equal(decodeRoomToken(tamperedToken), null, 'Tampered token must fail integrity tag check');

		// Invalid lengths and formats
		assert.equal(decodeRoomToken(''), null);
		assert.equal(decodeRoomToken('abc'), null);
		assert.equal(decodeRoomToken(validToken.slice(0, 15)), null);
		assert.equal(decodeRoomToken(validToken + '0'), null);
		assert.equal(decodeRoomToken('gggg-gggg-gggg-g'), null);
	});

	test('Feistel cipher displays strong avalanche effect on 1-digit delta', () => {
		const token1 = encodeRoomToken('1234-5678-9012');
		const token2 = encodeRoomToken('1234-5678-9013');

		assert.notEqual(token1, token2);

		// Convert hex to 64-bit BigInt and count differing bits (Hamming distance)
		const diff = BigInt(`0x${token1}`) ^ BigInt(`0x${token2}`);
		let bitDiffCount = 0;
		for (let i = 0n; i < 64n; i++) {
			if ((diff >> i) & 1n) {
				bitDiffCount++;
			}
		}

		// Strong avalanche effect flips ~50% of the 64 bits (at least 18 bits)
		assert.ok(bitDiffCount >= 18, `Expected avalanche effect >= 18 bits, got ${bitDiffCount}`);
	});

	test('resolveRoomIdentifier resolves encrypted token, formatted code, and full URL', () => {
		const code = '4321-8765-2109';
		const token = encodeRoomToken(code);

		// Case 1: Encrypted token
		const res1 = resolveRoomIdentifier(token);
		assert.ok(res1);
		assert.equal(res1.code, code);
		assert.equal(res1.token, token);

		// Case 2: Formatted code
		const res2 = resolveRoomIdentifier(code);
		assert.ok(res2);
		assert.equal(res2.code, code);
		assert.equal(res2.token, token);

		// Case 3: 12 raw digits
		const res3 = resolveRoomIdentifier('432187652109');
		assert.ok(res3);
		assert.equal(res3.code, code);
		assert.equal(res3.token, token);

		// Case 4: Full URL with token
		const res4 = resolveRoomIdentifier(`https://fastchat.room/room/${token}`);
		assert.ok(res4);
		assert.equal(res4.code, code);
		assert.equal(res4.token, token);

		// Case 5: Full URL with raw code
		const res5 = resolveRoomIdentifier(`https://fastchat.room/room/${code}`);
		assert.ok(res5);
		assert.equal(res5.code, code);
		assert.equal(res5.token, token);

		// Case 6: Invalid input
		assert.equal(resolveRoomIdentifier('invalid-room'), null);
		assert.equal(resolveRoomIdentifier(''), null);
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
		assert.equal(state.ownerPeerId, 'peer-owner');
		assert.equal(state.salt, 'aabbcc112233');
		assert.equal(state.expiresAt, 1800000000);
		assert.equal(state.lifecycle, 'joined');
	});

	test('setJoined updates state with participant peers and ownerPeerId', () => {
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: '1234-5678-9012',
			peer_id: 'peer-client',
			is_owner: false,
			owner_peer_id: 'peer-owner',
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
		assert.equal(state.ownerPeerId, 'peer-owner');
		assert.deepEqual(state.peers, ['peer-owner', 'peer-other']);
	});

	test('setOwner updates owner peer and recomputes isOwner', () => {
		roomStore.setJoined({
			type: 'JOIN_OK',
			status: 'OK',
			code: '1234-5678-9012',
			peer_id: 'peer-client',
			is_owner: false,
			owner_peer_id: 'peer-owner',
			salt: 'aabbcc112233',
			expires_at: 1800000000,
			peers: ['peer-owner', 'peer-other']
		});

		let state!: RoomState;
		const unsub = roomStore.subscribe((s) => {
			state = s;
		});
		unsub();

		assert.equal(state.isOwner, false);
		assert.equal(state.ownerPeerId, 'peer-owner');

		// Transfer ownership to peer-client (local peer)
		roomStore.setOwner('peer-client');

		const unsub2 = roomStore.subscribe((s) => {
			state = s;
		});
		unsub2();

		assert.equal(state.isOwner, true);
		assert.equal(state.ownerPeerId, 'peer-client');

		// Transfer ownership to peer-other (remote peer)
		roomStore.setOwner('peer-other');

		const unsub3 = roomStore.subscribe((s) => {
			state = s;
		});
		unsub3();

		assert.equal(state.isOwner, false);
		assert.equal(state.ownerPeerId, 'peer-other');
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

describe('Search Engine Privacy & Zero Storage Policy Audit', () => {
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

	test('both /create and /room/[code] pages contain noindex nofollow meta directive', () => {
		const createPage = readFileSync(join(process.cwd(), 'src/routes/create/+page.svelte'), 'utf8');
		const roomPage = readFileSync(join(process.cwd(), 'src/routes/room/[code]/+page.svelte'), 'utf8');

		assert.match(
			createPage,
			/<meta\s+name=["']robots["']\s+content=["']noindex,\s*nofollow["']\s*\/?>/,
			'Missing noindex, nofollow in /create/+page.svelte'
		);
		assert.match(
			roomPage,
			/<meta\s+name=["']robots["']\s+content=["']noindex,\s*nofollow["']\s*\/?>/,
			'Missing noindex, nofollow in /room/[code]/+page.svelte'
		);
	});

	test('formatChatLog correctly formats system announcements and peer messages', () => {
		const log = formatChatLog('1234-5678-9012', [
			{
				id: 'msg-1',
				sender: 'alice',
				content: 'Hello everyone',
				timestamp: 1700000000000,
				isSelf: false
			},
			{
				id: 'sys-1',
				sender: 'System',
				content: 'Room owner disconnected. You are now the room owner.',
				timestamp: 1700000010000,
				isSelf: false,
				isSystem: true
			}
		]);

		assert.equal(log.includes('[SYSTEM]: Room owner disconnected. You are now the room owner.'), true);
		assert.equal(log.includes('alice: Hello everyone'), true);
	});
});

