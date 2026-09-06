import { ROOM_CODE_REGEX, validateRoomCode } from './roomCode.ts';

/**
 * Feistel cipher round keys derived from standard cryptographic constants (fractional parts of primes).
 */
const FEISTEL_ROUND_KEYS = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
	0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174
];

/**
 * Maximum numerical value for 12 decimal digits (999,999,999,999).
 * Fits securely within 40 bits (< 2^40 = 1,099,511,627,776).
 */
const MAX_ROOM_INT = 999_999_999_999n;

/**
 * Strict regex pattern for a 16-character hexadecimal room token.
 */
export const ROOM_TOKEN_REGEX = /^[0-9a-fA-F]{16}$/;

/**
 * Evaluates nonlinear round mixing for the balanced Feistel network.
 */
function feistelRound(r: number, key: number): number {
	let x = (r ^ key) >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Computes a 24-bit authentication and integrity checksum for the room integer.
 */
function computeIntegrityTag(val: bigint): number {
	let h = 0x811c9dc5;
	const b0 = Number(val & 0xffn);
	const b1 = Number((val >> 8n) & 0xffn);
	const b2 = Number((val >> 16n) & 0xffn);
	const b3 = Number((val >> 24n) & 0xffn);
	const b4 = Number((val >> 32n) & 0xffn);

	for (const b of [b0, b1, b2, b3, b4, 0xa5, 0x5a]) {
		h ^= b;
		h = Math.imul(h, 0x01000193);
		h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
		h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	}

	return (h ^ (h >>> 16)) & 0xffffff;
}

/**
 * Checks whether a given string is a valid format for an encrypted room token (16 hex characters).
 */
export function isRoomToken(token: string): boolean {
	if (!token || typeof token !== 'string') {
		return false;
	}
	return ROOM_TOKEN_REGEX.test(token.trim());
}

/**
 * Encrypts a 12-digit canonical room code (0000-0000-0000) into an opaque 16-hexadecimal token.
 * Uses a 16-round balanced Feistel cipher with a 24-bit integrity tag.
 *
 * @param code - Valid room code formatted as 0000-0000-0000.
 * @returns 16-character lowercase hexadecimal token.
 * @throws {Error} When room code format is invalid.
 */
export function encodeRoomToken(code: string): string {
	if (!validateRoomCode(code)) {
		throw new Error(`Cannot encode invalid room code: ${code}`);
	}

	const digits = code.replace(/\D/g, '');
	const val = BigInt(digits);
	const tag = computeIntegrityTag(val);

	// Pack 40-bit value and 24-bit integrity tag into a 64-bit integer
	const block = (val << 24n) | BigInt(tag);

	let l = Number((block >> 32n) & 0xffffffffn) >>> 0;
	let r = Number(block & 0xffffffffn) >>> 0;

	// 16-round Feistel permutation
	for (let i = 0; i < 16; i++) {
		const nextL = r;
		const nextR = (l ^ feistelRound(r, FEISTEL_ROUND_KEYS[i])) >>> 0;
		l = nextL;
		r = nextR;
	}

	const cipherBlock = (BigInt(l) << 32n) | BigInt(r);
	return cipherBlock.toString(16).padStart(16, '0');
}

/**
 * Decrypts a 16-hexadecimal room token back into its canonical 12-digit room code (0000-0000-0000).
 * Validates the 24-bit integrity tag to ensure token authenticity and tamper resistance.
 *
 * @param token - 16-character hexadecimal token string.
 * @returns Canonical room code (0000-0000-0000) or null if token is corrupted or invalid.
 */
export function decodeRoomToken(token: string): string | null {
	if (!isRoomToken(token)) {
		return null;
	}

	try {
		const cleanHex = token.trim().toLowerCase();
		const cipherBlock = BigInt(`0x${cleanHex}`);

		let l = Number((cipherBlock >> 32n) & 0xffffffffn) >>> 0;
		let r = Number(cipherBlock & 0xffffffffn) >>> 0;

		// 16-round inverse Feistel permutation
		for (let i = 15; i >= 0; i--) {
			const prevR = l;
			const prevL = (r ^ feistelRound(l, FEISTEL_ROUND_KEYS[i])) >>> 0;
			l = prevL;
			r = prevR;
		}

		const block = (BigInt(l) << 32n) | BigInt(r);
		const val = block >> 24n;
		const tag = Number(block & 0xffffffn);

		if (val < 0n || val > MAX_ROOM_INT) {
			return null;
		}

		if (computeIntegrityTag(val) !== tag) {
			return null;
		}

		const digits = val.toString().padStart(12, '0');
		return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
	} catch {
		return null;
	}
}

/**
 * Resolves an arbitrary user input string (raw room code, encrypted token, or full room URL)
 * into a canonical room code and its corresponding encrypted token.
 *
 * @param input - Raw user input or route param.
 * @returns Object with canonical code and encrypted token, or null if input cannot be resolved.
 */
export function resolveRoomIdentifier(input: string): { code: string; token: string } | null {
	if (!input || typeof input !== 'string') {
		return null;
	}

	let trimmed = input.trim();

	// Extract token or code if user pasted a full URL
	const urlMatch = trimmed.match(/\/room\/([a-zA-Z0-9_-]+)/);
	if (urlMatch) {
		trimmed = urlMatch[1];
	}

	// Case 1: Input is already an encrypted token (16 hex characters)
	if (isRoomToken(trimmed)) {
		const decoded = decodeRoomToken(trimmed);
		if (decoded) {
			return { code: decoded, token: trimmed.toLowerCase() };
		}
		return null;
	}

	// Case 2: Input is a canonical 12-digit room code (0000-0000-0000)
	if (validateRoomCode(trimmed)) {
		return { code: trimmed, token: encodeRoomToken(trimmed) };
	}

	// Case 3: Input is 12 consecutive unformatted digits
	const digitsOnly = trimmed.replace(/\D/g, '');
	if (digitsOnly.length === 12) {
		const formatted = `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 8)}-${digitsOnly.slice(8, 12)}`;
		if (validateRoomCode(formatted)) {
			return { code: formatted, token: encodeRoomToken(formatted) };
		}
	}

	return null;
}
