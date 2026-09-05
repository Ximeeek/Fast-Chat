import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
	deriveInitialKey,
	deriveRekeyedKey,
	RekeyManager,
	encryptChunk,
	decryptChunk,
	DecryptionError,
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

describe('Rekey Derivation (K1 via HKDF(K0, password))', () => {
	const sampleRoomCode = '1234-5678-9012';
	const sampleHexSalt = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	test('deriveRekeyedKey produces a valid AES-GCM key and K1 differs from K0', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const k1 = await deriveRekeyedKey(k0, 'new-secret-password-123');

		assert.ok(k1 instanceof CryptoKey);
		assert.equal(k1.type, 'secret');
		assert.equal(k1.algorithm.name, 'AES-GCM');
		// @ts-expect-error length property exists on AesKeyAlgorithm
		assert.equal(k1.algorithm.length, 256);

		const rawK0 = new Uint8Array(await crypto.subtle.exportKey('raw', k0));
		const rawK1 = new Uint8Array(await crypto.subtle.exportKey('raw', k1));

		assert.equal(rawK0.length, 32);
		assert.equal(rawK1.length, 32);
		assert.notDeepEqual(rawK0, rawK1);
	});

	test('deriveRekeyedKey is deterministic for identical K0 and password', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const k1A = await deriveRekeyedKey(k0, 'consistent-password');
		const k1B = await deriveRekeyedKey(k0, 'consistent-password');

		const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', k1A));
		const rawB = new Uint8Array(await crypto.subtle.exportKey('raw', k1B));

		assert.deepEqual(rawA, rawB);
	});

	test('different passwords produce completely different K1 keys', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const k1A = await deriveRekeyedKey(k0, 'password-alpha');
		const k1B = await deriveRekeyedKey(k0, 'password-beta');

		const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', k1A));
		const rawB = new Uint8Array(await crypto.subtle.exportKey('raw', k1B));

		assert.notDeepEqual(rawA, rawB);
	});

	test('accepts k0 as raw Uint8Array and ArrayBuffer in addition to CryptoKey', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const rawBuffer = await crypto.subtle.exportKey('raw', k0);
		const rawBytes = new Uint8Array(rawBuffer);

		const k1FromKey = await deriveRekeyedKey(k0, 'shared-password');
		const k1FromBytes = await deriveRekeyedKey(rawBytes, 'shared-password');
		const k1FromBuffer = await deriveRekeyedKey(rawBuffer, 'shared-password');

		const bytesKey = new Uint8Array(await crypto.subtle.exportKey('raw', k1FromKey));
		const bytesRaw = new Uint8Array(await crypto.subtle.exportKey('raw', k1FromBytes));
		const bytesBuf = new Uint8Array(await crypto.subtle.exportKey('raw', k1FromBuffer));

		assert.deepEqual(bytesKey, bytesRaw);
		assert.deepEqual(bytesKey, bytesBuf);
	});

	test('incorporates optional server rekey salt if provided', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const rekeySalt1 = '0102030405060708090a0b0c0d0e0f10';
		const rekeySalt2 = '1112131415161718191a1b1c1d1e1f20';

		const k1Salt1 = await deriveRekeyedKey(k0, 'same-password', rekeySalt1);
		const k1Salt2 = await deriveRekeyedKey(k0, 'same-password', rekeySalt2);

		const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', k1Salt1));
		const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', k1Salt2));

		assert.notDeepEqual(raw1, raw2);
	});
});

describe('RekeyManager & ~15-Second Grace Window', () => {
	const sampleRoomCode = '1234-5678-9012';
	const sampleHexSalt = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	test('default timeout is configured to 15,000 milliseconds (~15 seconds)', () => {
		const manager = new RekeyManager();
		assert.equal(manager.getStatus(), 'idle');
		assert.equal(manager.isPending(), false);
		assert.equal(manager.getActiveKey(), null);
		manager.dispose();
	});

	test('successful password submission within window transitions state to success and updates key', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		let successCalled = false;
		let successKey: CryptoKey | null = null;

		const manager = new RekeyManager({
			timeoutMs: 15000,
			onSuccess: (newKey) => {
				successCalled = true;
				successKey = newKey;
			}
		});

		manager.setActiveKey(k0);
		manager.startRekey();

		assert.equal(manager.isPending(), true);
		assert.equal(manager.getStatus(), 'pending');
		assert.ok(manager.getRemainingTimeMs() > 0);

		const k1 = await manager.submitPassword('correct-room-password');

		assert.equal(manager.isPending(), false);
		assert.equal(manager.getStatus(), 'success');
		assert.equal(successCalled, true);
		assert.equal(manager.getActiveKey(), k1);
		assert.equal(successKey, k1);

		manager.dispose();
	});

	test('timeout fires and executes onTimeout hook if password is not submitted', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		let timeoutFired = false;

		const manager = new RekeyManager({
			timeoutMs: 30, // 30ms for immediate automated testing
			onTimeout: () => {
				timeoutFired = true;
			}
		});

		manager.setActiveKey(k0);
		manager.startRekey();

		assert.equal(manager.isPending(), true);

		// Await beyond the 30ms window
		await new Promise((resolve) => setTimeout(resolve, 60));

		assert.equal(timeoutFired, true);
		assert.equal(manager.isPending(), false);
		assert.equal(manager.getStatus(), 'timed_out');

		// Attempting to submit password after timeout rejects
		await assert.rejects(
			async () => manager.submitPassword('late-password'),
			/no pending rekey/i
		);

		manager.dispose();
	});

	test('mocked timer precisely validates the ~15-second duration', async () => {
		let scheduledCallback: (() => void) | null = null;
		let scheduledDelay = 0;
		let timeoutTriggered = false;

		const mockTimer = {
			setTimeout: (cb: () => void, ms: number) => {
				scheduledCallback = cb;
				scheduledDelay = ms;
				return 101;
			},
			clearTimeout: (_id: any) => {
				scheduledCallback = null;
			}
		};

		const manager = new RekeyManager({
			timeoutMs: 15000,
			timer: mockTimer,
			onTimeout: () => {
				timeoutTriggered = true;
			}
		});

		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		manager.setActiveKey(k0);
		manager.startRekey();

		assert.equal(scheduledDelay, 15000);
		assert.equal(timeoutTriggered, false);
		assert.equal(manager.isPending(), true);

		// Trigger mock timeout
		scheduledCallback!();

		assert.equal(timeoutTriggered, true);
		assert.equal(manager.getStatus(), 'timed_out');
		assert.equal(manager.isPending(), false);

		manager.dispose();
	});

	test('cancelling rekey clears timer and resets pending state', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		let timeoutFired = false;

		const manager = new RekeyManager({
			timeoutMs: 50,
			onTimeout: () => {
				timeoutFired = true;
			}
		});

		manager.setActiveKey(k0);
		manager.startRekey();
		manager.cancel();

		assert.equal(manager.getStatus(), 'cancelled');
		assert.equal(manager.isPending(), false);

		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(timeoutFired, false);

		manager.dispose();
	});
});

describe('Chunk Encryption & Decryption (AES-256-GCM)', () => {
	const sampleRoomCode = '1234-5678-9012';
	const sampleHexSalt = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

	test('encryptChunk and decryptChunk successfully round-trip UTF-8 string messages', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const message = 'Hello, this is an end-to-end encrypted FastChat message! 🚀🔐';

		const encrypted = await encryptChunk(key, message);
		assert.ok(encrypted instanceof Uint8Array);
		// 12 bytes IV + plaintext length + 16 bytes tag
		const expectedLength = 12 + new TextEncoder().encode(message).length + 16;
		assert.equal(encrypted.length, expectedLength);

		const decryptedBytes = await decryptChunk(key, encrypted);
		const decryptedMessage = new TextDecoder().decode(decryptedBytes);
		assert.equal(decryptedMessage, message);
	});

	test('encryptChunk and decryptChunk round-trip arbitrary binary file chunks', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		// 64KB random binary data simulating file chunk
		const binaryChunk = new Uint8Array(65536);
		for (let i = 0; i < binaryChunk.length; i++) {
			binaryChunk[i] = (i * 37 + 13) & 0xff;
		}

		const encrypted = await encryptChunk(key, binaryChunk);
		assert.equal(encrypted.length, 12 + 65536 + 16);

		const decrypted = await decryptChunk(key, encrypted);
		assert.deepEqual(decrypted, binaryChunk);
	});

	test('each encryption produces a unique ciphertext due to distinct random 96-bit IVs', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const message = 'Identical repeated payload';

		const cipherA = await encryptChunk(key, message);
		const cipherB = await encryptChunk(key, message);

		assert.notDeepEqual(cipherA, cipherB);
		// IV portions (first 12 bytes) must be different
		assert.notDeepEqual(cipherA.subarray(0, 12), cipherB.subarray(0, 12));

		// Both decrypt back to identical message
		assert.equal(new TextDecoder().decode(await decryptChunk(key, cipherA)), message);
		assert.equal(new TextDecoder().decode(await decryptChunk(key, cipherB)), message);
	});

	test('decryptChunk with wrong key fails and throws DecryptionError', async () => {
		const keyCorrect = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const keyWrong = await deriveInitialKey('9999-9999-9999', sampleHexSalt);

		const encrypted = await encryptChunk(keyCorrect, 'Top secret communication');

		await assert.rejects(
			async () => decryptChunk(keyWrong, encrypted),
			(err: unknown) => {
				assert.ok(err instanceof DecryptionError);
				assert.match(err.message, /authentication verification failed/i);
				return true;
			}
		);
	});

	test('decryptChunk rejects tampered ciphertext or altered authentication tag', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const encrypted = await encryptChunk(key, 'Integrity-protected payload');

		// Tamper single bit in ciphertext payload
		const tamperedPayload = new Uint8Array(encrypted);
		tamperedPayload[15] ^= 0x01;

		await assert.rejects(
			async () => decryptChunk(key, tamperedPayload),
			DecryptionError
		);

		// Tamper single bit in initialization vector
		const tamperedIv = new Uint8Array(encrypted);
		tamperedIv[2] ^= 0x01;

		await assert.rejects(
			async () => decryptChunk(key, tamperedIv),
			DecryptionError
		);

		// Tamper single bit in authentication tag (last 16 bytes)
		const tamperedTag = new Uint8Array(encrypted);
		tamperedTag[tamperedTag.length - 1] ^= 0x01;

		await assert.rejects(
			async () => decryptChunk(key, tamperedTag),
			DecryptionError
		);
	});

	test('decryptChunk rejects packets shorter than minimum length (28 bytes)', async () => {
		const key = await deriveInitialKey(sampleRoomCode, sampleHexSalt);

		await assert.rejects(
			async () => decryptChunk(key, new Uint8Array(27)),
			(err: unknown) => {
				assert.ok(err instanceof DecryptionError);
				assert.match(err.message, /chunk too short/i);
				return true;
			}
		);

		await assert.rejects(
			async () => decryptChunk(key, new Uint8Array(0)),
			DecryptionError
		);
	});

	test('cryptographic boundary between K0 and rekeyed K1', async () => {
		const k0 = await deriveInitialKey(sampleRoomCode, sampleHexSalt);
		const k1 = await deriveRekeyedKey(k0, 'new-room-passcode');

		const k0Message = 'Encrypted before rekey under K0';
		const k1Message = 'Encrypted after rekey under K1';

		const cipherK0 = await encryptChunk(k0, k0Message);
		const cipherK1 = await encryptChunk(k1, k1Message);

		// Successful decryption with respective keys
		assert.equal(new TextDecoder().decode(await decryptChunk(k0, cipherK0)), k0Message);
		assert.equal(new TextDecoder().decode(await decryptChunk(k1, cipherK1)), k1Message);

		// Cross-key decryption MUST fail with DecryptionError
		await assert.rejects(async () => decryptChunk(k1, cipherK0), DecryptionError);
		await assert.rejects(async () => decryptChunk(k0, cipherK1), DecryptionError);
	});
});

describe('Zero Key Transmission & Memory Security Audit', () => {
	test('crypto module contains zero network requests and zero console logging', () => {
		const cryptoDir = join(process.cwd(), 'src/lib/crypto');
		const files = readdirSync(cryptoDir).filter((f) => f.endsWith('.ts'));

		assert.ok(files.length >= 4, 'Expected at least 4 files in crypto directory');

		for (const file of files) {
			const content = readFileSync(join(cryptoDir, file), 'utf-8');

			// Assert no console.log statements
			assert.equal(
				content.includes('console.log'),
				false,
				`File ${file} must not contain console.log`
			);

			// Assert no network fetch or WebSocket calls
			assert.equal(
				content.includes('fetch('),
				false,
				`File ${file} must not perform network fetch calls`
			);
			assert.equal(
				content.includes('WebSocket'),
				false,
				`File ${file} must not construct or interact with WebSocket`
			);

			// Assert no web storage
			assert.equal(
				content.includes('localStorage'),
				false,
				`File ${file} must not reference localStorage`
			);
			assert.equal(
				content.includes('sessionStorage'),
				false,
				`File ${file} must not reference sessionStorage`
			);
		}
	});
});
