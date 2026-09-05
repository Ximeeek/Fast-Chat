import { writable, derived } from 'svelte/store';
import type { PeerSessionInfo, ConnectionType } from '../webrtc/types.ts';

function createWebRtcStore() {
	const { subscribe, set, update } = writable<Record<string, PeerSessionInfo>>({});

	return {
		subscribe,
		upsertPeer: (peer: PeerSessionInfo) => {
			update((peers) => ({
				...peers,
				[peer.peerId]: { ...peer }
			}));
		},
		updatePeerState: (peerId: string, partial: Partial<PeerSessionInfo>) => {
			update((peers) => {
				const existing = peers[peerId];
				if (!existing) return peers;
				return {
					...peers,
					[peerId]: {
						...existing,
						...partial
					}
				};
			});
		},
		removePeer: (peerId: string) => {
			update((peers) => {
				const next = { ...peers };
				delete next[peerId];
				return next;
			});
		},
		reset: () => {
			set({});
		}
	};
}

export const webrtcPeers = createWebRtcStore();

/**
 * Derived store exposing a dictionary of peerId -> ConnectionType ('direct' | 'relayed' | 'unknown').
 * Exclusively designed for UI status indicators in Phase 11.
 */
export const peerConnectionTypes = derived(webrtcPeers, ($peers) => {
	const types: Record<string, ConnectionType> = {};
	for (const [peerId, info] of Object.entries($peers)) {
		types[peerId] = info.connectionType;
	}
	return types;
});

/**
 * Derived store indicating if any established peer connection is traversing a TURN relay.
 */
export const hasRelayedPeers = derived(webrtcPeers, ($peers) => {
	return Object.values($peers).some((info) => info.connectionType === 'relayed');
});

/**
 * Derived store exposing total count of peers with open binary DataChannels.
 */
export const openDataChannelsCount = derived(webrtcPeers, ($peers) => {
	return Object.values($peers).filter((info) => info.dataChannelState === 'open').length;
});

/**
 * Derived store indicating whether any peer connection has entered the failed state.
 */
export const hasFailedPeers = derived(webrtcPeers, ($peers) => {
	return Object.values($peers).some((info) => info.connectionState === 'failed');
});

/**
 * Derived store indicating whether all registered peers have failed.
 */
export const allPeersFailed = derived(webrtcPeers, ($peers) => {
	const peers = Object.values($peers);
	return peers.length > 0 && peers.every((info) => info.connectionState === 'failed');
});

/**
 * Derived store returning list of peer IDs currently in failed state.
 */
export const failedPeerIds = derived(webrtcPeers, ($peers) => {
	return Object.entries($peers)
		.filter(([_, info]) => info.connectionState === 'failed')
		.map(([peerId]) => peerId);
});

