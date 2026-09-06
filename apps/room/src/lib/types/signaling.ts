/**
 * STUN/TURN ICE server configuration matching standard RTCIceServer.
 */
export interface IceServerConfig {
	urls: string[];
	username?: string;
	credential?: string;
}

/**
 * REST endpoint response from GET /api/ice-servers.
 */
export interface IceServersResponse {
	ice_servers?: IceServerConfig[];
	iceServers: IceServerConfig[];
	quota_exhausted?: boolean;
	quotaExhausted: boolean;
	turn_issuance_limited?: boolean;
	turnIssuanceLimited?: boolean;
}

/**
 * Client-to-server signaling protocol messages over WebSocket.
 */
export type ClientSignalingMessage =
	| {
			type: 'CREATE_ROOM';
			peer_id?: string;
			peerId?: string;
			has_password?: boolean;
			hasPassword?: boolean;
			password?: string;
	  }
	| {
			type: 'JOIN_ROOM';
			code: string;
			peer_id?: string;
			peerId?: string;
			password?: string;
	  }
	| {
			type: 'SDP_OFFER';
			target_peer_id: string;
			target?: string;
			to?: string;
			sdp: unknown;
	  }
	| {
			type: 'SDP_ANSWER';
			target_peer_id: string;
			target?: string;
			to?: string;
			sdp: unknown;
	  }
	| {
			type: 'ICE_CANDIDATES';
			target_peer_id: string;
			target?: string;
			to?: string;
			candidates?: unknown;
			candidate?: unknown;
	  }
	| {
			type: 'REKEY';
			password: string;
			salt?: string;
	  }
	| {
			type: 'SET_ROOM_PASSWORD';
			password: string;
	  }
	| {
			type: 'VERIFY_PASSWORD';
			password: string;
	  }
	| {
			type: 'REQUEST_ICE_SERVERS';
	  }
	| {
			type: 'TURN_USAGE_REPORT';
			bytes: number;
	  }
	| {
			type: 'PING';
	  }
	| {
			type: 'KICK_PEER';
			peer_id?: string;
			peerId?: string;
	  }
	| {
			type: 'MUTE_PEER';
			peer_id?: string;
			peerId?: string;
			duration_seconds?: number | null;
			durationSeconds?: number | null;
	  }
	| {
			type: 'UNMUTE_PEER';
			peer_id?: string;
			peerId?: string;
	  }
	| {
			type: 'TRANSFER_OWNERSHIP';
			new_owner_peer_id?: string;
			newOwnerPeerId?: string;
			peer_id?: string;
			peerId?: string;
	  }
	| {
			type: 'SET_ROOM_LOCKED';
			locked: boolean;
	  };

/**
 * Server-to-client signaling protocol messages over WebSocket.
 */
export interface RoomCreatedServerMessage {
	type: 'ROOM_CREATED';
	code: string;
	peer_id: string;
	peerId?: string;
	salt: string;
	crypto_salt?: string;
	expires_at: number;
	expiresAt?: number;
	has_password?: boolean;
	hasPassword?: boolean;
}

export interface MutedPeerInfo {
	peer_id: string;
	peerId?: string;
	muted_until?: number | null;
	mutedUntil?: number | null;
}

export interface JoinOkServerMessage {
	type: 'JOIN_OK';
	status: string;
	code: string;
	peer_id: string;
	peerId?: string;
	is_owner: boolean;
	owner_peer_id?: string;
	ownerPeerId?: string;
	salt: string;
	expires_at: number;
	expiresAt?: number;
	peers: string[];
	muted_peers?: MutedPeerInfo[];
	mutedPeers?: MutedPeerInfo[];
	has_password?: boolean;
	hasPassword?: boolean;
	locked?: boolean;
	is_locked?: boolean;
	isLocked?: boolean;
}

export interface PeerMutedServerMessage {
	type: 'PEER_MUTED';
	peer_id: string;
	peerId?: string;
	muted_until?: number | null;
	mutedUntil?: number | null;
}

export interface PeerUnmutedServerMessage {
	type: 'PEER_UNMUTED';
	peer_id: string;
	peerId?: string;
}

export interface PeerJoinedServerMessage {
	type: 'PEER_JOINED';
	peer_id: string;
	peerId?: string;
}

export interface PeerLeftServerMessage {
	type: 'PEER_LEFT';
	peer_id: string;
	peerId?: string;
}

export interface SdpOfferServerMessage {
	type: 'SDP_OFFER';
	sender_peer_id: string;
	senderPeerId?: string;
	sdp: unknown;
}

export interface SdpAnswerServerMessage {
	type: 'SDP_ANSWER';
	sender_peer_id: string;
	senderPeerId?: string;
	sdp: unknown;
}

export interface IceCandidatesServerMessage {
	type: 'ICE_CANDIDATES';
	sender_peer_id: string;
	senderPeerId?: string;
	candidates?: unknown;
	candidate?: unknown;
}

export interface RekeyServerMessage {
	type: 'REKEY';
	room_code: string;
	salt: string;
}

export interface RoomClosingServerMessage {
	type: 'ROOM_CLOSING';
	room_code: string;
	closing_deadline: number;
	closingDeadline?: number;
	expires_at: number;
	expiresAt?: number;
}

export interface RoomClosedServerMessage {
	type: 'ROOM_CLOSED';
	room_code: string;
	reason: string;
}

export interface PongServerMessage {
	type: 'PONG';
}

export interface ErrorServerMessage {
	type: 'ERROR';
	code: string;
	message: string;
}

export interface IceServersServerMessage {
	type: 'ICE_SERVERS';
	ice_servers: IceServerConfig[];
	iceServers?: IceServerConfig[];
	quota_exhausted: boolean;
	quotaExhausted?: boolean;
	turn_issuance_limited?: boolean;
	turnIssuanceLimited?: boolean;
}

export interface RoomOwnerChangedServerMessage {
	type: 'ROOM_OWNER_CHANGED';
	room_code: string;
	roomCode?: string;
	owner_peer_id: string;
	ownerPeerId?: string;
}

export interface OwnershipTransferredServerMessage {
	type: 'OWNERSHIP_TRANSFERRED';
	room_code?: string;
	roomCode?: string;
	owner_peer_id?: string;
	ownerPeerId?: string;
	new_owner_peer_id?: string;
	newOwnerPeerId?: string;
}

export interface RoomLockedServerMessage {
	type: 'ROOM_LOCKED';
	room_code?: string;
	roomCode?: string;
	locked: boolean;
	is_locked?: boolean;
	isLocked?: boolean;
}

export interface PasswordVerifiedServerMessage {
	type: 'PASSWORD_VERIFIED';
	valid: boolean;
}

export type ServerSignalingMessage =
	| RoomCreatedServerMessage
	| JoinOkServerMessage
	| PeerJoinedServerMessage
	| PeerLeftServerMessage
	| RoomOwnerChangedServerMessage
	| OwnershipTransferredServerMessage
	| RoomLockedServerMessage
	| SdpOfferServerMessage
	| SdpAnswerServerMessage
	| IceCandidatesServerMessage
	| RekeyServerMessage
	| PasswordVerifiedServerMessage
	| RoomClosingServerMessage
	| RoomClosedServerMessage
	| PongServerMessage
	| ErrorServerMessage
	| IceServersServerMessage
	| PeerMutedServerMessage
	| PeerUnmutedServerMessage;
