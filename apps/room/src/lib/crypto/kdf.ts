import type { KeyDerivationOptions } from './types.ts';

/**
 * Parses a salt input into a Uint8Array.
 * If the salt is a hexadecimal string (common in server responses),
 * it converts the hex characters into binary bytes.
 * Otherwise, it falls back to UTF-8 byte encoding.
 *
 * @param salt - Hex-encoded string, plain text string, or binary Uint8Array.
 * @returns Decoded byte buffer of the salt.
 */
export function parseSalt(salt: string | Uint8Array): Uint8Array {
	if (salt instanceof Uint8Array) {
		if (salt.byteLength === 0) {
			throw new Error('Cryptographic salt cannot be empty');
		}
		return salt;
	}

	if (typeof salt !== 'string') {
		throw new TypeError('Salt must be a string or Uint8Array');
	}

	const trimmed = salt.trim();
	if (trimmed.length === 0) {
		throw new Error('Cryptographic salt cannot be empty');
	}

	// If salt is a valid hexadecimal string with even length (e.g. 32 or 64 hex characters)
	if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
		const bytes = new Uint8Array(trimmed.length / 2);
		for (let i = 0; i < trimmed.length; i += 2) {
			bytes[i / 2] = parseInt(trimmed.substring(i, i + 2), 16);
		}
		return bytes;
	}

	return new TextEncoder().encode(trimmed);
}

/**
 * Normalizes room code string by trimming surrounding whitespace.
 *
 * @param roomCode - The raw room code identifier.
 * @returns Cleaned room code.
 */
export function normalizeRoomCodeSecret(roomCode: string): string {
	if (typeof roomCode !== 'string') {
		throw new TypeError('Room code must be a string');
	}
	const trimmed = roomCode.trim();
	if (trimmed.length === 0) {
		throw new Error('Room code cannot be empty');
	}
	return trimmed;
}

/**
 * Derives the initial room encryption key (K0) using native Web Crypto API HKDF-SHA256.
 *
 * The room code acts as the secret Input Keying Material (IKM), while the room salt
 * acts as the public HKDF salt. This ensures that even though the salt is distributed
 * publicly through signaling, the derived key cannot be reconstructed without the secret room code.
 *
 * Target algorithm is AES-GCM with a 256-bit key length.
 *
 * @param roomCode - Secret room code identifier (e.g. '0000-0000-0000').
 * @param salt - Public per-room salt provided by the server or generated during room creation.
 * @param options - Optional configuration for HKDF info, extractability, and usages.
 * @returns Promise resolving to the derived 256-bit AES-GCM CryptoKey.
 */
export async function deriveInitialKey(
	roomCode: string,
	salt: string | Uint8Array,
	options: KeyDerivationOptions = {}
): Promise<CryptoKey> {
	const normalizedCode = normalizeRoomCodeSecret(roomCode);
	const saltBytes = parseSalt(salt);

	const infoBytes =
		typeof options.info === 'string'
			? new TextEncoder().encode(options.info)
			: options.info instanceof Uint8Array
				? options.info
				: new TextEncoder().encode('fastchat-v1-room-key');

	const extractable = options.extractable ?? true;
	const usages: KeyUsage[] = options.usages ?? ['encrypt', 'decrypt'];

	const ikm = new TextEncoder().encode(normalizedCode);

	// Import roomCode as HKDF base key material
	const baseKey = await crypto.subtle.importKey(
		'raw',
		ikm,
		{ name: 'HKDF' },
		false,
		['deriveKey', 'deriveBits']
	);

	// Derive 256-bit AES-GCM key using HKDF-SHA256
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: saltBytes as unknown as BufferSource,
			info: infoBytes as unknown as BufferSource
		},
		baseKey,
		{
			name: 'AES-GCM',
			length: 256
		},
		extractable,
		usages
	);
}
