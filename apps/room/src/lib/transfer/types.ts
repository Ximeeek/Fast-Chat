/**
 * Wire framing schema for initiating a peer-to-peer file transfer.
 */
export interface FileMetaWirePayload {
	type: 'file-meta';
	transferId: string;
	fileName: string;
	fileSize: number;
	fileType: string;
	chunkSize: number;
	totalChunks: number;
	sender: string;
	senderPeerId: string;
	timestamp: number;
}

/**
 * Wire payload signaled by a recipient indicating readiness to accept chunk streaming.
 */
export interface FileReadyWirePayload {
	type: 'file-ready';
	transferId: string;
	peerId: string;
}

/**
 * Wire payload dispatched when a transfer is aborted by sender or receiver.
 */
export interface FileCancelWirePayload {
	type: 'file-cancel';
	transferId: string;
	peerId?: string;
	reason?: string;
}

/**
 * Wire payload confirming full completion of a file transfer session.
 */
export interface FileCompleteWirePayload {
	type: 'file-complete';
	transferId: string;
	peerId?: string;
}

/**
 * Union of all JSON control payloads exchanged during file transfer negotiations.
 */
export type FileControlWirePayload =
	| FileMetaWirePayload
	| FileReadyWirePayload
	| FileCancelWirePayload
	| FileCompleteWirePayload;

/**
 * Parsed binary file chunk extracted from an encrypted WebRTC data frame.
 */
export interface ParsedFileChunk {
	transferId: string;
	chunkIndex: number;
	totalChunks: number;
	data: Uint8Array;
}

/**
 * Lifecycle status of an individual file transfer stream.
 */
export type TransferStatus =
	| 'queued'
	| 'offered'
	| 'preparing'
	| 'sending'
	| 'receiving'
	| 'completed'
	| 'cancelled'
	| 'failed';

/**
 * Storage mechanism utilized for an incoming file transfer.
 * - filesystem: direct streaming disk write via Chromium File System Access API.
 * - blob: in-memory aggregation fallback for Firefox / Safari.
 */
export type StorageMode = 'filesystem' | 'blob';

/**
 * Per-recipient progress tracking representation for mesh file distribution.
 */
export interface RecipientProgress {
	peerId: string;
	username?: string;
	bytesSent: number;
	totalBytes: number;
	chunksSent: number;
	totalChunks: number;
	percentage: number;
	status: TransferStatus;
	error?: string;
}

/**
 * State of an active outbound file transfer from the local participant.
 */
export interface OutgoingTransfer {
	transferId: string;
	file: File | Blob;
	fileName: string;
	fileSize: number;
	fileType: string;
	totalChunks: number;
	recipients: Map<string, RecipientProgress>;
	status: TransferStatus;
	createdAt: number;
}

/**
 * State of an incoming file transfer being received from a remote peer.
 */
export interface IncomingTransfer {
	transferId: string;
	fileName: string;
	fileSize: number;
	fileType: string;
	totalChunks: number;
	receivedChunks: number;
	bytesReceived: number;
	sender: string;
	senderPeerId: string;
	status: TransferStatus;
	storageMode: StorageMode;
	ramWarning: boolean;
	ramLimitExceeded?: boolean;
	blob?: Blob;
	downloadUrl?: string;
	error?: string;
	startedAt: number;
	completedAt?: number;
}

/**
 * Record of a completed received file available for download or ZIP bundling.
 */
export interface CompletedFileRecord {
	transferId: string;
	fileName: string;
	fileSize: number;
	fileType: string;
	storageMode: StorageMode;
	blob?: Blob;
	downloadUrl?: string;
	completedAt: number;
}
