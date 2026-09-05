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
			type: 'REQUEST_ICE_SERVERS';
	  }
	| {
			type: 'PING';
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
}

export interface JoinOkServerMessage {
	type: 'JOIN_OK';
	status: string;
	code: string;
	peer_id: string;
	peerId?: string;
	is_owner: boolean;
	salt: string;
	expires_at: number;
	expiresAt?: number;
	peers: string[];
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
}

export type ServerSignalingMessage =
	| RoomCreatedServerMessage
	| JoinOkServerMessage
	| PeerJoinedServerMessage
	| PeerLeftServerMessage
	| SdpOfferServerMessage
	| SdpAnswerServerMessage
	| IceCandidatesServerMessage
	| RekeyServerMessage
	| RoomClosingServerMessage
	| RoomClosedServerMessage
	| PongServerMessage
	| ErrorServerMessage
	| IceServersServerMessage;
