import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	PeerConnectionSession
} from '../src/lib/webrtc/index.ts';
import type { IceServerConfig } from '../src/lib/types/signaling.ts';

/**
 * Mock RTCDataChannel implementation adhering to W3C WebRTC specification for binary data transfer.
 */
class MockRTCDataChannel {
	public label: string;
	public ordered: boolean;
	public binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
	public readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
	public onopen: (() => void) | null = null;
	public onclose: (() => void) | null = null;
	public onerror: ((ev: any) => void) | null = null;
	public onmessage: ((ev: { data: any }) => void) | null = null;

	public sentPackets: (string | Blob | ArrayBuffer | ArrayBufferView)[] = [];

	constructor(label: string, options?: RTCDataChannelInit) {
		this.label = label;
		this.ordered = options?.ordered ?? true;
	}

	public open(): void {
		this.readyState = 'open';
		this.onopen?.();
	}

	public send(data: string | Blob | ArrayBuffer | ArrayBufferView): void {
		if (this.readyState !== 'open') {
			throw new Error('RTCDataChannel is not open');
		}
		this.sentPackets.push(data);
	}

	public close(): void {
		if (this.readyState !== 'closed') {
			this.readyState = 'closed';
			this.onclose?.();
		}
	}
}

/**
 * Mock RTCPeerConnection implementation simulating SDP negotiations, candidate stats, and channels.
 */
class MockRTCPeerConnection {
	public configuration: RTCConfiguration;
	public signalingState: RTCSignalingState = 'stable';
	public iceConnectionState: RTCIceConnectionState = 'new';
	public connectionState: RTCPeerConnectionState = 'new';
	public localDescription: RTCSessionDescriptionInit | null = null;
	public remoteDescription: RTCSessionDescriptionInit | null = null;

	public onicecandidate: ((ev: any) => void) | null = null;
	public oniceconnectionstatechange: (() => void) | null = null;
	public onconnectionstatechange: (() => void) | null = null;
	public onnegotiationneeded: (() => void) | null = null;
	public ondatachannel: ((ev: any) => void) | null = null;

	public localDataChannels: MockRTCDataChannel[] = [];
	public isClosed = false;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const channel = new MockRTCDataChannel(label, options);
		this.localDataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	public close(): void {
		this.isClosed = true;
		this.connectionState = 'closed';
		this.iceConnectionState = 'closed';
		this.signalingState = 'closed';
	}
}

describe('WebRTC Mesh & Secure DataChannel Subsystem (Phase 8)', () => {
	describe('1. RTCPeerConnection & Binary RTCDataChannel Creation', () => {
		test('instantiates RTCPeerConnection with dynamic ICE servers from Phase 5 backend', () => {
			const iceServers: IceServerConfig[] = [
				{ urls: ['stun:stun1.l.google.com:19302'] },
				{
					urls: ['turn:turn.fastchat.internal:3478?transport=udp', 'turn:turn.fastchat.internal:3478?transport=tcp'],
					username: 'fc-user-test',
					credential: 'fc-password-test'
				}
			];

			let capturedConfig: RTCConfiguration | undefined;
			const factory = (config?: RTCConfiguration) => {
				capturedConfig = config;
				return new MockRTCPeerConnection(config) as unknown as RTCPeerConnection;
			};

			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: factory
			});

			assert.ok(capturedConfig);
			assert.equal(capturedConfig.iceServers?.length, 2);
			assert.deepEqual(capturedConfig.iceServers?.[0].urls, ['stun:stun1.l.google.com:19302']);
			assert.equal(capturedConfig.iceServers?.[1].username, 'fc-user-test');

			const info = session.getSessionInfo();
			assert.equal(info.peerId, 'peer-bob');
			assert.equal(info.isInitiator, true);
			assert.equal(info.dataChannelState, 'closed');

			session.close();
		});

		test('designated initiator creates binary RTCDataChannel with arraybuffer binaryType', () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			const factory = (config?: RTCConfiguration) => {
				pcInstance = new MockRTCPeerConnection(config);
				return pcInstance as unknown as RTCPeerConnection;
			};

			const session = new PeerConnectionSession({
				localPeerId: 'alice-id',
				remotePeerId: 'bob-id',
				isInitiator: true,
				iceServers: [{ urls: ['stun:stun.example.org:3478'] }],
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: factory
			});

			assert.ok(pcInstance);
			const mockPc: MockRTCPeerConnection = pcInstance!;
			assert.equal(mockPc.localDataChannels.length, 1);
			const dc = mockPc.localDataChannels[0];
			assert.equal(dc.label, 'fastchat-data');
			assert.equal(dc.binaryType, 'arraybuffer');
			assert.equal(dc.ordered, true);

			assert.equal(session.getDataChannel(), dc as unknown as RTCDataChannel);

			session.close();
		});
	});
});
