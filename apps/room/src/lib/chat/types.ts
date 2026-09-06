/**
 * Discriminated union representing an ordered message segment within a chat message.
 */
export type MessageSegment =
	| { type: 'text'; text: string }
	| { type: 'code'; code: string; language: string | null };

/**
 * In-memory representation of a chat message within the client room session.
 */
export interface ChatMessage {
	/** Unique message identifier (UUID v4) */
	id: string;
	/** Cosmetic nickname of the sender (e.g., "swift-fox-42") */
	sender: string;
	/** Ordered list of text prose and code segments */
	segments: MessageSegment[];
	/** Unix timestamp in milliseconds when the message was dispatched */
	timestamp: number;
	/** True if the message originated from the local client session */
	isSelf: boolean;
	/** True if the message is a system notification/announcement */
	isSystem?: boolean;
	/** Remote WebRTC peer identifier if received from a remote participant */
	senderPeerId?: string;
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
	/** Ordered list of text prose and code segments */
	segments: MessageSegment[];
	/** Dispatch timestamp */
	timestamp: number;
}
