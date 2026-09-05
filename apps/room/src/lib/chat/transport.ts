import type { ChatWirePayload } from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serializes a structured chat wire payload into raw UTF-8 binary bytes
 * ready for AES-256-GCM chunk encryption and WebRTC RTCDataChannel transmission.
 *
 * @param payload - Structured chat wire frame.
 * @returns Serialized Uint8Array bytes.
 */
export function serializeChatMessage(payload: ChatWirePayload): Uint8Array {
	const jsonString = JSON.stringify(payload);
	return encoder.encode(jsonString);
}

/**
 * Deserializes and validates raw decrypted binary bytes into a typed ChatWirePayload.
 * Returns null if the byte buffer is corrupted, fails JSON parsing, or does not adhere
 * to the chat wire schema.
 *
 * @param bytes - Decrypted plaintext Uint8Array received over RTCDataChannel.
 * @returns Validated ChatWirePayload or null.
 */
export function deserializeChatMessage(bytes: Uint8Array): ChatWirePayload | null {
	try {
		const jsonString = decoder.decode(bytes);
		const data = JSON.parse(jsonString);

		if (
			typeof data === 'object' &&
			data !== null &&
			data.type === 'chat' &&
			typeof data.id === 'string' &&
			data.id.length > 0 &&
			typeof data.sender === 'string' &&
			typeof data.content === 'string' &&
			typeof data.timestamp === 'number'
		) {
			return {
				type: 'chat',
				id: data.id,
				sender: data.sender,
				content: data.content,
				timestamp: data.timestamp
			};
		}

		return null;
	} catch {
		return null;
	}
}
