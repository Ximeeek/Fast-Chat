import type { WebRtcManager } from '../webrtc/manager.ts';
import { chatStore } from '../stores/chat.ts';
import { roomStore } from '../stores/room.ts';
import type { ChatMessage } from './types.ts';
import { CHAT_HISTORY_SYNC_TYPE } from './types.ts';
import {
	serializeChatHistorySync,
	deserializeChatHistorySync
} from './transport.ts';

export interface ChatHistorySyncManagerOptions {
	/**
	 * When true, automatically binds an incoming binary message listener on WebRtcManager.
	 * Defaults to false so ingress can be cleanly delegated by the central page message dispatcher.
	 */
	autoListen?: boolean;
	/**
	 * Custom chat store instance for testing or dependency injection.
	 * Defaults to the global chatStore singleton.
	 */
	chatStore?: typeof chatStore;
	/**
	 * Custom room store instance for testing or dependency injection.
	 * Defaults to the global roomStore singleton.
	 */
	roomStore?: typeof roomStore;
	/**
	 * Optional predicate returning true if chat visibility is blocked for the given peer ID.
	 */
	isChatBlocked?: (peerId: string) => boolean;
}

/**
 * Orchestrates peer-to-peer chat history synchronization across WebRTC mesh connections.
 * Automatically transmits the sender's local chat history to newly connected peers upon
 * RTCDataChannel open transitions, ensuring historical messages are encrypted with the active
 * room key and merged on the recipient without duplicates or race conditions.
 */
export class ChatHistorySyncManager {
	private webRtcManager: WebRtcManager;
	private store: typeof chatStore;
	private roomStore: typeof roomStore;
	private isChatBlocked?: (peerId: string) => boolean;
	private syncedPeers: Set<string> = new Set();
	private unsubDataChannelOpen: (() => void) | null = null;
	private unsubMessage: (() => void) | null = null;

	constructor(
		webRtcManager: WebRtcManager,
		options: ChatHistorySyncManagerOptions = {}
	) {
		this.webRtcManager = webRtcManager;
		this.store = options.chatStore || chatStore;
		this.roomStore = options.roomStore || roomStore;
		this.isChatBlocked = options.isChatBlocked;

		// Automatically sync history once when an RTCDataChannel transitions to 'open'
		this.unsubDataChannelOpen = this.webRtcManager.onDataChannelOpen((peerId) => {
			this.syncHistoryToPeer(peerId).catch((err) => {
				console.error(`[ChatHistorySyncManager] Failed to sync history to peer ${peerId}:`, err);
			});
		});

		if (options.autoListen) {
			this.unsubMessage = this.webRtcManager.onMessage((peerId, payload) => {
				if (payload.length > 0 && payload[0] === 0x7b) {
					try {
						const jsonStr = new TextDecoder().decode(payload);
						const data = JSON.parse(jsonStr);
						if (
							data.type === CHAT_HISTORY_SYNC_TYPE ||
							data.type === 'chat_history_sync'
						) {
							this.handleSyncPayload(peerId, payload);
						}
					} catch {
						// Ignore malformed JSON
					}
				}
			});
		}
	}

	/**
	 * Transmits the local client's known chat messages to a target remote peer.
	 * Idempotent per remote peer connection: sends exactly once upon initial DataChannel open
	 * and suppresses subsequent transmissions across transient reconnects or ICE restarts.
	 *
	 * @param peerId - Remote peer identifier.
	 */
	public async syncHistoryToPeer(peerId: string): Promise<boolean> {
		if (this.syncedPeers.has(peerId)) {
			return false;
		}

		// Skip synchronization if target peer is blocked from chat visibility
		let isBlocked = false;
		if (this.isChatBlocked) {
			isBlocked = this.isChatBlocked(peerId);
		} else if (this.roomStore) {
			const unsub = this.roomStore.subscribe((state) => {
				isBlocked = state.chatBlockedPeers.includes(peerId);
			});
			unsub();
		}

		if (isBlocked) {
			return false;
		}

		this.syncedPeers.add(peerId);

		try {
			let localMessages: ChatMessage[] = [];
			const unsub = this.store.subscribe((state) => {
				localMessages = state.messages.filter((m) => !m.isSystem);
			});
			unsub();

			const payload = serializeChatHistorySync(localMessages);
			await this.webRtcManager.send(peerId, payload);

			if (typeof import.meta.env !== 'undefined' && import.meta.env.DEV) {
				console.debug('[ChatHistorySyncManager:Send]', {
					peerId,
					count: localMessages.length,
					timestamp: Date.now()
				});
			}

			return true;
		} catch (err) {
			console.error(
				`[ChatHistorySyncManager] Error transmitting history sync to peer ${peerId}:`,
				err
			);
			return false;
		}
	}

	/**
	 * Ingests, validates, and merges an incoming CHAT_HISTORY_SYNC wire payload into the chat store.
	 * Discards messages whose unique ID is already present (preventing mesh broadcast duplication)
	 * and orders all synchronized messages chronologically.
	 *
	 * @param peerId - Sender remote peer identifier.
	 * @param payload - Decrypted plaintext binary bytes.
	 * @returns True if payload was valid and processed; false otherwise.
	 */
	public handleSyncPayload(peerId: string, payload: Uint8Array): boolean {
		const syncData = deserializeChatHistorySync(payload);
		if (!syncData) {
			return false;
		}

		if (typeof import.meta.env !== 'undefined' && import.meta.env.DEV) {
			console.debug('[ChatHistorySyncManager:Receive]', {
				peerId,
				count: syncData.messages.length,
				timestamp: Date.now()
			});
		}

		const incomingMessages: ChatMessage[] = syncData.messages.map((item) => ({
			id: item.id,
			sender: item.sender,
			segments: item.segments,
			timestamp: item.timestamp,
			isSelf: false,
			isSystem: item.isSystem ?? false,
			isHistory: true,
			senderPeerId: peerId
		}));

		this.store.mergeHistory(incomingMessages);
		return true;
	}

	/**
	 * Removes tracking for a specific peer when they disconnect or leave the room.
	 */
	public removePeer(peerId: string): void {
		this.syncedPeers.delete(peerId);
	}

	/**
	 * Resets synchronization state across all peers.
	 */
	public reset(): void {
		this.syncedPeers.clear();
	}

	/**
	 * Disposes event subscriptions and clears internal state.
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
		this.reset();
	}
}
