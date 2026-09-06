import { writable, derived } from 'svelte/store';
import type {
	OutgoingTransfer,
	IncomingTransfer,
	CompletedFileRecord,
	RecipientProgress,
	HistoricalFileRecord,
	FileLogEntry
} from '../transfer/types.ts';

export interface TransferStoreState {
	outgoing: OutgoingTransfer[];
	incoming: IncomingTransfer[];
	completed: CompletedFileRecord[];
	historical: HistoricalFileRecord[];
}

const initialTransferState: TransferStoreState = {
	outgoing: [],
	incoming: [],
	completed: [],
	historical: []
};

function createTransferStore() {
	const { subscribe, set, update } = writable<TransferStoreState>({ ...initialTransferState });

	return {
		subscribe,

		/**
		 * Registers a newly initiated outgoing file transfer.
		 */
		addOutgoingTransfer: (transfer: OutgoingTransfer): void => {
			update((state) => ({
				...state,
				outgoing: [...state.outgoing.filter((t) => t.transferId !== transfer.transferId), transfer]
			}));
		},

		/**
		 * Updates per-recipient progress for an active outgoing transfer.
		 */
		updateOutgoingProgress: (
			transferId: string,
			peerId: string,
			progress: RecipientProgress
		): void => {
			update((state) => {
				const outgoing = state.outgoing.map((t) => {
					if (t.transferId !== transferId) return t;
					const newRecipients = new Map(t.recipients);
					newRecipients.set(peerId, progress);

					const allDone = Array.from(newRecipients.values()).every(
						(r) => r.status === 'completed' || r.status === 'cancelled' || r.status === 'failed'
					);

					return {
						...t,
						recipients: newRecipients,
						status: allDone ? ('completed' as const) : ('sending' as const)
					};
				});
				return { ...state, outgoing };
			});
		},

		/**
		 * Registers a newly offered incoming file transfer from a remote peer.
		 */
		addIncomingTransfer: (transfer: IncomingTransfer): void => {
			update((state) => ({
				...state,
				incoming: [...state.incoming.filter((t) => t.transferId !== transfer.transferId), transfer]
			}));
		},

		/**
		 * Updates progress or lifecycle state of an incoming transfer.
		 */
		updateIncomingProgress: (transfer: IncomingTransfer): void => {
			update((state) => ({
				...state,
				incoming: state.incoming.map((t) => (t.transferId === transfer.transferId ? transfer : t))
			}));
		},

		/**
		 * Archives a completed file record available for download or ZIP export.
		 */
		addCompletedRecord: (record: CompletedFileRecord): void => {
			update((state) => ({
				...state,
				completed: [
					...state.completed.filter((c) => c.transferId !== record.transferId),
					record
				]
			}));
		},

		/**
		 * Removes a completed file record by transfer ID.
		 */
		removeCompletedRecord: (transferId: string): void => {
			update((state) => ({
				...state,
				completed: state.completed.filter((c) => c.transferId !== transferId)
			}));
		},

		/**
		 * Merges incoming historical file log entries received from remote peers.
		 */
		addHistoricalFiles: (files: FileLogEntry[]): void => {
			update((state) => {
				const existingMap = new Map(state.historical.map((h) => [h.fileId, h]));
				for (const file of files) {
					if (!existingMap.has(file.fileId)) {
						existingMap.set(file.fileId, {
							fileId: file.fileId,
							fileName: file.fileName,
							fileSize: file.fileSize,
							fileType: file.fileType || 'application/octet-stream',
							senderPeerId: file.senderPeerId,
							senderUsername: file.senderUsername,
							timestamp: file.timestamp,
							status: 'available'
						});
					}
				}
				const sorted = Array.from(existingMap.values()).sort(
					(a, b) => a.timestamp - b.timestamp
				);
				return { ...state, historical: sorted };
			});
		},

		/**
		 * Updates lifecycle state or progress for a specific historical file transfer.
		 */
		updateHistoricalFile: (
			fileId: string,
			updates: Partial<HistoricalFileRecord>
		): void => {
			update((state) => ({
				...state,
				historical: state.historical.map((h) =>
					h.fileId === fileId ? { ...h, ...updates } : h
				)
			}));
		},

		/**
		 * Explicitly flags a historical file as unavailable.
		 */
		markHistoricalUnavailable: (fileId: string, reason?: string): void => {
			update((state) => ({
				...state,
				historical: state.historical.map((h) =>
					h.fileId === fileId
						? { ...h, status: 'unavailable' as const, error: reason || 'File unavailable' }
						: h
				)
			}));
		},

		/**
		 * Clears all transfer state and revokes any active ObjectURLs.
		 */
		reset: (): void => {
			update((state) => {
				for (const comp of state.completed) {
					if (comp.downloadUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
						try {
							URL.revokeObjectURL(comp.downloadUrl);
						} catch {}
					}
				}
				for (const inc of state.incoming) {
					if (inc.downloadUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
						try {
							URL.revokeObjectURL(inc.downloadUrl);
						} catch {}
					}
				}
				for (const hist of state.historical) {
					if (hist.downloadUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
						try {
							URL.revokeObjectURL(hist.downloadUrl);
						} catch {}
					}
				}
				return { ...initialTransferState };
			});
		}
	};
}

export const transferStore = createTransferStore();

/**
 * Reactive list of all outbound file transfers.
 */
export const activeUploads = derived(transferStore, ($s) => $s.outgoing);

/**
 * Reactive list of all incoming file transfers pending acceptance or currently streaming.
 */
export const activeDownloads = derived(transferStore, ($s) =>
	$s.incoming.filter((t) => t.status === 'offered' || t.status === 'receiving')
);

/**
 * Reactive list of completed files ready for download or ZIP bundle generation.
 */
export const completedFiles = derived(transferStore, ($s) => $s.completed);

/**
 * Reactive list of all historical file records synchronized across peers.
 */
export const historicalTransfers = derived(transferStore, ($s) => $s.historical);

/**
 * Reactive flag indicating if any incoming transfer poses a high RAM risk (>500MB on Firefox/Safari).
 */
export const hasLargeFileRamWarning = derived(transferStore, ($s) =>
	$s.incoming.some((t) => t.ramWarning && (t.status === 'offered' || t.status === 'receiving'))
);

/**
 * Reactive flag indicating if any outbound file transfer is currently active or offered.
 */
export const hasActiveUpload = derived(activeUploads, ($uploads) =>
	$uploads.some((t) => t.status === 'offered' || t.status === 'sending' || t.status === 'preparing')
);
