import type {
	ChatWirePayload,
	MessageSegment,
	ChatHistoryItem,
	ChatHistorySyncWirePayload,
	ChatMessage
} from './types.ts';
import { CHAT_HISTORY_SYNC_TYPE } from './types.ts';

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

/**
 * Maximum permissible number of chat messages contained in a single history synchronization frame.
 * Prevents memory exhaustion attacks from untrusted peer mesh members.
 */
export const MAX_HISTORY_SYNC_MESSAGES = 1000;

/**
 * Serializes an array of chat messages into a binary CHAT_HISTORY_SYNC wire payload
 * ready for AES-256-GCM chunk encryption and WebRTC RTCDataChannel transmission.
 *
 * @param messages - Array of chat messages or history items to serialize.
 * @returns Serialized Uint8Array bytes.
 */
export function serializeChatHistorySync(
	messages: (ChatMessage | ChatHistoryItem)[]
): Uint8Array {
	const sanitizedMessages: ChatHistoryItem[] = messages
		.slice(0, MAX_HISTORY_SYNC_MESSAGES)
		.map((msg) => ({
			id: msg.id,
			sender: msg.sender,
			timestamp: msg.timestamp,
			isSystem: Boolean(msg.isSystem),
			segments: msg.segments.map((seg) => {
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
			})
		}));

	const wire: ChatHistorySyncWirePayload = {
		type: CHAT_HISTORY_SYNC_TYPE,
		messages: sanitizedMessages
	};

	const jsonString = JSON.stringify(wire);
	return encoder.encode(jsonString);
}

/**
 * Deserializes and defensively validates raw decrypted binary bytes into a typed ChatHistorySyncWirePayload.
 * Returns null if the byte buffer is corrupted, fails JSON parsing, violates size bounds,
 * or does not conform to the chat history wire schema.
 *
 * @param bytes - Decrypted plaintext Uint8Array received over RTCDataChannel.
 * @returns Validated ChatHistorySyncWirePayload or null.
 */
export function deserializeChatHistorySync(
	bytes: Uint8Array
): ChatHistorySyncWirePayload | null {
	try {
		const jsonString = decoder.decode(bytes);
		const data = JSON.parse(jsonString);

		if (
			typeof data !== 'object' ||
			data === null ||
			(data.type !== CHAT_HISTORY_SYNC_TYPE && data.type !== 'chat_history_sync') ||
			!Array.isArray(data.messages) ||
			data.messages.length > MAX_HISTORY_SYNC_MESSAGES
		) {
			return null;
		}

		const validatedMessages: ChatHistoryItem[] = [];

		for (const item of data.messages) {
			if (
				typeof item !== 'object' ||
				item === null ||
				typeof item.id !== 'string' ||
				item.id.length === 0 ||
				typeof item.sender !== 'string' ||
				typeof item.timestamp !== 'number' ||
				!Array.isArray(item.segments) ||
				item.segments.length === 0 ||
				item.segments.length > MAX_SEGMENTS_PER_MESSAGE
			) {
				continue;
			}

			const validatedSegments: MessageSegment[] = [];
			let segmentsValid = true;

			for (const seg of item.segments) {
				if (typeof seg !== 'object' || seg === null) {
					segmentsValid = false;
					break;
				}

				if (seg.type === 'text') {
					if (typeof seg.text !== 'string' || seg.text.length > MAX_SEGMENT_LENGTH) {
						segmentsValid = false;
						break;
					}
					validatedSegments.push({
						type: 'text',
						text: seg.text
					});
				} else if (seg.type === 'code') {
					if (typeof seg.code !== 'string' || seg.code.length > MAX_SEGMENT_LENGTH) {
						segmentsValid = false;
						break;
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
					segmentsValid = false;
					break;
				}
			}

			if (segmentsValid && validatedSegments.length > 0) {
				validatedMessages.push({
					id: item.id,
					sender: item.sender,
					timestamp: item.timestamp,
					segments: validatedSegments,
					...(item.isSystem ? { isSystem: true } : {})
				});
			}
		}

		return {
			type: CHAT_HISTORY_SYNC_TYPE,
			messages: validatedMessages
		};
	} catch {
		return null;
	}
}

