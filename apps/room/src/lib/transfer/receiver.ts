import type { WebRtcManager } from '../webrtc/manager.ts';
import type {
	IncomingTransfer,
	ParsedFileChunk,
	FileControlWirePayload,
	FileMetaWirePayload,
	FileReadyWirePayload,
	CompletedFileRecord
} from './types.ts';

export type TransferCallback = (transfer: IncomingTransfer) => void;

export interface FileReceiverOptions {
	webRtcManager: WebRtcManager;
	onTransferOffered?: TransferCallback;
	onProgress?: TransferCallback;
	onCompleted?: (record: CompletedFileRecord) => void;
	onError?: (transferId: string, error: Error) => void;
	showSaveFilePicker?: (options?: any) => Promise<any>;
}

/**
 * Validates whether the browser environment supports the W3C File System Access API
 * (Chromium / Chrome / Edge / Opera).
 */
export function isFileSystemAccessSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof (window as any).showSaveFilePicker === 'function'
	);
}

/**
 * Threshold in bytes (500MB) above which browsers assembling files in memory
 * (Firefox/Safari without File System Access API) display a prominent RAM consumption warning.
 */
export const RAM_WARNING_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * Checks if a file size warrants displaying the high RAM usage alert for in-memory assembly.
 */
export function shouldWarnLargeFile(fileSize: number): boolean {
	return !isFileSystemAccessSupported() && fileSize > RAM_WARNING_THRESHOLD_BYTES;
}

/**
 * FileReceiver coordinates incoming peer-to-peer file transfers across WebRTC.
 * In Chromium environments, writes incoming 16KB binary chunks directly to the destination
 * filesystem stream (createWritable) without buffering the file in memory.
 * In Firefox and Safari, falls back to in-memory Blob assembly with a >500MB RAM warning.
 */
export class FileReceiver {
	private webRtcManager: WebRtcManager;
	private incomingTransfers: Map<string, IncomingTransfer> = new Map();
	private writableStreams: Map<string, any> = new Map();
	private blobChunks: Map<string, Uint8Array[]> = new Map();
	private completedRecords: Map<string, CompletedFileRecord> = new Map();

	private offeredCallbacks: Set<TransferCallback> = new Set();
	private progressCallbacks: Set<TransferCallback> = new Set();
	private completedCallbacks: Set<(record: CompletedFileRecord) => void> = new Set();
	private errorCallbacks: Set<(transferId: string, error: Error) => void> = new Set();

	private customSavePicker?: (options?: any) => Promise<any>;

	constructor(options: FileReceiverOptions) {
		this.webRtcManager = options.webRtcManager;
		this.customSavePicker = options.showSaveFilePicker;

		if (options.onTransferOffered) this.offeredCallbacks.add(options.onTransferOffered);
		if (options.onProgress) this.progressCallbacks.add(options.onProgress);
		if (options.onCompleted) this.completedCallbacks.add(options.onCompleted);
		if (options.onError) this.errorCallbacks.add(options.onError);
	}

	public onOffered(cb: TransferCallback): () => void {
		this.offeredCallbacks.add(cb);
		return () => this.offeredCallbacks.delete(cb);
	}

	public onProgress(cb: TransferCallback): () => void {
		this.progressCallbacks.add(cb);
		return () => this.progressCallbacks.delete(cb);
	}

	public onCompleted(cb: (record: CompletedFileRecord) => void): () => void {
		this.completedCallbacks.add(cb);
		return () => this.completedCallbacks.delete(cb);
	}

	public onError(cb: (transferId: string, error: Error) => void): () => void {
		this.errorCallbacks.add(cb);
		return () => this.errorCallbacks.delete(cb);
	}

	public getTransfer(transferId: string): IncomingTransfer | undefined {
		return this.incomingTransfers.get(transferId);
	}

	public getAllTransfers(): IncomingTransfer[] {
		return Array.from(this.incomingTransfers.values());
	}

	public getCompletedRecords(): CompletedFileRecord[] {
		return Array.from(this.completedRecords.values());
	}

	/**
	 * Processes wire control messages (file-meta, file-complete, file-cancel).
	 */
	public async handleControlMessage(
		senderPeerId: string,
		payload: FileControlWirePayload
	): Promise<void> {
		if (payload.type === 'file-meta') {
			this.handleFileMeta(senderPeerId, payload);
		} else if (payload.type === 'file-complete') {
			await this.finalizeTransfer(payload.transferId);
		} else if (payload.type === 'file-cancel') {
			await this.abortTransfer(payload.transferId, payload.reason || 'Cancelled by sender');
		}
	}

	/**
	 * Accepts an offered file transfer using the Chromium File System Access API.
	 * Prompts user for destination path, creates a writable stream, and signals file-ready.
	 *
	 * Zero RAM buffering: all subsequently received chunks are written directly to disk.
	 */
	public async acceptWithFileSystem(
		transferId: string,
		options: { suggestedName?: string; picker?: (opts?: any) => Promise<any> } = {}
	): Promise<void> {
		const transfer = this.incomingTransfers.get(transferId);
		if (!transfer) {
			throw new Error(`Cannot accept transfer ${transferId}: transfer record not found`);
		}

		const pickerFn =
			options.picker ||
			this.customSavePicker ||
			(typeof window !== 'undefined' ? (window as any).showSaveFilePicker : null);

		if (!pickerFn) {
			throw new Error('File System Access API (showSaveFilePicker) is not supported in this browser');
		}

		try {
			// Trigger browser native file save dialogue
			const suggestedName = options.suggestedName || transfer.fileName;
			const handle = await pickerFn({
				suggestedName,
				types: transfer.fileType
					? [
							{
								description: 'File',
								accept: { [transfer.fileType]: ['.' + (suggestedName.split('.').pop() || '')] }
							}
						]
					: undefined
			});

			const writable = await handle.createWritable();
			this.writableStreams.set(transferId, writable);

			transfer.storageMode = 'filesystem';
			transfer.status = 'receiving';
			this.notifyProgress(transfer);

			// Signal file-ready to sender to initiate chunk streaming
			const readyPayload: FileReadyWirePayload = {
				type: 'file-ready',
				transferId,
				peerId: (this.webRtcManager as any).localPeerId || ''
			};

			await this.webRtcManager.send(transfer.senderPeerId, JSON.stringify(readyPayload));
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			transfer.status = 'failed';
			transfer.error = error.message;
			this.notifyError(transferId, error);
			throw error;
		}
	}

	/**
	 * Accepts an incoming file transfer using in-memory Blob aggregation.
	 * Utilized as fallback for Firefox and Safari where File System Access API is absent.
	 */
	public async acceptWithBlob(transferId: string): Promise<void> {
		const transfer = this.incomingTransfers.get(transferId);
		if (!transfer) {
			throw new Error(`Cannot accept transfer ${transferId}: transfer record not found`);
		}

		transfer.storageMode = 'blob';
		transfer.status = 'receiving';
		this.blobChunks.set(transferId, []);
		this.notifyProgress(transfer);

		// Signal file-ready to sender to initiate chunk streaming
		const readyPayload: FileReadyWirePayload = {
			type: 'file-ready',
			transferId,
			peerId: (this.webRtcManager as any).localPeerId || ''
		};

		await this.webRtcManager.send(transfer.senderPeerId, JSON.stringify(readyPayload));
	}

	/**
	 * Ingests an incoming decrypted binary chunk and streams it directly to disk
	 * or aggregates it into in-memory chunks based on storageMode.
	 */
	public async handleBinaryChunk(chunk: ParsedFileChunk): Promise<void> {
		const transfer = this.incomingTransfers.get(chunk.transferId);
		if (!transfer || transfer.status !== 'receiving') {
			return;
		}

		try {
			if (transfer.storageMode === 'filesystem') {
				const writable = this.writableStreams.get(chunk.transferId);
				if (!writable) {
					throw new Error(`Writable disk stream missing for transfer ${chunk.transferId}`);
				}
				// Direct write to disk stream without buffering in RAM
				await writable.write(chunk.data);
			} else if (transfer.storageMode === 'blob') {
				let chunks = this.blobChunks.get(chunk.transferId);
				if (!chunks) {
					chunks = [];
					this.blobChunks.set(chunk.transferId, chunks);
				}
				chunks.push(new Uint8Array(chunk.data));
			}

			transfer.receivedChunks++;
			transfer.bytesReceived += chunk.data.byteLength;
			this.notifyProgress(transfer);

			// Auto-finalize if all expected chunks have arrived
			if (transfer.receivedChunks >= transfer.totalChunks) {
				await this.finalizeTransfer(chunk.transferId);
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			transfer.status = 'failed';
			transfer.error = error.message;
			this.notifyError(chunk.transferId, error);
		}
	}

	/**
	 * Finalizes an incoming transfer, closing filesystem handles and recording completion.
	 */
	public async finalizeTransfer(transferId: string): Promise<void> {
		const transfer = this.incomingTransfers.get(transferId);
		if (!transfer || transfer.status === 'completed') {
			return;
		}

		try {
			if (transfer.storageMode === 'filesystem') {
				const writable = this.writableStreams.get(transferId);
				if (writable) {
					await writable.close();
					this.writableStreams.delete(transferId);
				}
			} else if (transfer.storageMode === 'blob') {
				const chunks = this.blobChunks.get(transferId) || [];
				const mimeType = transfer.fileType || 'application/octet-stream';
				const blob = new Blob(chunks as BlobPart[], { type: mimeType });
				transfer.blob = blob;

				if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
					try {
						transfer.downloadUrl = URL.createObjectURL(blob);
					} catch {
						// In node test environments createObjectURL might not be present
					}
				}
				this.blobChunks.delete(transferId);
			}

			transfer.status = 'completed';
			transfer.completedAt = Date.now();
			this.notifyProgress(transfer);

			const completedRecord: CompletedFileRecord = {
				transferId: transfer.transferId,
				fileName: transfer.fileName,
				fileSize: transfer.fileSize,
				fileType: transfer.fileType,
				storageMode: transfer.storageMode,
				blob: transfer.blob,
				downloadUrl: transfer.downloadUrl,
				completedAt: transfer.completedAt
			};

			this.completedRecords.set(transferId, completedRecord);
			this.notifyCompleted(completedRecord);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			transfer.status = 'failed';
			transfer.error = error.message;
			this.notifyError(transferId, error);
		}
	}

	/**
	 * Cancels an incoming transfer and aborts any active disk streams.
	 */
	public async abortTransfer(transferId: string, reason?: string): Promise<void> {
		const transfer = this.incomingTransfers.get(transferId);
		if (!transfer) return;

		const writable = this.writableStreams.get(transferId);
		if (writable) {
			try {
				if (typeof writable.abort === 'function') {
					await writable.abort(reason);
				} else {
					await writable.close();
				}
			} catch {
				// Ignore stream abort errors
			}
			this.writableStreams.delete(transferId);
		}

		this.blobChunks.delete(transferId);

		transfer.status = 'cancelled';
		transfer.error = reason;
		this.notifyProgress(transfer);
	}

	private handleFileMeta(senderPeerId: string, meta: FileMetaWirePayload): void {
		const fsSupported = isFileSystemAccessSupported();
		// Flag RAM warning if File System Access API is not supported and file exceeds 500MB
		const ramWarning = !fsSupported && meta.fileSize > RAM_WARNING_THRESHOLD_BYTES;

		const transfer: IncomingTransfer = {
			transferId: meta.transferId,
			fileName: meta.fileName,
			fileSize: meta.fileSize,
			fileType: meta.fileType,
			totalChunks: meta.totalChunks,
			receivedChunks: 0,
			bytesReceived: 0,
			sender: meta.sender,
			senderPeerId,
			status: 'offered',
			storageMode: fsSupported ? 'filesystem' : 'blob',
			ramWarning,
			startedAt: Date.now()
		};

		this.incomingTransfers.set(meta.transferId, transfer);
		this.notifyOffered(transfer);
	}

	private notifyOffered(transfer: IncomingTransfer): void {
		for (const cb of this.offeredCallbacks) {
			try {
				cb(transfer);
			} catch {}
		}
	}

	private notifyProgress(transfer: IncomingTransfer): void {
		for (const cb of this.progressCallbacks) {
			try {
				cb(transfer);
			} catch {}
		}
	}

	private notifyCompleted(record: CompletedFileRecord): void {
		for (const cb of this.completedCallbacks) {
			try {
				cb(record);
			} catch {}
		}
	}

	private notifyError(transferId: string, error: Error): void {
		for (const cb of this.errorCallbacks) {
			try {
				cb(transferId, error);
			} catch {}
		}
	}
}
