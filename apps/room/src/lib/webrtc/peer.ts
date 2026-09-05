import type {
	PeerConnectionSessionOptions,
	PeerConnectionState,
	ConnectionType,
	DataChannelState,
	PeerSessionInfo
} from './types.ts';

/**
 * Encapsulates an individual RTCPeerConnection and its associated binary RTCDataChannel.
 * Implements W3C Perfect Negotiation to reliably resolve offer/answer collisions (glare)
 * and trickle ICE candidate queuing until remote descriptions are established.
 */
export class PeerConnectionSession {
	public readonly localPeerId: string;
	public readonly remotePeerId: string;
	public readonly isInitiator: boolean;
	public readonly isPolite: boolean;

	private pc: RTCPeerConnection;
	private dataChannel: RTCDataChannel | null = null;
	private options: PeerConnectionSessionOptions;

	private connectionState: PeerConnectionState = 'connecting';
	private connectionType: ConnectionType = 'unknown';
	private dataChannelState: DataChannelState = 'closed';

	private makingOffer = false;
	private ignoreOffer = false;
	private isSettingRemoteAnswerPending = false;
	private bufferedIceCandidates: RTCIceCandidateInit[] = [];
	private hasCreatedOffer = false;
	private isClosed = false;

	constructor(options: PeerConnectionSessionOptions) {
		this.options = options;
		this.localPeerId = options.localPeerId;
		this.remotePeerId = options.remotePeerId;
		this.isInitiator = options.isInitiator !== undefined
			? options.isInitiator
			: this.localPeerId.localeCompare(this.remotePeerId) < 0;

		// Deterministic politeness tie-breaker: impolite peer initiates, polite peer responds
		this.isPolite = !this.isInitiator;

		const rtcConfig: RTCConfiguration = {
			iceServers: options.iceServers.map((s) => ({
				urls: s.urls,
				username: s.username,
				credential: s.credential
			}))
		};

		if (options.rtcPeerConnectionFactory) {
			this.pc = options.rtcPeerConnectionFactory(rtcConfig);
		} else if (typeof RTCPeerConnection !== 'undefined') {
			this.pc = new RTCPeerConnection(rtcConfig);
		} else {
			throw new Error('RTCPeerConnection is not available in the current environment');
		}

		this.setupPeerConnectionEvents();

		// Initiator proactively creates binary DataChannel
		if (this.isInitiator) {
			try {
				const dc = this.pc.createDataChannel('fastchat-data', {
					ordered: true
				});
				this.setupDataChannel(dc);
			} catch (err) {
				console.error(`[PeerSession:${this.remotePeerId}] Failed to create data channel:`, err);
				options.onError?.(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	private setupPeerConnectionEvents(): void {
		this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
			if (event.candidate && !this.isClosed) {
				const candidateStr = event.candidate.candidate;
				// RFC 8445 loopback candidate filtering
				if (
					candidateStr.includes(' 127.0.0.1 ') ||
					candidateStr.includes(' ::1 ') ||
					candidateStr.includes('.localhost ')
				) {
					return;
				}
				this.options.onIceCandidate(event.candidate.toJSON());
			}
		};

		this.pc.onconnectionstatechange = () => {
			if (this.isClosed) return;
			const pcState = this.pc.connectionState;
			if (pcState === 'connected') {
				this.connectionState = 'connected';
			} else if (pcState === 'connecting') {
				this.connectionState = 'connecting';
			} else if (pcState === 'disconnected') {
				this.connectionState = 'disconnected';
			} else if (pcState === 'failed') {
				this.connectionState = 'failed';
			} else if (pcState === 'closed') {
				this.connectionState = 'closed';
			}
			this.options.onConnectionStateChange?.(this.connectionState);
		};

		this.pc.oniceconnectionstatechange = () => {
			if (this.isClosed) return;
			const iceState = this.pc.iceConnectionState;
			if (iceState === 'disconnected') {
				this.connectionState = 'disconnected';
				this.options.onConnectionStateChange?.(this.connectionState);
			} else if (iceState === 'failed') {
				this.connectionState = 'failed';
				this.options.onConnectionStateChange?.(this.connectionState);
			}
		};

		this.pc.ondatachannel = (event: RTCDataChannelEvent) => {
			if (this.isClosed) return;
			this.setupDataChannel(event.channel);
		};

		this.pc.onnegotiationneeded = async () => {
			if (this.isClosed) return;
			this.options.onNegotiationNeeded?.();
		};
	}

	private setupDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;
		this.dataChannel.binaryType = 'arraybuffer';

		this.dataChannel.onopen = () => {
			if (this.isClosed) return;
			this.dataChannelState = 'open';
			this.options.onDataChannelStateChange?.('open');
		};

		this.dataChannel.onclose = () => {
			if (this.isClosed) return;
			this.dataChannelState = 'closed';
			this.options.onDataChannelStateChange?.('closed');
		};

		this.dataChannel.onerror = (ev) => {
			console.warn(`[PeerSession:${this.remotePeerId}] DataChannel error:`, ev);
			this.options.onError?.(new Error('RTCDataChannel error'));
		};
	}

	/**
	 * Generates and applies the initial local SDP offer.
	 */
	public async createInitialOffer(): Promise<RTCSessionDescriptionInit | null> {
		if (this.isClosed || this.hasCreatedOffer) return null;
		this.hasCreatedOffer = true;

		try {
			this.makingOffer = true;
			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);
			return this.pc.localDescription || offer;
		} catch (err) {
			console.error(`[PeerSession:${this.remotePeerId}] Failed to create initial offer:`, err);
			this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
			return null;
		} finally {
			this.makingOffer = false;
		}
	}

	/**
	 * Processes a remote SDP offer adhering to the W3C Perfect Negotiation pattern.
	 */
	public async handleRemoteOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
		if (this.isClosed) return null;

		try {
			const offerCollision =
				this.makingOffer || this.pc.signalingState !== 'stable';

			this.ignoreOffer = !this.isPolite && offerCollision;
			if (this.ignoreOffer) {
				console.warn(`[PeerSession:${this.remotePeerId}] Impolite peer ignoring colliding offer (glare)`);
				return null;
			}

			if (offerCollision) {
				await this.pc.setLocalDescription({ type: 'rollback' });
			}

			await this.pc.setRemoteDescription(offer);
			await this.drainBufferedIceCandidates();

			const answer = await this.pc.createAnswer();
			await this.pc.setLocalDescription(answer);
			return this.pc.localDescription || answer;
		} catch (err) {
			console.error(`[PeerSession:${this.remotePeerId}] Error handling remote offer:`, err);
			this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
			return null;
		}
	}

	/**
	 * Processes a remote SDP answer completing the offer/answer handshake.
	 */
	public async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		if (this.isClosed) return;

		try {
			this.isSettingRemoteAnswerPending = true;
			await this.pc.setRemoteDescription(answer);
			await this.drainBufferedIceCandidates();
		} catch (err) {
			console.error(`[PeerSession:${this.remotePeerId}] Error handling remote answer:`, err);
			this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
		} finally {
			this.isSettingRemoteAnswerPending = false;
		}
	}

	/**
	 * Buffers or adds an incoming remote trickle ICE candidate.
	 */
	public async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (this.isClosed) return;

		const candidateStr = candidate.candidate || '';
		if (
			candidateStr.includes(' 127.0.0.1 ') ||
			candidateStr.includes(' ::1 ') ||
			candidateStr.includes('.localhost ')
		) {
			return;
		}

		if (!this.pc.remoteDescription || this.isSettingRemoteAnswerPending) {
			this.bufferedIceCandidates.push(candidate);
			return;
		}

		try {
			await this.pc.addIceCandidate(candidate);
		} catch (err) {
			if (!this.ignoreOffer) {
				console.warn(`[PeerSession:${this.remotePeerId}] Error adding ICE candidate:`, err);
			}
		}
	}

	private async drainBufferedIceCandidates(): Promise<void> {
		if (this.bufferedIceCandidates.length === 0 || !this.pc.remoteDescription) return;

		const candidatesToDrain = [...this.bufferedIceCandidates];
		this.bufferedIceCandidates = [];

		for (const cand of candidatesToDrain) {
			try {
				await this.pc.addIceCandidate(cand);
			} catch (err) {
				if (!this.ignoreOffer) {
					console.warn(`[PeerSession:${this.remotePeerId}] Error draining buffered ICE candidate:`, err);
				}
			}
		}
	}

	public getPeerConnection(): RTCPeerConnection {
		return this.pc;
	}

	public getDataChannel(): RTCDataChannel | null {
		return this.dataChannel;
	}

	public getSessionInfo(): PeerSessionInfo {
		return {
			peerId: this.remotePeerId,
			connectionState: this.connectionState,
			iceConnectionState: this.pc.iceConnectionState,
			connectionType: this.connectionType,
			dataChannelState: this.dataChannelState,
			isInitiator: this.isInitiator
		};
	}

	public close(): void {
		if (this.isClosed) return;
		this.isClosed = true;

		if (this.dataChannel) {
			try {
				this.dataChannel.close();
			} catch (_) {}
			this.dataChannel = null;
		}

		try {
			this.pc.close();
		} catch (_) {}

		this.bufferedIceCandidates = [];
		this.connectionState = 'closed';
		this.dataChannelState = 'closed';
	}
}
