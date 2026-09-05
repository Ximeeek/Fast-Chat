import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	deriveInitialKey,
	parseSalt,
	normalizeRoomCodeSecret
} from '../src/lib/crypto/index.ts';

describe('Initial Key Derivation (K0 via HKDF-SHA256)', () => {
	const sampleRoomCode = '1234-5678-9012';
	const sampleHexSalt = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	test('deriveInitialKey derives a valid 256-bit AES-GCM secret CryptoKey', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);

		assert.ok(key instanceof CryptoKey);
		assert.equal(key.type, 'secret');
		assert.equal(key.algorithm.name, 'AES-GCM');
		// @ts-expect-error length exists on AesKeyAlgorithm
		assert.equal(key.algorithm.length, 256);
		assert.deepEqual(key.usages, ['encrypt', 'decrypt']);
	});

	test('deriveInitialKey is strictly deterministic for identical roomCode and salt', async () => {
		const keyA = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const keyB = await deriveInitialKey(sampleRoomCode, sampleHexSalt);

		const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', keyA));
		const rawB = new Uint8Array(await crypto.subtle.exportKey('raw', keyB));

		assert.equal(rawA.length, 32);
		assert.equal(rawB.length, 32);
		assert.deepEqual(rawA, rawB);
	});

	test('different room codes produce different derived keys for the same salt', async () => {
		const key1 = await deriveInitialKey('1234-5678-9012', sampleHexSalt);
		const key2 = await deriveInitialKey('9876-5432-1098', sampleHexSalt);

		const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', key1));
		const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', key2));

		assert.notDeepEqual(raw1, raw2);
	});

	test('different salts produce different derived keys for the same room code', async () => {
		const salt1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const salt2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

		const key1 = await deriveInitialKey(sampleRoomCode, salt1);
		const key2 = await deriveInitialKey(sampleRoomCode, salt2);

		const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', key1));
		const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', key2));

		assert.notDeepEqual(raw1, raw2);
	});

	test('parseSalt parses hexadecimal string, binary Uint8Array, and UTF-8 strings', async () => {
		// Hex salt
		const hexBytes = parseSalt('000102030405060708090a0b0c0d0e0f');
		assert.equal(hexBytes.length, 16);
		assert.equal(hexBytes[0], 0x00);
		assert.equal(hexBytes[15], 0x0f);

		// Raw Uint8Array salt
		const rawBytes = new Uint8Array([1, 2, 3, 4]);
		const parsedRaw = parseSalt(rawBytes);
		assert.deepEqual(parsedRaw, rawBytes);

		// Non-hex string salt
		const utf8Salt = parseSalt('non-hex-salt-text');
		assert.deepEqual(utf8Salt, new TextEncoder().encode('non-hex-salt-text'));
	});

	test('deriveInitialKey rejects empty room code or empty salt', async () => {
		await assert.rejects(
			async () => deriveInitialKey('', sampleHexSalt),
			/cannot be empty/i
		);

		await assert.rejects(
			async () => deriveInitialKey('   ', sampleHexSalt),
			/cannot be empty/i
		);

		await assert.rejects(
			async () => deriveInitialKey(sampleRoomCode, ''),
			/cannot be empty/i
		);

		await assert.rejects(
			async () => deriveInitialKey(sampleRoomCode, new Uint8Array(0)),
			/cannot be empty/i
		);
	});
});
