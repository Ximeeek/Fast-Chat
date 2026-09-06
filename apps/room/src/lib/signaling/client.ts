import { roomStore } from '../stores/room.ts';
import type {
	ClientSignalingMessage,
	ServerSignalingMessage,
	RoomCreatedServerMessage,
	JoinOkServerMessage,
	IceServersServerMessage,
	IceServersResponse,
	IceServerConfig
} from '../types/signaling.ts';

export interface SignalingClientOptions {
	wsUrl?: string;
	httpUrl?: string;
	heartbeatIntervalMs?: number;
	autoReconnect?: boolean;
}

type MessageHandler<T = ServerSignalingMessage> = (message: T) => void;

/**
 * WebSocket signaling client implementing the FastChat Signaling Protocol.
 */
export class SignalingClient {
	private ws: WebSocket | null = null;
	private wsUrl: string;
	private httpUrl: string;
	private heartbeatIntervalMs: number;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private handlers: Map<string, Set<MessageHandler<any>>> = new Map();
	private messageSubscribers: Set<MessageHandler> = new Set();
	private isExplicitlyClosed = false;
	private connectPromise: Promise<void> | null = null;

	constructor(options: SignalingClientOptions = {}) {
		const defaultWs =
			typeof window !== 'undefined'
				? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3000/ws`
				: 'ws://localhost:3000/ws';

		const defaultHttp =
			typeof window !== 'undefined'
				? `${window.location.protocol}//${window.location.hostname}:3000`
				: 'http://localhost:3000';

		this.wsUrl =
			options.wsUrl ||
			(typeof import.meta !== 'undefined' && (import.meta as any).env?.PUBLIC_SIGNALING_WS_URL) ||
			defaultWs;

		this.httpUrl =
			options.httpUrl ||
			(typeof import.meta !== 'undefined' && (import.meta as any).env?.PUBLIC_SIGNALING_HTTP_URL) ||
			defaultHttp;

		this.heartbeatIntervalMs = options.heartbeatIntervalMs || 25000;
	}

	/**
	 * Subscribes to specific server message types.
	 */
	public on<K extends ServerSignalingMessage['type']>(
		type: K,
		handler: MessageHandler<Extract<ServerSignalingMessage, { type: K }>>
	): () => void {
		if (!this.handlers.has(type)) {
			this.handlers.set(type, new Set());
		}
		this.handlers.get(type)!.add(handler);

		return () => {
			const set = this.handlers.get(type);
			if (set) {
				set.delete(handler);
				if (set.size === 0) {
					this.handlers.delete(type);
				}
			}
		};
	}

	/**
	 * Subscribes to all incoming server messages.
	 */
	public onAnyMessage(handler: MessageHandler): () => void {
		this.messageSubscribers.add(handler);
		return () => {
			this.messageSubscribers.delete(handler);
		};
	}

	/**
	 * Establishes the WebSocket connection to the signaling service.
	 */
	public async connect(): Promise<void> {
		if (this.isConnected()) {
			return;
		}

		if (this.connectPromise) {
			return this.connectPromise;
		}

		this.isExplicitlyClosed = false;
		roomStore.setConnectionState('connecting');

		this.connectPromise = new Promise<void>((resolve, reject) => {
			let isResolved = false;

			try {
				this.ws = new WebSocket(this.wsUrl);
			} catch (err) {
				roomStore.setConnectionState('disconnected');
				this.connectPromise = null;
				return reject(err);
			}

			this.ws.onopen = () => {
				isResolved = true;
				this.connectPromise = null;
				roomStore.setConnectionState('connected');
				this.startHeartbeat();
				resolve();
			};

			this.ws.onclose = () => {
				this.stopHeartbeat();
				roomStore.setConnectionState('closed');
				if (!isResolved) {
					isResolved = true;
					this.connectPromise = null;
					reject(new Error('WebSocket closed before connection was established'));
				}
			};

			this.ws.onerror = () => {
				roomStore.setConnectionState('disconnected');
				if (!isResolved) {
					isResolved = true;
					this.connectPromise = null;
					reject(new Error('WebSocket connection error'));
				}
			};

			this.ws.onmessage = (event: MessageEvent) => {
				this.handleIncomingRawMessage(event.data);
			};
		});

		return this.connectPromise;
	}

	/**
	 * Disconnects the WebSocket session and clears timers.
	 */
	public disconnect(): void {
		this.isExplicitlyClosed = true;
		this.stopHeartbeat();
		this.connectPromise = null;
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		roomStore.setConnectionState('closed');
	}

	/**
	 * Checks whether the WebSocket connection is open.
	 */
	public isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Serializes and transmits a protocol message to the signaling server.
	 */
	public send(message: ClientSignalingMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('WebSocket is not connected');
		}
		this.ws.send(JSON.stringify(message));
	}

	/**
	 * Creates a room on the signaling server and awaits acknowledgment.
	 */
	public async createRoom(options?: { password?: string; peerId?: string }): Promise<RoomCreatedServerMessage> {
		await this.ensureConnected();

		return new Promise<RoomCreatedServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error('Timed out waiting for ROOM_CREATED response'));
			}, 10000);

			const unsubCreated = this.on('ROOM_CREATED', (msg) => {
				cleanup();
				resolve(msg);
			});

			const unsubError = this.on('ERROR', (err) => {
				cleanup();
				reject(new Error(`Server error [${err.code}]: ${err.message}`));
			});

			const cleanup = () => {
				clearTimeout(timeout);
				unsubCreated();
				unsubError();
			};

			const msg: ClientSignalingMessage = {
				type: 'CREATE_ROOM',
				peer_id: options?.peerId,
				password: options?.password,
				has_password: Boolean(options?.password)
			};

			this.send(msg);
		});
	}

	/**
	 * Joins an existing room on the signaling server and awaits confirmation.
	 */
	public async joinRoom(code: string, options?: { password?: string; peerId?: string }): Promise<JoinOkServerMessage> {
		await this.ensureConnected();

		return new Promise<JoinOkServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error('Timed out waiting for JOIN_OK response'));
			}, 10000);

			const unsubJoin = this.on('JOIN_OK', (msg) => {
				cleanup();
				resolve(msg);
			});

			const unsubError = this.on('ERROR', (err) => {
				cleanup();
				reject(new Error(`Join failed [${err.code}]: ${err.message}`));
			});

			const cleanup = () => {
				clearTimeout(timeout);
				unsubJoin();
				unsubError();
			};

			const msg: ClientSignalingMessage = {
				type: 'JOIN_ROOM',
				code: code.trim(),
				peer_id: options?.peerId,
				password: options?.password
			};

			this.send(msg);
		});
	}

	/**
	 * Relays an SDP offer to a specific target peer.
	 */
	public sendSdpOffer(targetPeerId: string, sdp: unknown): void {
		this.send({
			type: 'SDP_OFFER',
			target_peer_id: targetPeerId,
			sdp
		});
	}

	/**
	 * Relays an SDP answer to a specific target peer.
	 */
	public sendSdpAnswer(targetPeerId: string, sdp: unknown): void {
		this.send({
			type: 'SDP_ANSWER',
			target_peer_id: targetPeerId,
			sdp
		});
	}

	/**
	 * Relays ICE candidate(s) to a specific target peer.
	 */
	public sendIceCandidates(targetPeerId: string, candidateOrCandidates: unknown): void {
		this.send({
			type: 'ICE_CANDIDATES',
			target_peer_id: targetPeerId,
			candidates: Array.isArray(candidateOrCandidates) ? candidateOrCandidates : undefined,
			candidate: !Array.isArray(candidateOrCandidates) ? candidateOrCandidates : undefined
		});
	}

	/**
	 * Dispatches a REKEY request to protect the room with a password/salt.
	 */
	public rekey(password: string, salt?: string): void {
		this.send({
			type: 'REKEY',
			password,
			salt
		});
	}

	/**
	 * Sets or changes the room password after creation.
	 * Can only be invoked by the current room owner.
	 */
	public setRoomPassword(password: string): void {
		this.send({
			type: 'SET_ROOM_PASSWORD',
			password
		});
	}

	/**
	 * Verifies the room password for an active room session during rekey.
	 */
	public async verifyPassword(password: string): Promise<boolean> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Signaling connection is not open');
		}

		return new Promise<boolean>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error('Password verification timed out'));
			}, 5000);

			const cleanup = this.on('PASSWORD_VERIFIED', (msg) => {
				clearTimeout(timeout);
				cleanup();
				resolve(Boolean(msg.valid));
			});

			this.send({
				type: 'VERIFY_PASSWORD',
				password
			});
		});
	}

	/**
	 * Transmits a relayed TURN usage report to the signaling server.
	 * Reports are sent strictly for relayed connections to track bandwidth consumption.
	 */
	public sendTurnUsageReport(bytes: number): boolean {
		if (bytes <= 0) return false;
		this.send({
			type: 'TURN_USAGE_REPORT',
			bytes
		});
		return true;
	}

	/**
	 * Extends the room lifetime by 5 minutes via the signaling REST API.
	 * Must be invoked by the room owner while in the ExtendableWindow (remaining <= 2:00).
	 */
	public async extendRoom(code: string, peerId: string): Promise<void> {
		const res = await fetch(`${this.httpUrl}/api/rooms/${encodeURIComponent(code.trim())}/extend`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ peer_id: peerId })
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			throw new Error(errText || `Failed to extend room: HTTP ${res.status}`);
		}
	}

	/**
	 * Requests ICE servers configuration (STUN/TURN) over WebSocket.
	 */
	public async requestIceServers(): Promise<IceServersServerMessage> {
		await this.ensureConnected();

		return new Promise<IceServersServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error('Timed out waiting for ICE_SERVERS response'));
			}, 10000);

			const unsubIce = this.on('ICE_SERVERS', (msg) => {
				cleanup();
				resolve(msg);
			});

			const cleanup = () => {
				clearTimeout(timeout);
				unsubIce();
			};

			this.send({ type: 'REQUEST_ICE_SERVERS' });
		});
	}

	/**
	 * Fetches ICE servers configuration over REST HTTP endpoint as fallback.
	 */
	public async fetchIceServersHttp(): Promise<IceServersResponse> {
		const res = await fetch(`${this.httpUrl}/api/ice-servers`);
		if (!res.ok) {
			throw new Error(`Failed to fetch ICE servers: HTTP ${res.status}`);
		}
		const data = (await res.json()) as IceServersResponse;
		const servers = data.iceServers || data.ice_servers || [];
		const quotaExhausted = data.quotaExhausted ?? data.quota_exhausted ?? false;
		roomStore.setIceServers(servers, quotaExhausted);
		return data;
	}

	/**
	 * Sends an application-level keepalive PING.
	 */
	public ping(): void {
		if (this.isConnected()) {
			this.send({ type: 'PING' });
		}
	}

	private async ensureConnected(): Promise<void> {
		if (!this.isConnected()) {
			await this.connect();
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.ping();
		}, this.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private handleIncomingRawMessage(rawData: string): void {
		let message: ServerSignalingMessage;
		try {
			message = JSON.parse(rawData);
		} catch (err) {
			console.warn('[SignalingClient] Failed to parse JSON signaling message:', rawData);
			return;
		}

		// Update in-memory reactive room store based on message semantics
		this.updateStoreFromMessage(message);

		// Notify generic message subscribers
		for (const subscriber of this.messageSubscribers) {
			try {
				subscriber(message);
			} catch (err) {
				console.error('[SignalingClient] Error in message subscriber:', err);
			}
		}

		// Notify specific type subscribers
		const typedHandlers = this.handlers.get(message.type);
		if (typedHandlers) {
			for (const handler of typedHandlers) {
				try {
					handler(message as any);
				} catch (err) {
					console.error(`[SignalingClient] Error in handler for ${message.type}:`, err);
				}
			}
		}
	}

	private updateStoreFromMessage(msg: ServerSignalingMessage): void {
		switch (msg.type) {
			case 'ROOM_CREATED':
				roomStore.setCreated(msg);
				break;
			case 'JOIN_OK':
				roomStore.setJoined(msg);
				break;
			case 'PEER_JOINED': {
				const peerId = msg.peer_id || msg.peerId;
				if (peerId) {
					roomStore.addPeer(peerId);
				}
				break;
			}
			case 'PEER_LEFT': {
				const peerId = msg.peer_id || msg.peerId;
				if (peerId) {
					roomStore.removePeer(peerId);
				}
				break;
			}
			case 'ROOM_OWNER_CHANGED': {
				const ownerId = msg.owner_peer_id || msg.ownerPeerId;
				if (ownerId) {
					roomStore.setOwner(ownerId);
				}
				break;
			}
			case 'ROOM_CLOSING': {
				const deadline = msg.closing_deadline || msg.closingDeadline || 0;
				const expires = msg.expires_at || msg.expiresAt || 0;
				roomStore.setClosing(deadline, expires);
				break;
			}
			case 'ROOM_CLOSED':
				roomStore.setClosed(msg.reason);
				break;
			case 'ERROR':
				roomStore.setError(msg.code, msg.message);
				break;
			case 'ICE_SERVERS': {
				const servers = msg.iceServers || msg.ice_servers || [];
				const quota = msg.quotaExhausted ?? msg.quota_exhausted ?? false;
				roomStore.setIceServers(servers, quota);
				break;
			}
			default:
				break;
		}
	}
}

/**
 * Singleton instance of the signaling client for use across the application.
 */
export const signalingClient = new SignalingClient();
