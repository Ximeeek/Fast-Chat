import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	PeerConnectionSession,
	WebRtcManager
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
	public remoteIceCandidates: RTCIceCandidateInit[] = [];
	public isClosed = false;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const channel = new MockRTCDataChannel(label, options);
		this.localDataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	public async createOffer(): Promise<RTCSessionDescriptionInit> {
		return {
			type: 'offer',
			sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 DTLS/SCTP 5000\r\n'
		};
	}

	public async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return {
			type: 'answer',
			sdp: 'v=0\r\no=- 67890 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 DTLS/SCTP 5000\r\n'
		};
	}

	public async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
		if (desc?.type === 'rollback') {
			this.localDescription = null;
			this.signalingState = 'stable';
			return;
		}

		this.localDescription = desc || (await this.createOffer());
		if (this.localDescription.type === 'offer') {
			this.signalingState = 'have-local-offer';
		} else if (this.localDescription.type === 'answer') {
			this.signalingState = 'stable';
		}
	}

	public async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
		this.remoteDescription = desc;
		if (desc.type === 'offer') {
			this.signalingState = 'have-remote-offer';
		} else if (desc.type === 'answer') {
			this.signalingState = 'stable';
		}
	}

	public async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (this.signalingState === 'stable' && !this.remoteDescription) {
			throw new Error('Failed to execute addIceCandidate: remoteDescription is not set');
		}
		this.remoteIceCandidates.push(candidate);
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

	describe('2. SDP Offer/Answer Negotiation & ICE Candidate Exchange', () => {
		test('full negotiation handshake: offer -> answer -> candidate buffering and delivery', async () => {
			let pcAlice: MockRTCPeerConnection | null = null;
			let pcBob: MockRTCPeerConnection | null = null;

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: [{ urls: ['stun:stun1.l.google.com:19302'] }],
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});

			const bob = new PeerConnectionSession({
				localPeerId: 'peer-bob',
				remotePeerId: 'peer-alice',
				isInitiator: false,
				iceServers: [{ urls: ['stun:stun1.l.google.com:19302'] }],
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			// 1. Alice creates offer
			const offer = await alice.createInitialOffer();
			assert.ok(offer);
			assert.equal(offer.type, 'offer');

			// 2. Bob ingests early ICE candidate BEFORE receiving offer (tests candidate queuing)
			await bob.addRemoteIceCandidate({ candidate: 'candidate:early-cand-1', sdpMid: '0' });
			// Candidate is buffered because remoteDescription is not yet set on Bob
			assert.equal(pcBob!.remoteIceCandidates.length, 0);

			// 3. Bob receives offer and produces answer
			const answer = await bob.handleRemoteOffer(offer);
			assert.ok(answer);
			assert.equal(answer.type, 'answer');

			// Bob drained early candidate after setting remote offer
			assert.equal(pcBob!.remoteIceCandidates.length, 1);
			assert.equal(pcBob!.remoteIceCandidates[0].candidate, 'candidate:early-cand-1');

			// 4. Alice receives answer
			await alice.handleRemoteAnswer(answer);
			assert.equal(pcAlice!.signalingState, 'stable');

			alice.close();
			bob.close();
		});
	});
});
