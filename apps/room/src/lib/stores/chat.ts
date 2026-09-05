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

function createChatStore() {
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
		 * in multi-peer mesh networks.
		 */
		addMessage: (message: ChatMessage): void => {
			update((state) => {
				if (state.messages.some((m) => m.id === message.id)) {
					return state;
				}
				return {
					...state,
					messages: [...state.messages, message]
				};
			});
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
