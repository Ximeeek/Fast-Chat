import { encryptChunk, decryptChunk } from '../crypto/cipher.ts';
import { inspectCandidatePair } from './stats.ts';
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
 * and guarantees authenticated, end-to-end encrypted chunk transmission via AES-256-GCM.
 */
export class PeerConnectionSession {
	public readonly localPeerId: string;
	public readonly remotePeerId: string;
	public readonly isInitiator: boolean;
	public readonly isPolite: boolean;

	private pc: RTCPeerConnection;
	private dataChannel: RTCDataChannel | null = null;
	private options: PeerConnectionSessionOptions;
	private activeKey: CryptoKey | null = null;

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
		this.activeKey = options.activeKey || null;

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

		// Designated initiator creates binary DataChannel
		if (this.isInitiator) {
			try {
				const channel = this.pc.createDataChannel('fastchat-data', { ordered: true });
				this.setupDataChannel(channel);
			} catch (err) {
				this.notifyError(err instanceof Error ? err : new Error(String(err)));
			}
		}
	}

	/**
	 * Sets or updates the active room AES-GCM encryption key (K0 or rekeyed K1).
	 */
	public setEncryptionKey(key: CryptoKey | null): void {
		this.activeKey = key;
	}

	/**
	 * Creates an initial SDP offer if this peer is the designated initiator.
	 */
	public async createInitialOffer(): Promise<RTCSessionDescriptionInit | null> {
		if (this.isClosed || this.hasCreatedOffer) return null;
		this.hasCreatedOffer = true;
		try {
			this.makingOffer = true;
			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);
			return this.pc.localDescription ? {
				type: this.pc.localDescription.type,
				sdp: this.pc.localDescription.sdp
			} : null;
		} catch (err) {
			this.notifyError(err instanceof Error ? err : new Error(String(err)));
			return null;
		} finally {
			this.makingOffer = false;
		}
	}

	/**
	 * Processes an incoming SDP offer from the remote peer, performing perfect negotiation
	 * collision resolution and generating an SDP answer.
	 */
	public async handleRemoteOffer(
		offer: RTCSessionDescriptionInit
	): Promise<RTCSessionDescriptionInit | null> {
		if (this.isClosed) return null;

		const readyState = this.pc.signalingState;
		const offerCollision = this.makingOffer || readyState !== 'stable';

		this.ignoreOffer = !this.isPolite && offerCollision;
		if (this.ignoreOffer) {
			return null;
		}

		try {
			if (offerCollision && this.isPolite) {
				await this.pc.setLocalDescription({ type: 'rollback' });
			}

			const desc = typeof RTCSessionDescription !== 'undefined'
				? new RTCSessionDescription(offer)
				: offer;

			await this.pc.setRemoteDescription(desc);
			await this.flushBufferedCandidates();

			const answer = await this.pc.createAnswer();
			await this.pc.setLocalDescription(answer);

			return this.pc.localDescription ? {
				type: this.pc.localDescription.type,
				sdp: this.pc.localDescription.sdp
			} : null;
		} catch (err) {
			this.notifyError(err instanceof Error ? err : new Error(String(err)));
			return null;
		}
	}

	/**
	 * Processes an incoming SDP answer from the remote peer.
	 */
	public async handleRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		if (this.isClosed) return;

		try {
			this.isSettingRemoteAnswerPending = true;
			const desc = typeof RTCSessionDescription !== 'undefined'
				? new RTCSessionDescription(answer)
				: answer;

			await this.pc.setRemoteDescription(desc);
			await this.flushBufferedCandidates();
		} catch (err) {
			this.notifyError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			this.isSettingRemoteAnswerPending = false;
		}
	}

	/**
	 * Ingests an ICE candidate received over signaling, buffering it until the
	 * remote description has been applied.
	 */
	public async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (this.isClosed || !candidate || !candidate.candidate) return;

		if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
			try {
				const iceCandidate = typeof RTCIceCandidate !== 'undefined'
					? new RTCIceCandidate(candidate)
					: (candidate as RTCIceCandidate);
				await this.pc.addIceCandidate(iceCandidate);
			} catch (err) {
				if (!this.ignoreOffer) {
					this.notifyError(err instanceof Error ? err : new Error(String(err)));
				}
			}
		} else {
			this.bufferedIceCandidates.push(candidate);
		}
	}

	/**
	 * Encrypts and transmits a binary chunk or message across the RTCDataChannel.
	 */
	public async send(plaintext: Uint8Array | ArrayBuffer | string): Promise<void> {
		if (this.isClosed) {
			if (import.meta.env.DEV) {
				console.error('[WebRTC:Send:ClosedConnection]', {
					peerId: this.remotePeerId,
					readyState: this.dataChannel?.readyState ?? 'closed',
					timestamp: Date.now()
				});
			}
			throw new Error(`Cannot send to peer ${this.remotePeerId}: connection closed`);
		}

		if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
			if (import.meta.env.DEV) {
				console.error('[WebRTC:Send:ChannelNotOpen]', {
					peerId: this.remotePeerId,
					readyState: this.dataChannel?.readyState ?? 'null',
					timestamp: Date.now()
				});
			}
			throw new Error(`DataChannel to peer ${this.remotePeerId} is not open`);
		}

		if (!this.activeKey) {
			if (import.meta.env.DEV) {
				console.error('[WebRTC:Send:KeyMissing]', {
					peerId: this.remotePeerId,
					timestamp: Date.now()
				});
			}
			throw new Error(`Cannot send to peer ${this.remotePeerId}: encryption key not configured`);
		}

		let encryptedPacket: Uint8Array;
		try {
			encryptedPacket = await encryptChunk(this.activeKey, plaintext);
			if (import.meta.env.DEV) {
				console.debug('[Chat:Sender:Encrypt:Success]', {
					peerId: this.remotePeerId,
					encryptedBytes: encryptedPacket.byteLength,
					timestamp: Date.now()
				});
			}
		} catch (err) {
			if (import.meta.env.DEV) {
				console.error('[Chat:Sender:Encrypt:Failure]', {
					peerId: this.remotePeerId,
					error:
						err instanceof Error
							? { name: err.name, message: err.message, stack: err.stack }
							: String(err),
					timestamp: Date.now()
				});
			}
			throw err;
		}

		const payload = encryptedPacket.buffer.slice(
			encryptedPacket.byteOffset,
			encryptedPacket.byteOffset + encryptedPacket.byteLength
		) as ArrayBuffer;

		const currentReadyState = this.dataChannel.readyState;
		try {
			this.dataChannel.send(payload);
			if (import.meta.env.DEV) {
				console.debug('[Chat:Sender:DataChannel:Send:Success]', {
					peerId: this.remotePeerId,
					readyState: currentReadyState,
					payloadBytes: payload.byteLength,
					timestamp: Date.now()
				});
			}
		} catch (err) {
			if (import.meta.env.DEV) {
				console.error('[Chat:Sender:DataChannel:Send:Failure]', {
					peerId: this.remotePeerId,
					readyState: currentReadyState,
					error:
						err instanceof Error
							? { name: err.name, message: err.message, stack: err.stack }
							: String(err),
					timestamp: Date.now()
				});
			}
			throw err;
		}
	}

	/**
	 * Returns current serializable session snapshot.
	 */
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

	/**
	 * Closes the underlying RTCPeerConnection and RTCDataChannel.
	 */
	public close(): void {
		if (this.isClosed) return;
		this.isClosed = true;

		this.bufferedIceCandidates = [];

		if (this.dataChannel) {
			try {
				this.dataChannel.close();
			} catch {
				// Ignore errors on close
			}
			this.dataChannel = null;
			this.updateDataChannelState('closed');
		}

		try {
			this.pc.close();
		} catch {
			// Ignore errors on close
		}

		this.updateConnectionState('closed');
	}

	/**
	 * Exposes raw RTCPeerConnection instance for diagnostics or test harnesses.
	 */
	public getRawPeerConnection(): RTCPeerConnection {
		return this.pc;
	}

	/**
	 * Default low-watermark threshold in bytes for triggering bufferedamountlow events (64KB).
	 */
	public static readonly DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024;

	/**
	 * Default high-watermark threshold in bytes before pausing outbound chunk transmission (256KB).
	 */
	public static readonly DEFAULT_BUFFER_HIGH_WATERMARK = 256 * 1024;

	/**
	 * Sets the bufferedAmountLowThreshold in bytes on the active RTCDataChannel.
	 */
	public setBufferedAmountLowThreshold(threshold: number): void {
		if (this.dataChannel) {
			try {
				this.dataChannel.bufferedAmountLowThreshold = threshold;
			} catch {
				// Ignore if unsupported in environment
			}
		}
	}

	/**
	 * Returns current queued bufferedAmount on the RTCDataChannel, or 0 if not open.
	 */
	public getBufferedAmount(): number {
		return this.dataChannel ? this.dataChannel.bufferedAmount || 0 : 0;
	}

	/**
	 * Pauses execution until the RTCDataChannel's bufferedAmount drops to or below
	 * the specified threshold, applying WebRTC backpressure.
	 */
	public async waitForBufferedAmountLow(
		threshold: number = PeerConnectionSession.DEFAULT_BUFFER_HIGH_WATERMARK,
		timeoutMs: number = 30000
	): Promise<void> {
		if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
			return;
		}

		if ((this.dataChannel.bufferedAmount || 0) <= threshold) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
				resolve();
				return;
			}

			const channel = this.dataChannel;
			let timer: any = null;

			const onLow = () => {
				cleanup();
				resolve();
			};

			const onCloseOrError = () => {
				cleanup();
				reject(new Error(`RTCDataChannel closed or errored with peer ${this.remotePeerId} during buffer drain`));
			};

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				if (typeof channel.removeEventListener === 'function') {
					channel.removeEventListener('bufferedamountlow', onLow);
					channel.removeEventListener('close', onCloseOrError);
					channel.removeEventListener('error', onCloseOrError);
				} else {
					(channel as any).onbufferedamountlow = null;
				}
			};

			timer = setTimeout(() => {
				cleanup();
				resolve();
			}, timeoutMs);

			if (typeof channel.addEventListener === 'function') {
				channel.addEventListener('bufferedamountlow', onLow);
				channel.addEventListener('close', onCloseOrError);
				channel.addEventListener('error', onCloseOrError);
			} else {
				const prev = (channel as any).onbufferedamountlow;
				(channel as any).onbufferedamountlow = (ev: any) => {
					prev?.(ev);
					onLow();
				};
			}
		});
	}

	/**
	 * Exposes raw RTCDataChannel instance if instantiated.
	 */
	public getRawDataChannel(): RTCDataChannel | null {
		return this.dataChannel;
	}

	private setupPeerConnectionEvents(): void {
		this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
			if (event.candidate) {
				const candidateInit: RTCIceCandidateInit = {
					candidate: event.candidate.candidate,
					sdpMid: event.candidate.sdpMid,
					sdpMLineIndex: event.candidate.sdpMLineIndex,
					usernameFragment: event.candidate.usernameFragment
				};
				this.options.onIceCandidate(candidateInit);
			}
		};

		this.pc.onnegotiationneeded = async () => {
			if (this.options.onNegotiationNeeded) {
				this.options.onNegotiationNeeded();
			}
		};

		this.pc.oniceconnectionstatechange = () => {
			this.handleIceStateChange();
		};

		this.pc.onconnectionstatechange = () => {
			this.handleConnectionStateChange();
		};

		this.pc.ondatachannel = (event: RTCDataChannelEvent) => {
			this.setupDataChannel(event.channel);
		};
	}

	private setupDataChannel(channel: RTCDataChannel): void {
		this.dataChannel = channel;
		this.dataChannel.binaryType = 'arraybuffer';
		try {
			this.dataChannel.bufferedAmountLowThreshold =
				PeerConnectionSession.DEFAULT_BUFFERED_AMOUNT_LOW_THRESHOLD;
		} catch {
			// Ignore if unsupported in environment or mock
		}
		this.updateDataChannelState(channel.readyState as DataChannelState);

		channel.onopen = () => {
			this.updateDataChannelState('open');
			this.inspectConnectionType();
		};

		channel.onclose = () => {
			this.updateDataChannelState('closed');
		};

		channel.onerror = () => {
			this.notifyError(new Error(`DataChannel error with peer ${this.remotePeerId}`));
		};

		channel.onmessage = async (event: MessageEvent) => {
			if (import.meta.env.DEV) {
				const receivedBytes =
					event.data instanceof ArrayBuffer
						? event.data.byteLength
						: event.data instanceof Uint8Array
							? event.data.byteLength
							: typeof Blob !== 'undefined' && event.data instanceof Blob
								? event.data.size
								: -1;
				console.debug('[Chat:Receiver:DataChannel:OnMessage]', {
					peerId: this.remotePeerId,
					receivedBytes,
					timestamp: Date.now()
				});
			}
			await this.handleIncomingMessage(event.data);
		};

		if (channel.readyState === 'open') {
			this.inspectConnectionType();
		}
	}

	private async handleIncomingMessage(rawData: any): Promise<void> {
		try {
			let buffer: Uint8Array;
			if (rawData instanceof ArrayBuffer) {
				buffer = new Uint8Array(rawData);
			} else if (rawData instanceof Uint8Array) {
				buffer = rawData;
			} else if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
				buffer = new Uint8Array(await rawData.arrayBuffer());
			} else {
				throw new Error('Unsupported binary data type received on DataChannel');
			}

			if (!this.activeKey) {
				if (import.meta.env.DEV) {
					console.error('[Chat:Receiver:Decrypt:KeyMissing]', {
						peerId: this.remotePeerId,
						timestamp: Date.now()
					});
				}
				throw new Error('Cannot decrypt incoming chunk: encryption key is missing');
			}

			let plaintext: Uint8Array;
			try {
				plaintext = await decryptChunk(this.activeKey, buffer);
				if (import.meta.env.DEV) {
					console.debug('[Chat:Receiver:Decrypt:Success]', {
						peerId: this.remotePeerId,
						decryptedBytes: plaintext.byteLength,
						timestamp: Date.now()
					});
				}
			} catch (err) {
				if (import.meta.env.DEV) {
					console.error('[Chat:Receiver:Decrypt:Failure]', {
						peerId: this.remotePeerId,
						error:
							err instanceof Error
								? { name: err.name, message: err.message, stack: err.stack }
								: String(err),
						timestamp: Date.now()
					});
				}
				throw err;
			}

			this.options.onMessage?.(plaintext);
		} catch (err) {
			this.notifyError(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async flushBufferedCandidates(): Promise<void> {
		while (this.bufferedIceCandidates.length > 0) {
			const candidate = this.bufferedIceCandidates.shift();
			if (candidate) {
				try {
					const iceCandidate = typeof RTCIceCandidate !== 'undefined'
						? new RTCIceCandidate(candidate)
						: (candidate as RTCIceCandidate);
					await this.pc.addIceCandidate(iceCandidate);
				} catch (err) {
					if (!this.ignoreOffer) {
						this.notifyError(err instanceof Error ? err : new Error(String(err)));
					}
				}
			}
		}
	}

	private handleIceStateChange(): void {
		const state = this.pc.iceConnectionState;
		if (state === 'connected' || state === 'completed') {
			this.updateConnectionState('connected');
			this.inspectConnectionType();
		} else if (state === 'failed') {
			this.updateConnectionState('failed');
		} else if (state === 'disconnected') {
			this.updateConnectionState('disconnected');
		} else if (state === 'closed') {
			this.updateConnectionState('closed');
		}
	}

	private handleConnectionStateChange(): void {
		const state = this.pc.connectionState;
		if (state === 'connected') {
			this.updateConnectionState('connected');
			this.inspectConnectionType();
		} else if (state === 'failed') {
			this.updateConnectionState('failed');
		} else if (state === 'disconnected') {
			this.updateConnectionState('disconnected');
		} else if (state === 'closed') {
			this.updateConnectionState('closed');
		}
	}

	private async inspectConnectionType(): Promise<void> {
		if (this.isClosed) return;
		const type = await inspectCandidatePair(this.pc);
		if (type !== this.connectionType) {
			this.connectionType = type;
			this.options.onConnectionTypeChange?.(type);
		}
	}

	private updateConnectionState(state: PeerConnectionState): void {
		if (this.connectionState !== state) {
			this.connectionState = state;
			this.options.onConnectionStateChange?.(state);
		}
	}

	private updateDataChannelState(state: DataChannelState): void {
		if (this.dataChannelState !== state) {
			this.dataChannelState = state;
			this.options.onDataChannelStateChange?.(state);
		}
	}

	private notifyError(error: Error): void {
		this.options.onError?.(error);
	}
}
