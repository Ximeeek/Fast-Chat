import { writable, derived } from 'svelte/store';
import type { ChatMessage } from '../chat/types.ts';
import { generateUsername } from '../chat/username.ts';

export interface ChatState {
	username: string | null;
	messages: ChatMessage[];
}

const initialChatState: ChatState = {
	username: null,
	messages: []
};

export function createChatStore() {
	const { subscribe, set, update } = writable<ChatState>({ ...initialChatState });


	return {
		subscribe,

		/**
		 * Initializes or retrieves the cosmetic username for this session.
		 * Idempotent: once assigned, the nickname remains unchanged for the lifetime
		 * of the room session unless explicitly reset.
		 */
		initUsername: (preferredName?: string): string => {
			let assigned = '';
			update((state) => {
				if (state.username) {
					assigned = state.username;
					return state;
				}
				assigned = preferredName || generateUsername();
				return {
					...state,
					username: assigned
				};
			});
			return assigned;
		},

		/**
		 * Appends a verified message to the in-memory chat history.
		 * De-duplicates incoming messages by their unique ID to prevent double-rendering
		 * in multi-peer mesh networks, and guarantees chronological order.
		 */
		addMessage: (message: ChatMessage): void => {
			update((state) => {
				if (state.messages.some((m) => m.id === message.id)) {
					return state;
				}
				const messages = [...state.messages, message];
				if (
					state.messages.length > 0 &&
					message.timestamp < state.messages[state.messages.length - 1].timestamp
				) {
					messages.sort((a, b) => {
						if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
						return a.id.localeCompare(b.id);
					});
				}
				return {
					...state,
					messages
				};
			});
		},

		/**
		 * Merges historical chat messages received from peers via WebRTC CHAT_HISTORY_SYNC.
		 * Skips any message whose unique ID already exists in the local store (preventing
		 * duplication across multi-peer mesh broadcasts and concurrent live messages),
		 * and inserts new messages in strict chronological timestamp order.
		 */
		mergeHistory: (incomingMessages: ChatMessage[]): void => {
			update((state) => {
				const existingIds = new Set(state.messages.map((m) => m.id));
				const newMessages: ChatMessage[] = [];

				for (const msg of incomingMessages) {
					if (!existingIds.has(msg.id)) {
						existingIds.add(msg.id);
						newMessages.push(msg);
					}
				}

				if (newMessages.length === 0) {
					return state;
				}

				const merged = [...state.messages, ...newMessages].sort((a, b) => {
					if (a.timestamp !== b.timestamp) {
						return a.timestamp - b.timestamp;
					}
					return a.id.localeCompare(b.id);
				});

				return {
					...state,
					messages: merged
				};
			});
		},


		/**
		 * Appends an ephemeral system announcement/log to the in-memory chat history.
		 */
		addSystemMessage: (content: string): void => {
			update((state) => ({
				...state,
				messages: [
					...state.messages,
					{
						id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						sender: 'System',
						segments: [{ type: 'text', text: content }],
						timestamp: Date.now(),
						isSelf: false,
						isSystem: true
					}
				]
			}));
		},

		/**
		 * Clears all in-memory chat messages and resets the assigned cosmetic username.
		 * Invoked upon room leave, closure, or component destruction.
		 */
		reset: (): void => {
			set({ ...initialChatState });
		}
	};
}

export const chatStore = createChatStore();

/**
 * Reactive store exposing the current list of decrypted chat messages.
 */
export const chatMessages = derived(chatStore, ($chat) => $chat.messages);

/**
 * Reactive store exposing the assigned cosmetic nickname.
 */
export const chatUsername = derived(chatStore, ($chat) => $chat.username);
