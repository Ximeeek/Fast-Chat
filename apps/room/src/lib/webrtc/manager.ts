import { signalingClient, SignalingClient } from '../signaling/client.ts';
import { roomStore } from '../stores/room.ts';
import { webrtcPeers } from '../stores/webrtc.ts';
import { PeerConnectionSession } from './peer.ts';
import { deriveInitialKey } from '../crypto/kdf.ts';
import type { RekeyManager } from '../crypto/rekey.ts';
import type { IceServerConfig } from '../types/signaling.ts';
import type {
	BinaryMessageHandler,
	ConnectionType,
	DataChannelState,
	PeerConnectionState,
	WebRtcManagerOptions
} from './types.ts';

/**
 * WebRTC Mesh Manager coordinating peer-to-peer connections across room participants.
 * Automatically handles dynamic ICE server discovery, signaling negotiation, candidate
 * routing, transparent chunk encryption/decryption, and cryptographic rekey enforcement.
 */
export class WebRtcManager {
	private signaling: SignalingClient;
	private rekeyManager: RekeyManager | null = null;
	private activeKey: CryptoKey | null = null;
	private iceServers: IceServerConfig[] = [];
	private sessions: Map<string, PeerConnectionSession> = new Map();
	private messageHandlers: Set<BinaryMessageHandler> = new Set();
	private signalingCleanups: (() => void)[] = [];
	private rekeyCleanups: (() => void)[] = [];
	private rtcFactory?: (config?: RTCConfiguration) => RTCPeerConnection;
	private isInitialized = false;
	private localPeerId: string | null = null;
	private sessionPromises: Map<string, Promise<PeerConnectionSession>> = new Map();

	constructor(options: WebRtcManagerOptions = {}, signaling: SignalingClient = signalingClient) {
		this.signaling = signaling;
		this.activeKey = options.activeKey || null;
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

		// Auto-derive initial K0 room key when room code and salt become available in roomStore
		const unsubRoom = roomStore.subscribe(async (state) => {
			if (state.code && state.salt && !this.activeKey) {
				try {
					const initialKey = await deriveInitialKey(state.code, state.salt);
					this.setEncryptionKey(initialKey);
					if (this.rekeyManager && !this.rekeyManager.getActiveKey()) {
						this.rekeyManager.setActiveKey(initialKey);
					}
				} catch {
					// Pending or intermediate state
				}
			}
		});
		this.signalingCleanups.push(unsubRoom);

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

			this.signaling.on('REKEY', (msg) => {
				if (this.rekeyManager && this.activeKey) {
					this.rekeyManager.startRekey(this.activeKey, msg.salt);
				}
			}),

			this.signaling.on('ROOM_CLOSED', () => {
				this.disconnectAll();
			})
		);
	}

	/**
	 * Binds the RekeyManager from Phase 7 to enforce key rotation and disconnection
	 * if the 15-second password grace window expires.
	 */
	public bindRekeyManager(rekeyManager: RekeyManager): () => void {
		this.rekeyManager = rekeyManager;

		// Clean up existing bindings if re-bound
		for (const cleanup of this.rekeyCleanups) cleanup();
		this.rekeyCleanups = [];

		const unsubSuccess = rekeyManager.onSuccess((newKey: CryptoKey) => {
			this.setEncryptionKey(newKey);
		});

		const unsubTimeout = rekeyManager.onTimeout(() => {
			// Per Phase 8 specification: when rekey password verification fails or times out
			// within the ~15s window, the WebRTC layer must close peer connections immediately.
			this.disconnectAll();
		});

		this.rekeyCleanups.push(unsubSuccess, unsubTimeout);

		return () => {
			unsubSuccess();
			unsubTimeout();
		};
	}

	/**
	 * Sets the active symmetric encryption key (K0 or rekeyed K1).
	 */
	public setEncryptionKey(key: CryptoKey | null): void {
		this.activeKey = key;
		for (const session of this.sessions.values()) {
			session.setEncryptionKey(key);
		}
	}

	/**
	 * Retrieves the active symmetric encryption key.
	 */
	public getEncryptionKey(): CryptoKey | null {
		return this.activeKey;
	}

	/**
	 * Sends an encrypted binary chunk to an individual peer over its DataChannel.
	 */
	public async send(peerId: string, data: Uint8Array | ArrayBuffer | string): Promise<void> {
		const session = this.sessions.get(peerId);
		if (!session) {
			throw new Error(`Cannot send data: no active WebRTC session for peer ${peerId}`);
		}
		await session.send(data);
	}

	/**
	 * Returns identifiers of all currently registered peer sessions.
	 */
	public getSessionPeerIds(): string[] {
		return Array.from(this.sessions.keys());
	}

	/**
	 * Broadcasts an encrypted binary chunk to all peers with open DataChannels.
	 */
	public async broadcast(data: Uint8Array | ArrayBuffer | string): Promise<void> {
		const sendPromises: Promise<void>[] = [];
		for (const session of this.sessions.values()) {
			const info = session.getSessionInfo();
			if (import.meta.env.DEV) {
				console.debug('[WebRtcManager:Broadcast:PeerCheck]', {
					peerId: info.peerId,
					dataChannelState: info.dataChannelState,
					connectionState: info.connectionState,
					timestamp: Date.now()
				});
			}
			if (info.dataChannelState === 'open') {
				sendPromises.push(
					session.send(data).catch((err) => {
						if (import.meta.env.DEV) {
							console.error('[WebRtcManager:Broadcast:SendFailure]', {
								peerId: info.peerId,
								error:
									err instanceof Error
										? { name: err.name, message: err.message, stack: err.stack }
										: String(err),
								timestamp: Date.now()
							});
						}
						console.warn(`[WebRtcManager] Broadcast error to peer ${info.peerId}:`, err);
					})
				);
			}
		}
		await Promise.all(sendPromises);
	}

	/**
	 * Subscribes to decrypted incoming binary messages received across all peers.
	 */
	public onMessage(handler: BinaryMessageHandler): () => void {
		this.messageHandlers.add(handler);
		return () => {
			this.messageHandlers.delete(handler);
		};
	}

	/**
	 * Explicitly terminates and removes a specific peer session.
	 */
	public closePeer(peerId: string): void {
		this.sessionPromises.delete(peerId);
		const session = this.sessions.get(peerId);
		if (session) {
			session.close();
			this.sessions.delete(peerId);
			webrtcPeers.removePeer(peerId);
		}
	}

	/**
	 * Closes all active peer connections and flushes reactive WebRTC stores.
	 */
	public disconnectAll(): void {
		this.sessionPromises.clear();
		for (const session of this.sessions.values()) {
			session.close();
		}
		this.sessions.clear();
		webrtcPeers.reset();
	}

	/**
	 * Disposes all resources, signaling subscriptions, and active sessions.
	 */
	public destroy(): void {
		this.disconnectAll();
		for (const cleanup of this.signalingCleanups) cleanup();
		this.signalingCleanups = [];
		for (const cleanup of this.rekeyCleanups) cleanup();
		this.rekeyCleanups = [];
		this.messageHandlers.clear();
		this.isInitialized = false;
	}

	/**
	 * Gets an existing peer session or instantiates a new one configured with
	 * dynamic ICE servers and signaling callbacks.
	 */
	public async getOrCreateSession(
		remotePeerId: string,
		isInitiator?: boolean
	): Promise<PeerConnectionSession> {
		const existing = this.sessions.get(remotePeerId);
		if (existing) {
			return existing;
		}

		const pending = this.sessionPromises.get(remotePeerId);
		if (pending) {
			return pending;
		}

		const sessionPromise = (async () => {
			try {
				await this.ensureIceServers();

				const existingAfterAwait = this.sessions.get(remotePeerId);
				if (existingAfterAwait) {
					return existingAfterAwait;
				}

				const localPeerId = this.getLocalPeerId();
				const resolvedInitiator = isInitiator !== undefined
					? isInitiator
					: localPeerId.localeCompare(remotePeerId) < 0;

				let session: PeerConnectionSession;
				session = new PeerConnectionSession({
					localPeerId,
					remotePeerId,
					isInitiator: resolvedInitiator,
					iceServers: this.iceServers,
					activeKey: this.activeKey,
					rtcPeerConnectionFactory: this.rtcFactory,
					onIceCandidate: (candidate) => {
						if (this.signaling.isConnected()) {
							this.signaling.sendIceCandidates(remotePeerId, candidate);
						}
					},
					onConnectionStateChange: () => {
						if (session) {
							webrtcPeers.upsertPeer(session.getSessionInfo());
						}
					},
					onConnectionTypeChange: () => {
						if (session) {
							webrtcPeers.upsertPeer(session.getSessionInfo());
						}
					},
					onDataChannelStateChange: () => {
						if (session) {
							webrtcPeers.upsertPeer(session.getSessionInfo());
						}
					},
					onMessage: (payload) => {
						this.dispatchIncomingMessage(remotePeerId, payload);
					}
				});

				this.sessions.set(remotePeerId, session);
				webrtcPeers.upsertPeer(session.getSessionInfo());

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

	/**
	 * Returns the currently active peer session for diagnostics or tests.
	 */
	public getSession(peerId: string): PeerConnectionSession | undefined {
		return this.sessions.get(peerId);
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
				// Retain empty or existing store config
			}
		}

		if (servers.length > 0) {
			this.iceServers = servers;
			roomStore.setIceServers(servers, quotaExhausted);
		}

		return this.iceServers;
	}

	private getLocalPeerId(): string {
		if (this.localPeerId) return this.localPeerId;
		let peerId = '';
		const unsub = roomStore.subscribe((state) => {
			peerId = state.peerId || '';
		});
		unsub();
		return peerId || 'local-peer';
	}

	private dispatchIncomingMessage(peerId: string, payload: Uint8Array): void {
		for (const handler of this.messageHandlers) {
			try {
				handler(peerId, payload);
			} catch (err) {
				console.error('[WebRtcManager] Error in incoming message handler:', err);
			}
		}
	}
}

/**
 * Singleton WebRTC manager instance for use across the application.
 */
export const webRtcManager = new WebRtcManager();
