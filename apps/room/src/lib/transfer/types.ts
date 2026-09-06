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
 * Message category discriminator for WebRTC file transfer log synchronization frames.
 */
export const FILE_LOG_SYNC_TYPE = 'FILE_LOG_SYNC';

/**
 * Metadata entry representing a previously transmitted file in the room session.
 */
export interface FileLogEntry {
	fileId: string;
	fileName: string;
	fileSize: number;
	fileType?: string;
	senderPeerId: string;
	senderUsername?: string;
	timestamp: number;
}

/**
 * Structured wire payload schema for broadcasting the session's file transfer history to newly connected peers.
 */
export interface FileLogSyncWirePayload {
	type: 'FILE_LOG_SYNC' | 'file_log_sync';
	files: FileLogEntry[];
}

/**
 * Message category discriminator for requesting retransmission of a historical file.
 */
export const FILE_REQUEST_TYPE = 'FILE_REQUEST';

/**
 * Wire payload sent directly to an original sender requesting retransmission of a file.
 */
export interface FileRequestWirePayload {
	type: 'FILE_REQUEST' | 'file-request';
	fileId: string;
}

/**
 * Message category discriminator for signaling that a requested file cannot be provided.
 */
export const FILE_UNAVAILABLE_TYPE = 'FILE_UNAVAILABLE';

/**
 * Wire payload indicating that a requested historical file is unavailable.
 */
export interface FileUnavailableWirePayload {
	type: 'FILE_UNAVAILABLE' | 'file-unavailable';
	fileId: string;
	reason?: string;
}

/**
 * Union of all JSON control payloads exchanged during file transfer negotiations.
 */
export type FileControlWirePayload =
	| FileMetaWirePayload
	| FileReadyWirePayload
	| FileCancelWirePayload
	| FileCompleteWirePayload
	| FileRequestWirePayload
	| FileUnavailableWirePayload;

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

/**
 * Status lifecycle of a historical file synchronized across peers.
 */
export type HistoricalTransferStatus =
	| 'available'
	| 'requesting'
	| 'downloading'
	| 'completed'
	| 'unavailable';

/**
 * Client-side representation of a historical file transfer available for on-demand retransmission.
 */
export interface HistoricalFileRecord {
	fileId: string;
	fileName: string;
	fileSize: number;
	fileType?: string;
	senderPeerId: string;
	senderUsername?: string;
	timestamp: number;
	status: HistoricalTransferStatus;
	progress?: number;
	error?: string;
	blob?: Blob;
	downloadUrl?: string;
}

/**
 * Local in-memory session record maintained by the original sender to satisfy on-demand retransmission requests.
 */
export interface SentFileRecord {
	fileId: string;
	file: File | Blob;
	fileName: string;
	fileSize: number;
	fileType: string;
	senderPeerId: string;
	senderUsername?: string;
	timestamp: number;
	targetPeers?: string[];
}

