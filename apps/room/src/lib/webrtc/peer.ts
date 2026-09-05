import type {
	PeerConnectionSessionOptions,
	PeerConnectionState,
	ConnectionType,
	DataChannelState,
	PeerSessionInfo
} from './types.ts';

/**
 * Manages an individual RTCPeerConnection and its associated binary RTCDataChannel.
 * Configures connection parameters with dynamic ICE servers and initializes an
 * ordered binary RTCDataChannel (binaryType = 'arraybuffer') for peer-to-peer data transfer.
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
	private isClosed = false;

	constructor(options: PeerConnectionSessionOptions) {
		this.options = options;
		this.localPeerId = options.localPeerId;
		this.remotePeerId = options.remotePeerId;
		this.isInitiator = options.isInitiator !== undefined
			? options.isInitiator
			: this.localPeerId.localeCompare(this.remotePeerId) < 0;

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

		this.connectionState = 'closed';
		this.dataChannelState = 'closed';
	}
}
