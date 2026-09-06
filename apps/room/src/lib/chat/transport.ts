import type { ChatWirePayload, MessageSegment } from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Maximum permissible number of segments within a single inbound chat message frame.
 * Prevents resource exhaustion from pathological segment proliferation.
 */
export const MAX_SEGMENTS_PER_MESSAGE = 50;

/**
 * Maximum permissible character length of a single segment text/code body (100KB).
 */
export const MAX_SEGMENT_LENGTH = 100_000;

/**
 * Serializes a structured chat wire payload into raw UTF-8 binary bytes
 * ready for AES-256-GCM chunk encryption and WebRTC RTCDataChannel transmission.
 *
 * @param payload - Structured chat wire frame.
 * @returns Serialized Uint8Array bytes.
 */
export function serializeChatMessage(payload: ChatWirePayload): Uint8Array {
	const sanitizedSegments: MessageSegment[] = payload.segments.map((seg) => {
		if (seg.type === 'code') {
			return {
				type: 'code',
				code: seg.code,
				language:
					typeof seg.language === 'string' && seg.language.trim().length > 0
						? seg.language.trim().toLowerCase()
						: null
			};
		}
		return {
			type: 'text',
			text: seg.text
		};
	});

	const wire: ChatWirePayload = {
		type: 'chat',
		id: payload.id,
		sender: payload.sender,
		timestamp: payload.timestamp,
		segments: sanitizedSegments
	};

	const jsonString = JSON.stringify(wire);
	return encoder.encode(jsonString);
}

/**
 * Deserializes and validates raw decrypted binary bytes into a typed ChatWirePayload.
 * Returns null if the byte buffer is corrupted, fails JSON parsing, violates size bounds,
 * or does not adhere to the chat wire segment schema.
 *
 * @param bytes - Decrypted plaintext Uint8Array received over RTCDataChannel.
 * @returns Validated ChatWirePayload or null.
 */
export function deserializeChatMessage(bytes: Uint8Array): ChatWirePayload | null {
	try {
		const jsonString = decoder.decode(bytes);
		const data = JSON.parse(jsonString);

		if (
			typeof data !== 'object' ||
			data === null ||
			data.type !== 'chat' ||
			typeof data.id !== 'string' ||
			data.id.length === 0 ||
			typeof data.sender !== 'string' ||
			typeof data.timestamp !== 'number' ||
			!Array.isArray(data.segments) ||
			data.segments.length === 0 ||
			data.segments.length > MAX_SEGMENTS_PER_MESSAGE
		) {
			return null;
		}

		const validatedSegments: MessageSegment[] = [];

		for (const seg of data.segments) {
			if (typeof seg !== 'object' || seg === null) {
				return null;
			}

			if (seg.type === 'text') {
				if (typeof seg.text !== 'string' || seg.text.length > MAX_SEGMENT_LENGTH) {
					return null;
				}
				validatedSegments.push({
					type: 'text',
					text: seg.text
				});
			} else if (seg.type === 'code') {
				if (typeof seg.code !== 'string' || seg.code.length > MAX_SEGMENT_LENGTH) {
					return null;
				}
				const sanitizedLanguage =
					typeof seg.language === 'string' &&
					/^[a-zA-Z0-9_#+-]+$/.test(seg.language.trim())
						? seg.language.trim().toLowerCase()
						: null;

				validatedSegments.push({
					type: 'code',
					code: seg.code,
					language: sanitizedLanguage
				});
			} else {
				return null;
			}
		}

		return {
			type: 'chat',
			id: data.id,
			sender: data.sender,
			timestamp: data.timestamp,
			segments: validatedSegments
		};
	} catch {
		return null;
	}
}
