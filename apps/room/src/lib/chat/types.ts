/**
 * Content type discriminator categorizing plaintext chat messages versus formatted code blocks.
 */
export type MessageContentType = 'text' | 'code';

/**
 * In-memory representation of a chat message within the client room session.
 */
export interface ChatMessage {
	/** Unique message identifier (UUID v4) */
	id: string;
	/** Cosmetic nickname of the sender (e.g., "swift-fox-42") */
	sender: string;
	/** Decrypted plaintext message body */
	content: string;
	/** Unix timestamp in milliseconds when the message was dispatched */
	timestamp: number;
	/** True if the message originated from the local client session */
	isSelf: boolean;
	/** True if the message is a system notification/announcement */
	isSystem?: boolean;
	/** Remote WebRTC peer identifier if received from a remote participant */
	senderPeerId?: string;
	/** Content classification: standard conversational text or source code */
	contentType?: MessageContentType;
	/** Optional detected or user-specified language identifier (e.g., "javascript", "rust") */
	language?: string | null;
}

/**
 * Structured wire payload schema serialized into binary bytes for WebRTC transmission.
 */
export interface ChatWirePayload {
	/** Message category discriminator to segregate chat from future file transfer frames */
	type: 'chat';
	/** Unique message identifier */
	id: string;
	/** Sender cosmetic username */
	sender: string;
	/** Message text payload */
	content: string;
	/** Dispatch timestamp */
	timestamp: number;
	/** Content classification: standard conversational text or source code */
	contentType?: MessageContentType;
	/** Optional detected or user-specified language identifier */
	language?: string | null;
}
