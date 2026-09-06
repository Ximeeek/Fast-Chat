import { writable, derived } from 'svelte/store';
import type {
	IceServerConfig,
	RoomCreatedServerMessage,
	JoinOkServerMessage
} from '$lib/types/signaling';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type RoomLifecycle = 'idle' | 'creating' | 'joined' | 'closing' | 'closed' | 'error';

export interface RoomError {
	code: string;
	message: string;
}

export interface RoomState {
	code: string | null;
	peerId: string | null;
	isOwner: boolean;
	ownerPeerId: string | null;
	salt: string | null;
	expiresAt: number | null; // Unix timestamp in seconds
	peers: string[];
	connectionState: ConnectionState;
	lifecycle: RoomLifecycle;
	closingDeadline: number | null;
	closureReason: string | null;
	error: RoomError | null;
	iceServers: IceServerConfig[];
	quotaExhausted: boolean;
	hasPassword: boolean;
	mutedPeers: Record<string, number | null>;
	isLocked: boolean;
}

const initialRoomState: RoomState = {
	code: null,
	peerId: null,
	isOwner: false,
	ownerPeerId: null,
	salt: null,
	expiresAt: null,
	peers: [],
	connectionState: 'disconnected',
	lifecycle: 'idle',
	closingDeadline: null,
	closureReason: null,
	error: null,
	iceServers: [],
	quotaExhausted: false,
	hasPassword: false,
	mutedPeers: {},
	isLocked: false
};

function createRoomStore() {
	const { subscribe, set, update } = writable<RoomState>({ ...initialRoomState });

	return {
		subscribe,
		setCreated: (payload: RoomCreatedServerMessage) => {
			const peerId = payload.peer_id || payload.peerId || null;
			update((state) => {
				const currentPeerId = peerId || state.peerId;
				return {
					...state,
					code: payload.code,
					peerId: currentPeerId,
					isOwner: true,
					ownerPeerId: currentPeerId,
					salt: payload.salt || payload.crypto_salt || null,
					expiresAt: payload.expires_at || payload.expiresAt || null,
					hasPassword: Boolean(payload.has_password ?? payload.hasPassword),
					isLocked: false,
					lifecycle: 'joined',
					error: null
				};
			});
		},
		setJoined: (payload: JoinOkServerMessage) => {
			const peerId = payload.peer_id || payload.peerId || null;
			update((state) => {
				const currentPeerId = peerId || state.peerId;
				const ownerId = payload.owner_peer_id || payload.ownerPeerId || (payload.is_owner ? currentPeerId : null);
				const mutedMap: Record<string, number | null> = {};
				const rawMuted = payload.muted_peers || payload.mutedPeers || [];
				for (const m of rawMuted) {
					const mId = m.peer_id || m.peerId;
					if (mId) {
						mutedMap[mId] = m.muted_until ?? m.mutedUntil ?? null;
					}
				}
				return {
					...state,
					code: payload.code,
					peerId: currentPeerId,
					isOwner: payload.is_owner,
					ownerPeerId: ownerId,
					salt: payload.salt,
					expiresAt: payload.expires_at || payload.expiresAt || null,
					peers: [...payload.peers],
					hasPassword: Boolean(payload.has_password ?? payload.hasPassword),
					mutedPeers: mutedMap,
					isLocked: Boolean(payload.locked ?? payload.is_locked ?? payload.isLocked),
					lifecycle: 'joined',
					error: null
				};
			});
		},
		setLocked: (isLocked: boolean) => {
			update((state) => ({ ...state, isLocked }));
		},
		setPasswordStatus: (hasPassword: boolean) => {
			update((state) => ({ ...state, hasPassword }));
		},
		setOwner: (ownerPeerId: string) => {
			update((state) => ({
				...state,
				ownerPeerId,
				isOwner: state.peerId === ownerPeerId
			}));
		},
		mutePeer: (peerId: string, mutedUntil: number | null) => {
			update((state) => ({
				...state,
				mutedPeers: {
					...state.mutedPeers,
					[peerId]: mutedUntil
				}
			}));
		},
		unmutePeer: (peerId: string) => {
			update((state) => {
				const next = { ...state.mutedPeers };
				delete next[peerId];
				return {
					...state,
					mutedPeers: next
				};
			});
		},
		addPeer: (newPeerId: string) => {
			update((state) => {
				if (state.peers.includes(newPeerId)) {
					return state;
				}
				return {
					...state,
					peers: [...state.peers, newPeerId]
				};
			});
		},
		removePeer: (peerId: string) => {
			update((state) => {
				const nextMuted = { ...state.mutedPeers };
				delete nextMuted[peerId];
				return {
					...state,
					peers: state.peers.filter((id) => id !== peerId),
					mutedPeers: nextMuted
				};
			});
		},
		setClosing: (closingDeadline: number, expiresAt: number) => {
			update((state) => ({
				...state,
				lifecycle: 'closing',
				closingDeadline,
				expiresAt
			}));
		},
		setClosed: (reason: string) => {
			update((state) => ({
				...state,
				lifecycle: 'closed',
				closureReason: reason,
				connectionState: 'closed'
			}));
		},
		setConnectionState: (connectionState: ConnectionState) => {
			update((state) => ({ ...state, connectionState }));
		},
		setError: (code: string, message: string) => {
			update((state) => ({
				...state,
				lifecycle: 'error',
				error: { code, message }
			}));
		},
		clearError: () => {
			update((state) => ({ ...state, error: null }));
		},
		setIceServers: (iceServers: IceServerConfig[], quotaExhausted: boolean) => {
			update((state) => ({
				...state,
				iceServers,
				quotaExhausted
			}));
		},
		updateExpiresAt: (expiresAt: number) => {
			update((state) => ({
				...state,
				expiresAt,
				lifecycle: state.lifecycle === 'closing' ? 'joined' : state.lifecycle
			}));
		},
		reset: () => {
			set({ ...initialRoomState });
		}
	};
}

export const roomStore = createRoomStore();

/**
 * Derived store indicating whether the room is active and open for signaling.
 */
export const isRoomActive = derived(
	roomStore,
	($room) => $room.lifecycle === 'joined' || $room.lifecycle === 'closing'
);

/**
 * Derived store exposing the total count of connected peers in the room.
 */
export const peerCount = derived(roomStore, ($room) => $room.peers.length);
