/**
 * Strict regular expression matching the 12-digit room code format: 0000-0000-0000.
 */
export const ROOM_CODE_REGEX = /^\d{4}-\d{4}-\d{4}$/;

/**
 * Validates whether the given string strictly conforms to the room code format (0000-0000-0000).
 */
export function validateRoomCode(code: string): boolean {
	if (!code || typeof code !== 'string') {
		return false;
	}
	return ROOM_CODE_REGEX.test(code.trim());
}

/**
 * Normalizes a room code by trimming extraneous surrounding whitespace.
 */
export function normalizeRoomCode(code: string): string {
	return (code || '').trim();
}

/**
 * Formats user input progressively into the 0000-0000-0000 room code structure.
 * Strips non-digit characters and inserts hyphens at positions 4 and 8.
 */
export function formatRoomCodeInput(raw: string): string {
	if (!raw) return '';
	const digits = raw.replace(/\D/g, '').slice(0, 12);
	const parts: string[] = [];

	if (digits.length > 0) {
		parts.push(digits.slice(0, 4));
	}
	if (digits.length > 4) {
		parts.push(digits.slice(4, 8));
	}
	if (digits.length > 8) {
		parts.push(digits.slice(8, 12));
	}

	return parts.join('-');
}
