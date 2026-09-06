import type { WebRtcManager } from '../webrtc/manager.ts';
import type { FileSender } from './sender.ts';
import type { FileReceiver } from './receiver.ts';
import { transferStore } from '../stores/transfer.ts';
import { roomStore } from '../stores/room.ts';
import type {
	FileLogEntry,
	FileLogSyncWirePayload,
	FileRequestWirePayload,
	FileUnavailableWirePayload,
	HistoricalFileRecord,
	SentFileRecord,
	CompletedFileRecord,
	IncomingTransfer
} from './types.ts';
import {
	FILE_LOG_SYNC_TYPE,
	FILE_REQUEST_TYPE,
	FILE_UNAVAILABLE_TYPE
} from './types.ts';

export interface FileTransferSyncManagerOptions {
	fileSender?: FileSender;
	fileReceiver?: FileReceiver;
	store?: typeof transferStore;
	/**
	 * Custom room store instance for inspecting fileBlockedPeers or testing.
	 * Defaults to the global roomStore singleton.
	 */
	roomStore?: typeof roomStore;
	/**
	 * Optional predicate returning true if file visibility is blocked for the given peer ID.
	 */
	isFileBlocked?: (peerId: string) => boolean;
	autoListen?: boolean;
}

/**
 * Coordinates peer-to-peer file transfer log synchronization and on-demand retransmission.
 * Broadcasts sent file metadata upon RTCDataChannel open transitions, satisfies FILE_REQUEST
 * frames from newly joined peers via the Phase 10 chunking pipeline, and surfaces explicit
 * unavailable statuses when senders depart or references are purged.
 */
export class FileTransferSyncManager {
	private webRtcManager: WebRtcManager;
	private fileSender?: FileSender;
	private fileReceiver?: FileReceiver;
	private store: typeof transferStore;
	private roomStore: typeof roomStore;
	private isFileBlocked?: (peerId: string) => boolean;
	private syncedPeers: Set<string> = new Set();
	private pendingRequests: Set<string> = new Set();
	private unsubDataChannelOpen: (() => void) | null = null;
	private unsubMessage: (() => void) | null = null;
	private unsubReceiverProgress: (() => void) | null = null;
	private unsubReceiverCompleted: (() => void) | null = null;

	constructor(
		webRtcManager: WebRtcManager,
		options: FileTransferSyncManagerOptions = {}
	) {
		this.webRtcManager = webRtcManager;
		this.fileSender = options.fileSender;
		this.fileReceiver = options.fileReceiver;
		this.store = options.store || transferStore;
		this.roomStore = options.roomStore || roomStore;
		this.isFileBlocked = options.isFileBlocked;

		// Automatically sync historical file log once when an RTCDataChannel transitions to 'open'
		this.unsubDataChannelOpen = this.webRtcManager.onDataChannelOpen((peerId) => {
			this.syncFileLogToPeer(peerId).catch((err) => {
				console.error(`[FileTransferSyncManager] Failed to sync file log to peer ${peerId}:`, err);
			});
		});

		// Attach progress & completion hooks if fileReceiver is supplied
		if (this.fileReceiver) {
			this.attachReceiverHooks(this.fileReceiver);
		}

		if (options.autoListen) {
			this.unsubMessage = this.webRtcManager.onMessage((peerId, payload) => {
				if (payload.length > 0 && payload[0] === 0x7b) {
					try {
						const jsonStr = new TextDecoder().decode(payload);
						const data = JSON.parse(jsonStr);
						this.handleIncomingControlMessage(peerId, data, payload);
					} catch {
						// Ignore malformed JSON
					}
				}
			});
		}
	}

	/**
	 * Sets or updates the active FileSender instance.
	 */
	public setFileSender(sender: FileSender): void {
		this.fileSender = sender;
	}

	/**
	 * Sets or updates the active FileReceiver instance and binds lifecycle hooks.
	 */
	public setFileReceiver(receiver: FileReceiver): void {
		if (this.unsubReceiverProgress) {
			this.unsubReceiverProgress();
			this.unsubReceiverProgress = null;
		}
		if (this.unsubReceiverCompleted) {
			this.unsubReceiverCompleted();
			this.unsubReceiverCompleted = null;
		}
		this.fileReceiver = receiver;
		this.attachReceiverHooks(receiver);
	}

	private attachReceiverHooks(receiver: FileReceiver): void {
		this.unsubReceiverProgress = receiver.onProgress((transfer: IncomingTransfer) => {
			if (this.pendingRequests.has(transfer.transferId)) {
				const pct = Math.min(
					100,
					Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)
				);
				this.store.updateHistoricalFile(transfer.transferId, {
					status: 'downloading',
					progress: pct
				});
			}
		});

		this.unsubReceiverCompleted = receiver.onCompleted((record: CompletedFileRecord) => {
			if (this.pendingRequests.has(record.transferId)) {
				this.pendingRequests.delete(record.transferId);
				this.store.updateHistoricalFile(record.transferId, {
					status: 'completed',
					progress: 100,
					blob: record.blob,
					downloadUrl: record.downloadUrl
				});
			}
		});
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
	 * Transmits the local client's sent files metadata to a target remote peer.
	 * Idempotent per remote peer connection: sends exactly once upon initial DataChannel open.
	 *
	 * @param peerId - Remote peer identifier.
	 */
	public async syncFileLogToPeer(peerId: string): Promise<boolean> {
		if (this.syncedPeers.has(peerId)) {
			return false;
		}

		if (this.checkIsFileBlocked(peerId)) {
			return false;
		}

		this.syncedPeers.add(peerId);

		const sentFiles: SentFileRecord[] = this.fileSender
			? this.fileSender.getAllSentFiles()
			: [];

		if (sentFiles.length === 0) {
			return false;
		}

		try {
			const metadataEntries: FileLogEntry[] = sentFiles.map((record) => ({
				fileId: record.fileId,
				fileName: record.fileName,
				fileSize: record.fileSize,
				fileType: record.fileType,
				senderPeerId:
					record.senderPeerId ||
					(this.webRtcManager as any).localPeerId ||
					(this.webRtcManager as any).peerId ||
					'',
				senderUsername: record.senderUsername,
				timestamp: record.timestamp
			}));

			const wirePayload: FileLogSyncWirePayload = {
				type: FILE_LOG_SYNC_TYPE,
				files: metadataEntries
			};

			const payloadBytes = new TextEncoder().encode(JSON.stringify(wirePayload));
			await this.webRtcManager.send(peerId, payloadBytes);
			return true;
		} catch (err) {
			console.error(
				`[FileTransferSyncManager] Error transmitting file log sync to peer ${peerId}:`,
				err
			);
			return false;
		}
	}

	/**
	 * Ingests, validates, and registers incoming FILE_LOG_SYNC wire payloads.
	 */
	public handleSyncPayload(peerId: string, payload: Uint8Array | string): boolean {
		let data: any;
		try {
			const str = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
			data = JSON.parse(str);
		} catch {
			return false;
		}

		if (data.type !== FILE_LOG_SYNC_TYPE && data.type !== 'file_log_sync') {
			return false;
		}

		if (!Array.isArray(data.files)) {
			return false;
		}

		const validEntries: FileLogEntry[] = [];
		for (const item of data.files) {
			if (
				item &&
				typeof item.fileId === 'string' &&
				item.fileId.length > 0 &&
				typeof item.fileName === 'string' &&
				typeof item.fileSize === 'number'
			) {
				validEntries.push({
					fileId: item.fileId,
					fileName: item.fileName,
					fileSize: item.fileSize,
					fileType: item.fileType || 'application/octet-stream',
					senderPeerId: item.senderPeerId || peerId,
					senderUsername: item.senderUsername,
					timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now()
				});
			}
		}

		if (validEntries.length > 0) {
			this.store.addHistoricalFiles(validEntries);
		}
		return true;
	}

	/**
	 * Dispatches a FILE_REQUEST directly to the original sender to trigger retransmission.
	 * Immediately flags the record as unavailable if the sender has departed.
	 */
	public async requestFile(fileId: string): Promise<boolean> {
		let targetRecord: HistoricalFileRecord | undefined;
		const unsub = this.store.subscribe((state) => {
			targetRecord = state.historical.find((h) => h.fileId === fileId);
		});
		unsub();

		if (!targetRecord) {
			return false;
		}

		const targetPeerId = targetRecord.senderPeerId;
		const session = this.webRtcManager.getSession(targetPeerId);
		const isOpen = session?.getSessionInfo().dataChannelState === 'open';

		if (!isOpen) {
			this.store.markHistoricalUnavailable(fileId, 'File unavailable: sender left the room');
			return false;
		}

		this.pendingRequests.add(fileId);
		this.store.updateHistoricalFile(fileId, {
			status: 'requesting',
			error: undefined
		});

		const wirePayload: FileRequestWirePayload = {
			type: FILE_REQUEST_TYPE,
			fileId
		};

		try {
			await this.webRtcManager.send(targetPeerId, JSON.stringify(wirePayload));
			return true;
		} catch (err) {
			this.pendingRequests.delete(fileId);
			this.store.markHistoricalUnavailable(
				fileId,
				err instanceof Error ? err.message : 'Failed to send file request'
			);
			return false;
		}
	}

	/**
	 * Handles an incoming FILE_REQUEST from a remote peer.
	 * If the file reference exists, re-triggers the Phase 10 sender pipeline targeted to that peer.
	 * If the reference is gone, transmits an explicit FILE_UNAVAILABLE wire response.
	 */
	public async handleFileRequest(requestingPeerId: string, fileId: string): Promise<void> {
		if (this.checkIsFileBlocked(requestingPeerId)) {
			return;
		}

		const record = this.fileSender?.getSentFile(fileId);
		if (!record) {
			const unavailablePayload: FileUnavailableWirePayload = {
				type: FILE_UNAVAILABLE_TYPE,
				fileId,
				reason: 'File is no longer available from sender'
			};
			await this.webRtcManager
				.send(requestingPeerId, JSON.stringify(unavailablePayload))
				.catch(() => {});
			return;
		}

		try {
			await this.fileSender!.sendFile(record.file, {
				transferId: fileId,
				fileName: record.fileName,
				fileType: record.fileType,
				targetPeers: [requestingPeerId],
				senderUsername: record.senderUsername
			});
		} catch (err) {
			console.error(`[FileTransferSyncManager] Failed to retransmit file ${fileId}:`, err);
		}
	}

	/**
	 * Handles an incoming FILE_UNAVAILABLE wire response.
	 */
	public handleFileUnavailable(senderPeerId: string, fileId: string, reason?: string): void {
		this.pendingRequests.delete(fileId);
		this.store.markHistoricalUnavailable(
			fileId,
			reason || 'File is no longer available from sender'
		);
	}

	/**
	 * Checks if a specific file transfer ID is currently pending retransmission.
	 */
	public isRequestPending(fileId: string): boolean {
		return this.pendingRequests.has(fileId);
	}

	/**
	 * Dispatches an incoming parsed control message to the appropriate handler.
	 */
	public handleIncomingControlMessage(
		peerId: string,
		data: any,
		rawBytes?: Uint8Array
	): boolean {
		if (data.type === FILE_LOG_SYNC_TYPE || data.type === 'file_log_sync') {
			return this.handleSyncPayload(peerId, rawBytes || JSON.stringify(data));
		} else if (data.type === FILE_REQUEST_TYPE || data.type === 'file-request') {
			if (typeof data.fileId === 'string') {
				this.handleFileRequest(peerId, data.fileId).catch((err) => {
					console.error('[FileTransferSyncManager] Error in handleFileRequest:', err);
				});
				return true;
			}
		} else if (data.type === FILE_UNAVAILABLE_TYPE || data.type === 'file-unavailable') {
			if (typeof data.fileId === 'string') {
				this.handleFileUnavailable(peerId, data.fileId, data.reason);
				return true;
			}
		}
		return false;
	}

	/**
	 * Updates historical transfer states when a peer departs from the room.
	 */
	public handlePeerLeft(peerId: string): void {
		this.syncedPeers.delete(peerId);

		let records: HistoricalFileRecord[] = [];
		const unsub = this.store.subscribe((state) => {
			records = state.historical.filter((h) => h.senderPeerId === peerId);
		});
		unsub();

		for (const rec of records) {
			if (rec.status === 'requesting' || rec.status === 'downloading') {
				this.pendingRequests.delete(rec.fileId);
				this.store.markHistoricalUnavailable(
					rec.fileId,
					'File unavailable: sender left the room'
				);
			}
		}
	}

	/**
	 * Removes tracking for a specific peer.
	 */
	public removePeer(peerId: string): void {
		this.syncedPeers.delete(peerId);
	}

	/**
	 * Resets all synchronization tracking, pending requests, and drops file handles from sender.
	 */
	public reset(): void {
		this.syncedPeers.clear();
		this.pendingRequests.clear();
		this.fileSender?.clearSentFileLog();
	}

	/**
	 * Disposes event subscriptions and clears all state.
	 */
	public destroy(): void {
		if (this.unsubDataChannelOpen) {
			this.unsubDataChannelOpen();
			this.unsubDataChannelOpen = null;
		}
		if (this.unsubMessage) {
			this.unsubMessage();
			this.unsubMessage = null;
		}
		if (this.unsubReceiverProgress) {
			this.unsubReceiverProgress();
			this.unsubReceiverProgress = null;
		}
		if (this.unsubReceiverCompleted) {
			this.unsubReceiverCompleted();
			this.unsubReceiverCompleted = null;
		}
		this.reset();
	}
}
