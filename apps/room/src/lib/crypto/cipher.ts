/**
 * Error thrown when chunk decryption or authentication verification fails.
 */
export class DecryptionError extends Error {
	constructor(message: string = 'Decryption failed: invalid key or corrupted ciphertext') {
		super(message);
		this.name = 'DecryptionError';
	}
}

/**
 * Standard initialization vector (IV / nonce) length in bytes for AES-GCM (96 bits).
 */
export const GCM_IV_LENGTH_BYTES = 12;

/**
 * Standard authentication tag length in bytes for AES-GCM (128 bits).
 */
export const GCM_TAG_LENGTH_BYTES = 16;

/**
 * Minimum valid encrypted chunk length in bytes (12 bytes IV + 16 bytes auth tag).
 */
export const MIN_CHUNK_LENGTH_BYTES = GCM_IV_LENGTH_BYTES + GCM_TAG_LENGTH_BYTES;

/**
 * Encrypts a binary payload or text message chunk using AES-256-GCM via Web Crypto API.
 *
 * Each call generates a fresh, cryptographically secure 96-bit (12-byte) initialization vector (IV)
 * using crypto.getRandomValues(). The IV is prepended directly to the output ciphertext, followed
 * by the encrypted data and the 128-bit authentication tag.
 *
 * Framing layout:
 * [ 12-byte IV ] [ Ciphertext payload ... ] [ 16-byte Authentication Tag ]
 *
 * @param key - AES-GCM CryptoKey (K0 or K1 after rekey).
 * @param plaintext - Plaintext data as Uint8Array, ArrayBuffer, or UTF-8 string.
 * @returns Promise resolving to a Uint8Array containing the framed IV + ciphertext + auth tag.
 */
export async function encryptChunk(
	key: CryptoKey,
	plaintext: Uint8Array | ArrayBuffer | string
): Promise<Uint8Array> {
	let dataBytes: Uint8Array;
	if (typeof plaintext === 'string') {
		dataBytes = new TextEncoder().encode(plaintext);
	} else if (plaintext instanceof Uint8Array) {
		dataBytes = plaintext;
	} else if (plaintext instanceof ArrayBuffer) {
		dataBytes = new Uint8Array(plaintext);
	} else {
		throw new TypeError('Plaintext must be a string, Uint8Array, or ArrayBuffer');
	}

	// Generate a unique 96-bit random IV for this chunk
	const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));

	const encryptedBuffer = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: iv as unknown as BufferSource,
			tagLength: 128
		},
		key,
		dataBytes as unknown as BufferSource
	);

	// Pack 12-byte IV + ciphertext (which includes 16-byte GCM tag) into a single Uint8Array
	const packet = new Uint8Array(GCM_IV_LENGTH_BYTES + encryptedBuffer.byteLength);
	packet.set(iv, 0);
	packet.set(new Uint8Array(encryptedBuffer), GCM_IV_LENGTH_BYTES);

	return packet;
}

/**
 * Decrypts and authenticates a chunk produced by encryptChunk using AES-256-GCM.
 *
 * Extracts the 12-byte IV from the front of the packet and authenticates the remaining
 * ciphertext against the 128-bit GCM tag. If the key is invalid, the ciphertext is truncated,
 * or any byte was tampered with in transit, the method throws DecryptionError.
 *
 * @param key - AES-GCM CryptoKey matching the key used during encryption.
 * @param ciphertext - Encrypted chunk packet (Uint8Array or ArrayBuffer).
 * @returns Promise resolving to the original plaintext Uint8Array.
 * @throws {DecryptionError} When authentication fails, payload is corrupted, or key is wrong.
 */
export async function decryptChunk(
	key: CryptoKey,
	ciphertext: Uint8Array | ArrayBuffer
): Promise<Uint8Array> {
	let packetBytes: Uint8Array;
	if (ciphertext instanceof Uint8Array) {
		packetBytes = ciphertext;
	} else if (ciphertext instanceof ArrayBuffer) {
		packetBytes = new Uint8Array(ciphertext);
	} else {
		throw new TypeError('Ciphertext must be a Uint8Array or ArrayBuffer');
	}

	if (packetBytes.byteLength < MIN_CHUNK_LENGTH_BYTES) {
		throw new DecryptionError(
			`Ciphertext chunk too short: minimum ${MIN_CHUNK_LENGTH_BYTES} bytes required (received ${packetBytes.byteLength})`
		);
	}

	const iv = packetBytes.subarray(0, GCM_IV_LENGTH_BYTES);
	const encryptedPayload = packetBytes.subarray(GCM_IV_LENGTH_BYTES);

	try {
		const decryptedBuffer = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: iv as unknown as BufferSource,
				tagLength: 128
			},
			key,
			encryptedPayload as unknown as BufferSource
		);

		return new Uint8Array(decryptedBuffer);
	} catch (err) {
		throw new DecryptionError('Failed to decrypt chunk: authentication verification failed or invalid key');
	}
}
