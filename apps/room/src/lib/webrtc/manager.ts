import { signalingClient, SignalingClient } from '../signaling/client.ts';
import { roomStore } from '../stores/room.ts';
import { PeerConnectionSession } from './peer.ts';
import type { IceServerConfig } from '../types/signaling.ts';
import type {
	BinaryMessageHandler,
	WebRtcManagerOptions
} from './types.ts';

/**
 * WebRTC Mesh Manager coordinating peer-to-peer connections across room participants.
 * Automatically handles dynamic ICE server discovery, signaling negotiation, candidate
 * routing, and mesh topology maintenance.
 */
export class WebRtcManager {
	private signaling: SignalingClient;
	private iceServers: IceServerConfig[] = [];
	private sessions: Map<string, PeerConnectionSession> = new Map();
	private messageHandlers: Set<BinaryMessageHandler> = new Set();
	private signalingCleanups: (() => void)[] = [];
	private rtcFactory?: (config?: RTCConfiguration) => RTCPeerConnection;
	private isInitialized = false;
	private localPeerId: string | null = null;
	private sessionPromises: Map<string, Promise<PeerConnectionSession>> = new Map();

	constructor(options: WebRtcManagerOptions = {}, signaling: SignalingClient = signalingClient) {
		this.signaling = signaling;
		this.iceServers = options.iceServers || [];
		this.rtcFactory = options.rtcPeerConnectionFactory;
	}

	/**
	 * Initializes signaling message listeners and loads ICE server configurations.
	 */
	public async init(): Promise<void> {
		if (this.isInitialized) return;
		this.isInitialized = true;

		// Ensure ICE server configurations are resolved from the Phase 5 backend
		await this.ensureIceServers();

		// Subscribe to signaling events
		this.signalingCleanups.push(
			this.signaling.on('ROOM_CREATED', (msg) => {
				this.localPeerId = msg.peer_id || msg.peerId || null;
			}),

			this.signaling.on('JOIN_OK', async (msg) => {
				this.localPeerId = msg.peer_id || msg.peerId || null;
				const myPeerId = this.localPeerId || this.getLocalPeerId();
				const existingPeers = msg.peers || [];
				for (const remotePeerId of existingPeers) {
					if (remotePeerId && myPeerId && remotePeerId !== myPeerId) {
						await this.getOrCreateSession(remotePeerId);
					}
				}
			}),

			this.signaling.on('PEER_JOINED', async (msg) => {
				const remotePeerId = msg.peer_id || msg.peerId;
				const myPeerId = this.getLocalPeerId();
				if (remotePeerId && myPeerId && remotePeerId !== myPeerId) {
					await this.getOrCreateSession(remotePeerId);
				}
			}),

			this.signaling.on('PEER_LEFT', (msg) => {
				const remotePeerId = msg.peer_id || msg.peerId;
				if (remotePeerId) {
					this.closePeer(remotePeerId);
				}
			}),

			this.signaling.on('SDP_OFFER', async (msg) => {
				const senderPeerId = msg.sender_peer_id || msg.senderPeerId;
				if (!senderPeerId) return;

				const session = await this.getOrCreateSession(senderPeerId);
				const answer = await session.handleRemoteOffer(msg.sdp as RTCSessionDescriptionInit);
				if (answer && this.signaling.isConnected()) {
					this.signaling.sendSdpAnswer(senderPeerId, answer);
				}
			}),

			this.signaling.on('SDP_ANSWER', async (msg) => {
				const senderPeerId = msg.sender_peer_id || msg.senderPeerId;
				if (!senderPeerId) return;

				const session = await this.getOrCreateSession(senderPeerId);
				if (session) {
					await session.handleRemoteAnswer(msg.sdp as RTCSessionDescriptionInit);
				}
			}),

			this.signaling.on('ICE_CANDIDATES', async (msg) => {
				const senderPeerId = msg.sender_peer_id || msg.senderPeerId;
				if (!senderPeerId) return;

				const session = await this.getOrCreateSession(senderPeerId);
				const candidatePayload = msg.candidate || msg.candidates;

				if (Array.isArray(candidatePayload)) {
					for (const cand of candidatePayload) {
						await session.addRemoteIceCandidate(cand);
					}
				} else if (candidatePayload) {
					await session.addRemoteIceCandidate(candidatePayload as RTCIceCandidateInit);
				}
			}),

			this.signaling.on('ROOM_CLOSED', () => {
				this.disconnectAll();
			})
		);
	}

	/**
	 * Resolves dynamic ICE server configurations from the signaling server.
	 */
	public async ensureIceServers(): Promise<IceServerConfig[]> {
		if (this.iceServers.length > 0) {
			return this.iceServers;
		}

		let servers: IceServerConfig[] = [];
		let quotaExhausted = false;

		// 1. Try WebSocket REQUEST_ICE_SERVERS if connected
		if (this.signaling.isConnected()) {
			try {
				const res = await this.signaling.requestIceServers();
				servers = res.iceServers || res.ice_servers || [];
				quotaExhausted = res.quotaExhausted ?? res.quota_exhausted ?? false;
			} catch {
				// Fallback to HTTP
			}
		}

		// 2. Fall back to REST endpoint GET /api/ice-servers
		if (servers.length === 0) {
			try {
				const res = await this.signaling.fetchIceServersHttp();
				servers = res.iceServers || res.ice_servers || [];
				quotaExhausted = res.quotaExhausted ?? res.quota_exhausted ?? false;
			} catch {
				// Retain empty or fallback config
			}
		}

		if (servers.length > 0) {
			this.iceServers = servers;
			roomStore.setIceServers(servers, quotaExhausted);
		} else {
			this.iceServers = [{ urls: ['stun:stun1.l.google.com:19302'] }];
		}

		return this.iceServers;
	}

	public getLocalPeerId(): string {
		if (this.localPeerId) return this.localPeerId;
		let peerId = '';
		const unsub = roomStore.subscribe((state) => {
			peerId = state.peerId || '';
		});
		unsub();
		return peerId || 'local-peer';
	}

	/**
	 * Gets an existing session or initializes a new PeerConnectionSession for remote peer.
	 */
	public async getOrCreateSession(
		remotePeerId: string,
		isInitiator?: boolean
	): Promise<PeerConnectionSession> {
		const existing = this.sessions.get(remotePeerId);
		if (existing) return existing;

		const pending = this.sessionPromises.get(remotePeerId);
		if (pending) return pending;

		const sessionPromise = (async () => {
			try {
				await this.ensureIceServers();

				const myPeerId = this.getLocalPeerId();
				const resolvedInitiator =
					isInitiator !== undefined
						? isInitiator
						: myPeerId.localeCompare(remotePeerId) < 0;

				const session = new PeerConnectionSession({
					localPeerId: myPeerId,
					remotePeerId,
					isInitiator: resolvedInitiator,
					iceServers: this.iceServers,
					rtcPeerConnectionFactory: this.rtcFactory,
					onIceCandidate: (candidate) => {
						if (this.signaling.isConnected()) {
							this.signaling.sendIceCandidates(remotePeerId, candidate);
						}
					},
					onError: (err) => {
						console.error(`[WebRtcManager] Session error with ${remotePeerId}:`, err);
					}
				});

				this.sessions.set(remotePeerId, session);

				if (resolvedInitiator) {
					const offer = await session.createInitialOffer();
					if (offer && this.signaling.isConnected()) {
						this.signaling.sendSdpOffer(remotePeerId, offer);
					}
				}

				return session;
			} finally {
				this.sessionPromises.delete(remotePeerId);
			}
		})();

		this.sessionPromises.set(remotePeerId, sessionPromise);
		return sessionPromise;
	}

	public getSession(remotePeerId: string): PeerConnectionSession | undefined {
		return this.sessions.get(remotePeerId);
	}

	public getAllSessions(): PeerConnectionSession[] {
		return Array.from(this.sessions.values());
	}

	public closePeer(remotePeerId: string): void {
		this.sessionPromises.delete(remotePeerId);
		const session = this.sessions.get(remotePeerId);
		if (session) {
			session.close();
			this.sessions.delete(remotePeerId);
		}
	}

	public disconnectAll(): void {
		this.sessionPromises.clear();
		for (const session of this.sessions.values()) {
			session.close();
		}
		this.sessions.clear();

		for (const cleanup of this.signalingCleanups) {
			try {
				cleanup();
			} catch (_) {}
		}
		this.signalingCleanups = [];
		this.isInitialized = false;
	}
}

export const webRtcManager = new WebRtcManager();
