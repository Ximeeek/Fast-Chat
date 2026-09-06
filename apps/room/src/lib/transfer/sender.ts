import type { WebRtcManager } from '../webrtc/manager.ts';
import { roomStore } from '../stores/room.ts';
import {
	CHUNK_SIZE,
	calculateTotalChunks,
	sliceFile,
	createFileChunkPacket
} from './chunking.ts';
import type {
	OutgoingTransfer,
	RecipientProgress,
	FileMetaWirePayload,
	FileCompleteWirePayload,
	FileCancelWirePayload,
	FileControlWirePayload,
	SentFileRecord
} from './types.ts';

export type TransferProgressCallback = (
	transferId: string,
	peerId: string,
	progress: RecipientProgress
) => void;

export interface FileSenderOptions {
	chunkSize?: number;
	highWaterMark?: number;
	onProgress?: TransferProgressCallback;
	onCompleted?: (transferId: string) => void;
	onError?: (transferId: string, peerId: string, error: Error) => void;
	/**
	 * Custom room store instance for inspecting fileBlockedPeers or testing.
	 * Defaults to the global roomStore singleton.
	 */
	roomStore?: typeof roomStore;
	/**
	 * Optional predicate returning true if file visibility is blocked for the given peer ID.
	 */
	isFileBlocked?: (peerId: string) => boolean;
}

/**
 * Orchestrates outbound file streaming across WebRTC mesh peer connections.
 * Slices source files into 16KB binary frames, throttles via RTCDataChannel backpressure,
 * and maintains independent per-recipient transfer progress.
 */
export class FileSender {
	private webRtcManager: WebRtcManager;
	private chunkSize: number;
	private highWaterMark: number;
	private roomStore: typeof roomStore;
	private isFileBlocked?: (peerId: string) => boolean;
	private activeTransfers: Map<string, OutgoingTransfer> = new Map();
	private sentFileLog: Map<string, SentFileRecord> = new Map();
	private peerStreamPromises: Map<string, Promise<void>> = new Map();
	private progressCallbacks: Set<TransferProgressCallback> = new Set();

	constructor(webRtcManager: WebRtcManager, options: FileSenderOptions = {}) {
		this.webRtcManager = webRtcManager;
		this.chunkSize = options.chunkSize || CHUNK_SIZE;
		this.highWaterMark = options.highWaterMark || 256 * 1024;
		this.roomStore = options.roomStore || roomStore;
		this.isFileBlocked = options.isFileBlocked;

		if (options.onProgress) {
			this.progressCallbacks.add(options.onProgress);
		}
	}

	private checkIsFileBlocked(peerId: string): boolean {
		if (this.isFileBlocked) {
			return this.isFileBlocked(peerId);
		}
		if (this.roomStore) {
			let blocked = false;
			const unsub = this.roomStore.subscribe((state) => {
				blocked = state.fileBlockedPeers.includes(peerId);
			});
			unsub();
			return blocked;
		}
		return false;
	}

	/**
	 * Subscribes to transfer progress updates per recipient.
	 */
	public onProgress(callback: TransferProgressCallback): () => void {
		this.progressCallbacks.add(callback);
		return () => {
			this.progressCallbacks.delete(callback);
		};
	}

	/**
	 * Retrieves an active outgoing transfer by ID.
	 */
	public getTransfer(transferId: string): OutgoingTransfer | undefined {
		return this.activeTransfers.get(transferId);
	}

	/**
	 * Returns all currently tracked outgoing transfers.
	 */
	public getAllTransfers(): OutgoingTransfer[] {
		return Array.from(this.activeTransfers.values());
	}

	/**
	 * Initiates a new outbound file transfer to target peers (or all currently open peers).
	 * Emits file-meta announcements and waits for file-ready handshakes from recipients.
	 */
	public async sendFile(
		file: File | Blob,
		options: {
			fileName?: string;
			fileType?: string;
			targetPeers?: string[];
			senderUsername?: string;
			transferId?: string;
		} = {}
	): Promise<OutgoingTransfer> {
		const transferId =
			options.transferId ||
			(typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `transfer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

		const fileName = options.fileName || (file instanceof File ? file.name : 'unnamed-file');
		const fileType = options.fileType || file.type || 'application/octet-stream';
		const totalChunks = calculateTotalChunks(file.size, this.chunkSize);

		// Resolve destination peers
		let targetPeers = options.targetPeers;
		if (!targetPeers || targetPeers.length === 0) {
			// Query open peer sessions from WebRtcManager, filtering out file-blocked peers
			targetPeers = [];
			const activeStorePeers = this.webRtcManager as any;
			if (activeStorePeers && activeStorePeers.sessions) {
				for (const [peerId, session] of activeStorePeers.sessions.entries()) {
					if (session.getSessionInfo().dataChannelState === 'open') {
						if (!this.checkIsFileBlocked(peerId)) {
							targetPeers.push(peerId);
						}
					}
				}
			}
		} else {
			targetPeers = targetPeers.filter((peerId) => !this.checkIsFileBlocked(peerId));
		}

		if (targetPeers.length === 0) {
			throw new Error('No open WebRTC peer connections available for file transfer');
		}

		const recipients = new Map<string, RecipientProgress>();
		for (const peerId of targetPeers) {
			recipients.set(peerId, {
				peerId,
				bytesSent: 0,
				totalBytes: file.size,
				chunksSent: 0,
				totalChunks,
				percentage: 0,
				status: 'offered'
			});
		}

		const transfer: OutgoingTransfer = {
			transferId,
			file,
			fileName,
			fileSize: file.size,
			fileType,
			totalChunks,
			recipients,
			status: 'offered',
			createdAt: Date.now()
		};

		this.activeTransfers.set(transferId, transfer);

		// Record reference and metadata in session RAM log
		const localPeerId =
			(this.webRtcManager as any).localPeerId ||
			(this.webRtcManager as any).peerId ||
			'';
		const sentRecord: SentFileRecord = {
			fileId: transferId,
			file,
			fileName,
			fileSize: file.size,
			fileType,
			senderPeerId: localPeerId,
			senderUsername: options.senderUsername || 'anonymous',
			timestamp: Date.now(),
			targetPeers: [...targetPeers]
		};
		this.sentFileLog.set(transferId, sentRecord);

		// Broadcast file-meta announcement to all target peers
		const metaPayload: FileMetaWirePayload = {
			type: 'file-meta',
			transferId,
			fileName,
			fileSize: file.size,
			fileType,
			chunkSize: this.chunkSize,
			totalChunks,
			sender: options.senderUsername || 'anonymous',
			senderPeerId: (this.webRtcManager as any).localPeerId || '',
			timestamp: Date.now()
		};

		const metaString = JSON.stringify(metaPayload);

		for (const peerId of targetPeers) {
			try {
				await this.webRtcManager.send(peerId, metaString);
			} catch (err) {
				const rec = recipients.get(peerId);
				if (rec) {
					rec.status = 'failed';
					rec.error = err instanceof Error ? err.message : String(err);
					this.notifyProgress(transferId, peerId, rec);
				}
			}
		}

		return transfer;
	}

	/**
	 * Handles incoming wire control messages related to file transfer (e.g. file-ready, file-cancel).
	 */
	public async handleControlMessage(
		peerId: string,
		payload: FileControlWirePayload
	): Promise<void> {
		if (payload.type === 'file-ready') {
			await this.startStreamToPeer(payload.transferId, peerId);
		} else if (payload.type === 'file-cancel') {
			this.cancelTransfer(payload.transferId, peerId, payload.reason || 'Cancelled by remote peer');
		}
	}

	/**
	 * Streams chunks directly to a specific peer after receiving file-ready readiness confirmation.
	 */
	public async startStreamToPeer(transferId: string, peerId: string): Promise<void> {
		if (this.checkIsFileBlocked(peerId)) {
			return;
		}

		const transfer = this.activeTransfers.get(transferId);
		if (!transfer) return;

		const recipient = transfer.recipients.get(peerId);
		if (!recipient || recipient.status === 'sending' || recipient.status === 'completed') {
			return;
		}

		recipient.status = 'sending';
		transfer.status = 'sending';
		this.notifyProgress(transferId, peerId, recipient);

		const streamKey = `${transferId}:${peerId}`;
		const streamPromise = (async () => {
			try {
				const session = this.webRtcManager.getSession(peerId);
				const totalChunks = transfer.totalChunks;

				for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
					// Check for cancellation
					if (recipient.status === 'cancelled') {
						break;
					}

					// Backpressure: throttle outbound queue if RTCDataChannel buffer is saturated
					if (session) {
						await session.waitForBufferedAmountLow(this.highWaterMark);
					}

					// Read 16KB binary slice from source without holding entire file in RAM
					const chunkBytes = await sliceFile(transfer.file, chunkIndex, this.chunkSize);

					// Form binary chunk packet
					const packet = createFileChunkPacket(
						transferId,
						chunkIndex,
						totalChunks,
						chunkBytes
					);

					// Transmit encrypted packet across RTCDataChannel
					await this.webRtcManager.send(peerId, packet);

					// Update per-recipient metrics
					recipient.chunksSent = chunkIndex + 1;
					recipient.bytesSent += chunkBytes.byteLength;
					recipient.percentage = Math.min(
						100,
						Math.round((recipient.bytesSent / transfer.fileSize) * 100)
					);

					this.notifyProgress(transferId, peerId, recipient);
				}

				if (recipient.status !== 'cancelled') {
					recipient.status = 'completed';
					recipient.percentage = 100;
					this.notifyProgress(transferId, peerId, recipient);

					// Send file-complete confirmation to recipient
					const completePayload: FileCompleteWirePayload = {
						type: 'file-complete',
						transferId,
						peerId
					};
					await this.webRtcManager.send(peerId, JSON.stringify(completePayload)).catch(() => {});
				}

				// If all recipients completed, mark transfer as completed
				const allDone = Array.from(transfer.recipients.values()).every(
					(r) => r.status === 'completed' || r.status === 'cancelled' || r.status === 'failed'
				);
				if (allDone) {
					transfer.status = 'completed';
					this.webRtcManager.reportRelayUsage().catch(() => {});
				}
			} catch (err) {
				recipient.status = 'failed';
				recipient.error = err instanceof Error ? err.message : String(err);
				this.notifyProgress(transferId, peerId, recipient);
			} finally {
				this.peerStreamPromises.delete(streamKey);
			}
		})();

		this.peerStreamPromises.set(streamKey, streamPromise);
		return streamPromise;
	}

	/**
	 * Aborts a file transfer for a specific peer or for all recipients.
	 */
	public cancelTransfer(transferId: string, peerId?: string, reason?: string): void {
		const transfer = this.activeTransfers.get(transferId);
		if (!transfer) return;

		const cancelRecipient = (pid: string) => {
			const rec = transfer.recipients.get(pid);
			if (rec && rec.status !== 'completed' && rec.status !== 'failed') {
				rec.status = 'cancelled';
				rec.error = reason || 'Transfer cancelled';
				this.notifyProgress(transferId, pid, rec);

				const cancelPayload: FileCancelWirePayload = {
					type: 'file-cancel',
					transferId,
					peerId: pid,
					reason
				};
				this.webRtcManager.send(pid, JSON.stringify(cancelPayload)).catch(() => {});
			}
		};

		if (peerId) {
			cancelRecipient(peerId);
		} else {
			transfer.status = 'cancelled';
			for (const pid of transfer.recipients.keys()) {
				cancelRecipient(pid);
			}
		}
	}

	/**
	 * Cleans up completed or cancelled transfer records from memory.
	 */
	public removeTransfer(transferId: string): void {
		this.activeTransfers.delete(transferId);
	}

	/**
	 * Retrieves a sent file record from the session RAM log by file ID.
	 */
	public getSentFile(fileId: string): SentFileRecord | undefined {
		return this.sentFileLog.get(fileId);
	}

	/**
	 * Returns all sent file records currently stored in the session RAM log.
	 */
	public getAllSentFiles(): SentFileRecord[] {
		return Array.from(this.sentFileLog.values());
	}

	/**
	 * Explicitly registers a file record into the session RAM log.
	 */
	public recordSentFile(record: SentFileRecord): void {
		this.sentFileLog.set(record.fileId, record);
	}

	/**
	 * Clears all retained file references and metadata from the session RAM log.
	 */
	public clearSentFileLog(): void {
		this.sentFileLog.clear();
	}

	/**
	 * Resets all sender state and releases all file handles from memory.
	 */
	public reset(): void {
		this.activeTransfers.clear();
		this.sentFileLog.clear();
		this.peerStreamPromises.clear();
	}

	private notifyProgress(transferId: string, peerId: string, progress: RecipientProgress): void {
		for (const cb of this.progressCallbacks) {
			try {
				cb(transferId, peerId, progress);
			} catch {
				// Ignore callback errors
			}
		}
	}
}
