import type { IceServerConfig } from '$lib/types/signaling';

/**
 * High-level connection state of a peer connection.
 */
export type PeerConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'failed'
	| 'closed';

/**
 * Underlying network path topology for the active peer connection.
 * - direct: host, server-reflexive (STUN), or peer-reflexive P2P path.
 * - relayed: media/data relayed through a TURN server.
 * - unknown: candidate pair not yet established or statistics unavailable.
 */
export type ConnectionType = 'direct' | 'relayed' | 'unknown';

/**
 * Ready state of the binary RTCDataChannel.
 */
export type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * Serializable snapshot of an individual peer connection's runtime state.
 */
export interface PeerSessionInfo {
	peerId: string;
	connectionState: PeerConnectionState;
	iceConnectionState: RTCIceConnectionState;
	connectionType: ConnectionType;
	dataChannelState: DataChannelState;
	isInitiator: boolean;
	retryCount?: number;
	hasFailedAfterRetry?: boolean;
}

/**
 * Callback handler for incoming decrypted binary chunks or messages.
 */
export type BinaryMessageHandler = (peerId: string, payload: Uint8Array) => void;

/**
 * Callback handler for peer connection lifecycle state transitions.
 */
export type PeerStateChangeHandler = (peerId: string, state: PeerSessionInfo) => void;

/**
 * Configuration options for initializing a single PeerConnectionSession.
 */
export interface PeerConnectionSessionOptions {
	localPeerId: string;
	remotePeerId: string;
	isInitiator: boolean;
	iceServers: IceServerConfig[];
	activeKey?: CryptoKey | null;
	onIceCandidate: (candidate: RTCIceCandidateInit) => void;
	onNegotiationNeeded?: () => void;
	onDataChannelStateChange?: (state: DataChannelState) => void;
	onConnectionStateChange?: (state: PeerConnectionState) => void;
	onConnectionTypeChange?: (type: ConnectionType) => void;
	onMessage?: (payload: Uint8Array) => void;
	onError?: (error: Error) => void;
	rtcPeerConnectionFactory?: (config?: RTCConfiguration) => RTCPeerConnection;
	disconnectGracePeriodMs?: number;
}

/**
 * Configuration options for initializing the mesh WebRtcManager.
 */
export interface WebRtcManagerOptions {
	activeKey?: CryptoKey | null;
	iceServers?: IceServerConfig[];
	rtcPeerConnectionFactory?: (config?: RTCConfiguration) => RTCPeerConnection;
	disconnectGracePeriodMs?: number;
}

