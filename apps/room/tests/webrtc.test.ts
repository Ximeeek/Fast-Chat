import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
	PeerConnectionSession,
	WebRtcManager,
	inspectCandidatePair
} from '../src/lib/webrtc/index.ts';
import {
	webrtcPeers,
	peerConnectionTypes,
	openDataChannelsCount,
	hasRelayedPeers,
	hasFailedPeers,
	allPeersFailed
} from '../src/lib/stores/webrtc.ts';
import { deriveInitialKey } from '../src/lib/crypto/kdf.ts';
import { deriveRekeyedKey, RekeyManager } from '../src/lib/crypto/rekey.ts';
import { encryptChunk, decryptChunk, DecryptionError } from '../src/lib/crypto/cipher.ts';
import { roomStore } from '../src/lib/stores/room.ts';
import type { IceServerConfig } from '../src/lib/types/signaling.ts';
import type { ConnectionType } from '../src/lib/webrtc/types.ts';

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
	public peerChannel: MockRTCDataChannel | null = null;

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

		if (this.peerChannel && this.peerChannel.readyState === 'open') {
			// Asynchronously deliver payload to simulate network frame transit
			queueMicrotask(() => {
				let delivered: any = data;
				if (ArrayBuffer.isView(data)) {
					delivered = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
				}
				this.peerChannel?.onmessage?.({ data: delivered });
			});
		}
	}

	public close(): void {
		if (this.readyState !== 'closed') {
			this.readyState = 'closed';
			this.onclose?.();
		}
	}
}

/**
 * Mock RTCPeerConnection implementation simulating SDP negotiations, candidate stats, and loopback channels.
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
	public statsMap: Map<string, any> = new Map();
	public remoteIceCandidates: RTCIceCandidateInit[] = [];
	public isClosed = false;

	public lastOfferOptions?: RTCOfferOptions;
	public restartIceCalled = false;

	constructor(configuration: RTCConfiguration = {}) {
		this.configuration = configuration;
	}

	public restartIce(): void {
		this.restartIceCalled = true;
	}

	public createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
		const channel = new MockRTCDataChannel(label, options);
		this.localDataChannels.push(channel);
		return channel as unknown as RTCDataChannel;
	}

	public async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
		this.lastOfferOptions = options;
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

	public simulateConnectionState(state: RTCPeerConnectionState): void {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}

	public simulateIceConnectionState(state: RTCIceConnectionState): void {
		this.iceConnectionState = state;
		this.oniceconnectionstatechange?.();
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

	public async getStats(): Promise<Map<string, any>> {
		return this.statsMap;
	}

	public close(): void {
		this.isClosed = true;
		this.signalingState = 'closed';
		this.iceConnectionState = 'closed';
		this.connectionState = 'closed';
		for (const ch of this.localDataChannels) {
			ch.close();
		}
	}

	// Test helper to simulate connection transitions
	public simulateConnected(type: ConnectionType = 'direct'): void {
		this.iceConnectionState = 'connected';
		this.connectionState = 'connected';

		this.statsMap.clear();

		if (type === 'relayed') {
			this.statsMap.set('transport-1', {
				id: 'transport-1',
				type: 'transport',
				selectedCandidatePairId: 'pair-relay-1'
			});
			this.statsMap.set('pair-relay-1', {
				id: 'pair-relay-1',
				type: 'candidate-pair',
				state: 'succeeded',
				selected: true,
				localCandidateId: 'cand-local-host',
				remoteCandidateId: 'cand-remote-relay'
			});
			this.statsMap.set('cand-local-host', {
				id: 'cand-local-host',
				type: 'local-candidate',
				candidateType: 'host'
			});
			this.statsMap.set('cand-remote-relay', {
				id: 'cand-remote-relay',
				type: 'remote-candidate',
				candidateType: 'relay'
			});
		} else if (type === 'direct') {
			this.statsMap.set('transport-1', {
				id: 'transport-1',
				type: 'transport',
				selectedCandidatePairId: 'pair-direct-1'
			});
			this.statsMap.set('pair-direct-1', {
				id: 'pair-direct-1',
				type: 'candidate-pair',
				state: 'succeeded',
				selected: true,
				localCandidateId: 'cand-local-host',
				remoteCandidateId: 'cand-remote-srflx'
			});
			this.statsMap.set('cand-local-host', {
				id: 'cand-local-host',
				type: 'local-candidate',
				candidateType: 'host'
			});
			this.statsMap.set('cand-remote-srflx', {
				id: 'cand-remote-srflx',
				type: 'remote-candidate',
				candidateType: 'srflx'
			});
		}

		this.oniceconnectionstatechange?.();
		this.onconnectionstatechange?.();
	}
}

describe('WebRTC Mesh & Secure DataChannel Subsystem (Phase 8)', () => {
	const dummyIceServers: IceServerConfig[] = [
		{ urls: ['stun:stun.cloudflare.com:3478'] },
		{ urls: ['turn:turn.cloudflare.com:3478'], username: 'test-user', credential: 'test-password' }
	];

	let testKey: CryptoKey;

	beforeEach(async () => {
		webrtcPeers.reset();
		roomStore.reset();
		testKey = await deriveInitialKey('1234-5678-9012', 'sample-salt-123');
	});

	describe('1. RTCPeerConnection & Binary RTCDataChannel Creation', () => {
		test('instantiates RTCPeerConnection with dynamic ICE servers from Phase 5 backend', () => {
			let createdConfig: RTCConfiguration | undefined;

			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					createdConfig = cfg;
					return new MockRTCPeerConnection(cfg) as unknown as RTCPeerConnection;
				}
			});

			assert.ok(createdConfig);
			assert.equal(createdConfig.iceServers?.length, 2);
			assert.deepEqual(createdConfig.iceServers?.[0].urls, ['stun:stun.cloudflare.com:3478']);
			assert.deepEqual(createdConfig.iceServers?.[1].urls, ['turn:turn.cloudflare.com:3478']);
			assert.equal(createdConfig.iceServers?.[1].username, 'test-user');

			session.close();
		});

		test('designated initiator creates binary RTCDataChannel with arraybuffer binaryType', () => {
			let rawPc: MockRTCPeerConnection | null = null;

			const session = new PeerConnectionSession({
				localPeerId: 'peer-a',
				remotePeerId: 'peer-b',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			const pc = rawPc as unknown as MockRTCPeerConnection;
			assert.equal(pc.localDataChannels.length, 1);
			const dc = pc.localDataChannels[0];
			assert.equal(dc.label, 'fastchat-data');
			assert.equal(dc.binaryType, 'arraybuffer');

			session.close();
		});
	});

	describe('2. SDP Offer/Answer Negotiation & ICE Candidate Exchange', () => {
		test('full negotiation handshake: offer -> answer -> candidate buffering and delivery', async () => {
			let pcAlice: MockRTCPeerConnection | null = null;
			let pcBob: MockRTCPeerConnection | null = null;

			const aliceCandidateBuffer: RTCIceCandidateInit[] = [];
			const bobCandidateBuffer: RTCIceCandidateInit[] = [];

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: (c) => aliceCandidateBuffer.push(c),
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});

			const bob = new PeerConnectionSession({
				localPeerId: 'peer-bob',
				remotePeerId: 'peer-alice',
				isInitiator: false,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: (c) => bobCandidateBuffer.push(c),
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			// 1. Alice creates offer
			const offer = await alice.createInitialOffer();
			assert.ok(offer);
			assert.equal(offer.type, 'offer');
			assert.equal(pcAlice!.signalingState, 'have-local-offer');

			// 2. Bob ingests early ICE candidate BEFORE receiving offer (tests candidate queuing)
			await bob.addRemoteIceCandidate({ candidate: 'candidate:early-cand-1', sdpMid: '0' });
			// Candidate is buffered because remoteDescription is not yet set on Bob
			assert.equal(pcBob!.remoteIceCandidates.length, 0);

			// 3. Bob receives offer and produces answer
			const answer = await bob.handleRemoteOffer(offer);
			assert.ok(answer);
			assert.equal(answer.type, 'answer');
			assert.equal(pcBob!.signalingState, 'stable');
			// Buffered candidate was flushed on Bob
			assert.equal(pcBob!.remoteIceCandidates.length, 1);
			assert.equal(pcBob!.remoteIceCandidates[0].candidate, 'candidate:early-cand-1');

			// 4. Alice receives answer
			await alice.handleRemoteAnswer(answer);
			assert.equal(pcAlice!.signalingState, 'stable');

			alice.close();
			bob.close();
		});

		test('trickle ICE candidate buffering when candidates arrive before SDP answer on initiator', async () => {
			let pcAlice: MockRTCPeerConnection | null = null;
			let pcBob: MockRTCPeerConnection | null = null;

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
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
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					pcBob = new MockRTCPeerConnection(cfg);
					return pcBob as unknown as RTCPeerConnection;
				}
			});

			// 1. Alice creates offer
			const offer = await alice.createInitialOffer();
			assert.ok(offer);

			// 2. Bob handles offer and generates answer
			const answer = await bob.handleRemoteOffer(offer);
			assert.ok(answer);

			// 3. Bob sends ICE candidate (including loopback candidate 127.0.0.1) before Alice receives answer
			const loopbackCand: RTCIceCandidateInit = {
				candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 54321 typ host',
				sdpMid: '0'
			};
			await alice.addRemoteIceCandidate(loopbackCand);

			// Since Alice has not processed remote answer yet, candidate is buffered in Alice
			assert.equal(pcAlice!.remoteIceCandidates.length, 0);

			// 4. Alice receives answer - buffered candidates should be flushed and applied
			await alice.handleRemoteAnswer(answer);
			assert.equal(pcAlice!.signalingState, 'stable');
			assert.equal(pcAlice!.remoteIceCandidates.length, 1);
			assert.equal(pcAlice!.remoteIceCandidates[0].candidate, loopbackCand.candidate);

			alice.close();
			bob.close();
		});

		test('preserves loopback candidates on both local gathering and remote ingestion', async () => {
			let pcAlice: MockRTCPeerConnection | null = null;
			const gatheredCandidates: RTCIceCandidateInit[] = [];

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: (c) => gatheredCandidates.push(c),
				rtcPeerConnectionFactory: (cfg) => {
					pcAlice = new MockRTCPeerConnection(cfg);
					return pcAlice as unknown as RTCPeerConnection;
				}
			});

			// Simulate ICE engine generating a loopback candidate
			const loopbackEv = {
				candidate: {
					candidate: 'candidate:1 1 UDP 2122252543 127.0.0.1 54321 typ host',
					sdpMid: '0',
					sdpMLineIndex: 0,
					usernameFragment: 'ufrag123'
				}
			} as unknown as RTCPeerConnectionIceEvent;
			pcAlice!.onicecandidate?.(loopbackEv);

			// Ensure loopback candidate was not filtered out
			assert.equal(gatheredCandidates.length, 1);
			assert.ok(gatheredCandidates[0].candidate?.includes('127.0.0.1'));

			alice.close();
		});
	});

	describe('3. Connection Type Detection (Direct P2P vs Relayed TURN)', () => {
		test('detects direct P2P link when candidate types are host/srflx/prflx', async () => {
			const mockPc = new MockRTCPeerConnection();
			mockPc.simulateConnected('direct');

			const type = await inspectCandidatePair(mockPc as unknown as RTCPeerConnection);
			assert.equal(type, 'direct');
		});

		test('detects relayed connection when selected pair traverses a TURN relay', async () => {
			const mockPc = new MockRTCPeerConnection();
			mockPc.simulateConnected('relayed');

			const type = await inspectCandidatePair(mockPc as unknown as RTCPeerConnection);
			assert.equal(type, 'relayed');
		});

		test('returns unknown when connection is not established or stats are empty', async () => {
			const mockPc = new MockRTCPeerConnection();
			const type = await inspectCandidatePair(mockPc as unknown as RTCPeerConnection);
			assert.equal(type, 'unknown');
		});

		test('exposes detected connection type reactively in Svelte stores', async () => {
			let rawPc: MockRTCPeerConnection | null = null;

			const session = new PeerConnectionSession({
				localPeerId: 'peer-local',
				remotePeerId: 'peer-remote',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				onConnectionTypeChange: (type) => {
					webrtcPeers.updatePeerState('peer-remote', { connectionType: type });
				},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			webrtcPeers.upsertPeer(session.getSessionInfo());

			// Initially unknown
			let typesSnapshot: Record<string, ConnectionType> = {};
			let unsub = peerConnectionTypes.subscribe((v) => (typesSnapshot = v));
			assert.equal(typesSnapshot['peer-remote'], 'unknown');

			// Simulate direct connection
			rawPc!.simulateConnected('direct');
			await new Promise((r) => setTimeout(r, 10));

			assert.equal(typesSnapshot['peer-remote'], 'direct');

			// Simulate relay path switch
			rawPc!.simulateConnected('relayed');
			await new Promise((r) => setTimeout(r, 10));

			assert.equal(typesSnapshot['peer-remote'], 'relayed');

			unsub();
			session.close();
		});
	});

	describe('4. AES-256-GCM Chunk Encryption & Decryption over DataChannel', () => {
		test('encrypts outbound payload with encryptChunk and decrypts with decryptChunk', async () => {
			let rawAlice: MockRTCPeerConnection | null = null;
			let rawBob: MockRTCPeerConnection | null = null;

			let receivedPlaintext: Uint8Array | null = null;

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawAlice = new MockRTCPeerConnection(cfg);
					return rawAlice as unknown as RTCPeerConnection;
				}
			});

			const bob = new PeerConnectionSession({
				localPeerId: 'peer-bob',
				remotePeerId: 'peer-alice',
				isInitiator: false,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				onMessage: (payload) => {
					receivedPlaintext = payload;
				},
				rtcPeerConnectionFactory: (cfg) => {
					rawBob = new MockRTCPeerConnection(cfg);
					return rawBob as unknown as RTCPeerConnection;
				}
			});

			// Connect mock data channels to simulate bidirectional pipeline
			const aliceDc = rawAlice!.localDataChannels[0];
			const bobDc = new MockRTCDataChannel('fastchat-data');
			aliceDc.peerChannel = bobDc;
			bobDc.peerChannel = aliceDc;

			// Trigger ondatachannel on Bob
			rawBob!.ondatachannel?.({ channel: bobDc });

			// Open channels
			aliceDc.open();
			bobDc.open();

			// Transmit secret message
			const originalMessage = 'Hello confidential WebRTC peer!';
			await alice.send(originalMessage);

			// Verify data on the wire is encrypted (cannot match plaintext and has IV + GCM tag)
			assert.equal(aliceDc.sentPackets.length, 1);
			const wireBytes = new Uint8Array(aliceDc.sentPackets[0] as ArrayBuffer);
			assert.notEqual(new TextDecoder().decode(wireBytes), originalMessage);
			assert.ok(wireBytes.byteLength >= 12 + 16 + originalMessage.length);

			// Await delivery microtask
			await new Promise((r) => setTimeout(r, 20));

			assert.ok(receivedPlaintext);
			assert.equal(new TextDecoder().decode(receivedPlaintext), originalMessage);

			alice.close();
			bob.close();
		});

		test('rejects tampered or forged packets with DecryptionError', async () => {
			let rawAlice: MockRTCPeerConnection | null = null;
			let rawBob: MockRTCPeerConnection | null = null;
			let errorRecorded: Error | null = null;

			const alice = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawAlice = new MockRTCPeerConnection(cfg);
					return rawAlice as unknown as RTCPeerConnection;
				}
			});

			const bob = new PeerConnectionSession({
				localPeerId: 'peer-bob',
				remotePeerId: 'peer-alice',
				isInitiator: false,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				onError: (err) => {
					errorRecorded = err;
				},
				rtcPeerConnectionFactory: (cfg) => {
					rawBob = new MockRTCPeerConnection(cfg);
					return rawBob as unknown as RTCPeerConnection;
				}
			});

			const aliceDc = rawAlice!.localDataChannels[0];
			const bobDc = new MockRTCDataChannel('fastchat-data');
			rawBob!.ondatachannel?.({ channel: bobDc });

			bobDc.open();

			// Manually inject a tampered packet to Bob's channel
			const validCiphertext = await encryptChunk(testKey, 'authentic payload');
			// Corrupt byte in ciphertext payload
			validCiphertext[15] ^= 0xff;

			bobDc.onmessage?.({ data: validCiphertext.buffer });

			await new Promise((r) => setTimeout(r, 20));

			if (!errorRecorded) throw new Error('errorRecorded is null');
			const errMessage = (errorRecorded as Error).message || '';
			const errName = (errorRecorded as Error).name || '';
			assert.ok(errMessage.includes('authentication verification failed') || errName === 'DecryptionError');

			alice.close();
			bob.close();
		});
	});

	describe('5. Rekey ~15-Second Grace Window Timeout Disconnection', () => {
		test('closes all peer connections when rekey window expires without password', async () => {
			let timeoutCb: (() => void) | null = null;
			const mockTimer = {
				setTimeout: (cb: () => void) => {
					timeoutCb = cb;
					return 1;
				},
				clearTimeout: () => {}
			};

			const rekeyManager = new RekeyManager({
				timeoutMs: 15000,
				timer: mockTimer
			});
			rekeyManager.setActiveKey(testKey);

			let rawPc: MockRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			manager.bindRekeyManager(rekeyManager);

			// Establish session
			const session = await manager.getOrCreateSession('peer-charlie', true);
			assert.equal(rawPc!.isClosed, false);

			// Start rekey grace period (~15s)
			rekeyManager.startRekey();
			assert.equal(rekeyManager.getStatus(), 'pending');

			// Trigger ~15s timeout
			if (!timeoutCb) throw new Error('timeoutCb is null');
			(timeoutCb as () => void)();

			assert.equal(rekeyManager.getStatus(), 'timed_out');
			// WebRTC layer must have closed the peer connection
			assert.equal(rawPc!.isClosed, true);
			assert.equal(manager.getSession('peer-charlie'), undefined);

			manager.destroy();
			rekeyManager.dispose();
		});

		test('seamlessly rotates active room key across peer sessions on successful rekey', async () => {
			const rekeyManager = new RekeyManager();
			rekeyManager.setActiveKey(testKey);

			let rawAlice: MockRTCPeerConnection | null = null;
			let rawBob: MockRTCPeerConnection | null = null;

			const managerAlice = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawAlice = new MockRTCPeerConnection(cfg);
					return rawAlice as unknown as RTCPeerConnection;
				}
			});

			const managerBob = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					rawBob = new MockRTCPeerConnection(cfg);
					return rawBob as unknown as RTCPeerConnection;
				}
			});

			managerAlice.bindRekeyManager(rekeyManager);

			const sessionAlice = await managerAlice.getOrCreateSession('peer-bob', true);
			const sessionBob = await managerBob.getOrCreateSession('peer-alice', false);

			const aliceDc = rawAlice!.localDataChannels[0];
			const bobDc = new MockRTCDataChannel('fastchat-data');
			aliceDc.peerChannel = bobDc;
			bobDc.peerChannel = aliceDc;
			rawBob!.ondatachannel?.({ channel: bobDc });
			aliceDc.open();
			bobDc.open();

			// Rotate to K1 using password
			rekeyManager.startRekey();
			const k1 = await rekeyManager.submitPassword('super-secret-pw');
			managerBob.setEncryptionKey(k1);

			// Transmit message encrypted under K1
			let bobReceived: Uint8Array | null = null;
			managerBob.onMessage((sender, payload) => {
				bobReceived = payload;
			});

			await managerAlice.send('peer-bob', 'Rotated key message');
			await new Promise((r) => setTimeout(r, 20));

			assert.ok(bobReceived);
			assert.equal(new TextDecoder().decode(bobReceived), 'Rotated key message');

			managerAlice.destroy();
			managerBob.destroy();
			rekeyManager.dispose();
		});
	});

	describe('6. Generic Transport Interface (Send & Broadcast)', () => {
		test('send routes encrypted payload to specific peer and broadcast distributes to all open peers', async () => {
			let pcA: MockRTCPeerConnection | null = null;
			let pcB: MockRTCPeerConnection | null = null;

			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					const pc = new MockRTCPeerConnection(cfg);
					if (!pcA) pcA = pc;
					else pcB = pc;
					return pc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-1', true);
			await manager.getOrCreateSession('peer-2', true);

			const dc1 = pcA!.localDataChannels[0];
			const dc2 = pcB!.localDataChannels[0];
			dc1.open();
			dc2.open();

			// Targeted send
			await manager.send('peer-1', 'Message for peer 1 only');
			assert.equal(dc1.sentPackets.length, 1);
			assert.equal(dc2.sentPackets.length, 0);

			// Broadcast
			await manager.broadcast('Broadcast to all peers');
			assert.equal(dc1.sentPackets.length, 2);
			assert.equal(dc2.sentPackets.length, 1);

			manager.destroy();
		});
	});

	describe('7. WebRTC ICE Failure Handling, Disconnect Buffering & ICE Restart', () => {
		test('RTCPeerConnection connectionState failed immediately propagates to session and store', async () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcInstance = new MockRTCPeerConnection(cfg);
					return pcInstance as unknown as RTCPeerConnection;
				}
			});

			const session = await manager.getOrCreateSession('peer-fail-1', true);
			assert.equal(session.getSessionInfo().connectionState, 'connecting');

			pcInstance!.simulateConnectionState('failed');

			assert.equal(session.getSessionInfo().connectionState, 'failed');
			let hasFailed = false;
			const unsub = hasFailedPeers.subscribe((v) => {
				hasFailed = v;
			});
			unsub();
			assert.equal(hasFailed, true);

			manager.destroy();
		});

		test('RTCIceConnectionState failed immediately propagates to session and store', async () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					pcInstance = new MockRTCPeerConnection(cfg);
					return pcInstance as unknown as RTCPeerConnection;
				}
			});

			const session = await manager.getOrCreateSession('peer-fail-2', true);
			pcInstance!.simulateIceConnectionState('failed');

			assert.equal(session.getSessionInfo().connectionState, 'failed');
			manager.destroy();
		});

		test('transient disconnected state buffers before failing and recovers if connected returns within grace period', async () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				disconnectGracePeriodMs: 60,
				rtcPeerConnectionFactory: (cfg) => {
					pcInstance = new MockRTCPeerConnection(cfg);
					return pcInstance as unknown as RTCPeerConnection;
				}
			});

			const session = await manager.getOrCreateSession('peer-transient', true);
			pcInstance!.simulateConnectionState('connected');
			assert.equal(session.getSessionInfo().connectionState, 'connected');

			// Transient network disconnect
			pcInstance!.simulateConnectionState('disconnected');
			assert.equal(session.getSessionInfo().connectionState, 'disconnected');

			// Recover within grace period
			await new Promise((r) => setTimeout(r, 20));
			pcInstance!.simulateConnectionState('connected');

			// Wait past original grace period timeout
			await new Promise((r) => setTimeout(r, 60));

			assert.equal(session.getSessionInfo().connectionState, 'connected');
			let hasFailed = false;
			const unsub = hasFailedPeers.subscribe((v) => {
				hasFailed = v;
			});
			unsub();
			assert.equal(hasFailed, false);

			manager.destroy();
		});

		test('persistent disconnected state transitions to failed after grace period expires', async () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				disconnectGracePeriodMs: 50,
				rtcPeerConnectionFactory: (cfg) => {
					pcInstance = new MockRTCPeerConnection(cfg);
					return pcInstance as unknown as RTCPeerConnection;
				}
			});

			const session = await manager.getOrCreateSession('peer-persistent-disc', true);
			pcInstance!.simulateConnectionState('connected');
			assert.equal(session.getSessionInfo().connectionState, 'connected');

			// Network drop
			pcInstance!.simulateConnectionState('disconnected');
			assert.equal(session.getSessionInfo().connectionState, 'disconnected');

			// Wait for grace period timeout to fire
			await new Promise((r) => setTimeout(r, 70));

			assert.equal(session.getSessionInfo().connectionState, 'failed');
			let hasFailed = false;
			const unsub = hasFailedPeers.subscribe((v) => {
				hasFailed = v;
			});
			unsub();
			assert.equal(hasFailed, true);

			manager.destroy();
		});

		test('UI failure state and store helpers accurately report allPeersFailed and failedPeerIds', async () => {
			let pcA: MockRTCPeerConnection | null = null;
			let pcB: MockRTCPeerConnection | null = null;

			const manager = new WebRtcManager({
				activeKey: testKey,
				iceServers: dummyIceServers,
				rtcPeerConnectionFactory: (cfg) => {
					const pc = new MockRTCPeerConnection(cfg);
					if (!pcA) pcA = pc;
					else pcB = pc;
					return pc as unknown as RTCPeerConnection;
				}
			});

			await manager.getOrCreateSession('peer-a', true);
			await manager.getOrCreateSession('peer-b', true);

			pcA!.simulateConnectionState('failed');
			pcB!.simulateConnectionState('connected');

			// One failed, one connected
			let failedList: string[] = [];
			const unsubList = (await import('../src/lib/stores/webrtc.ts')).failedPeerIds.subscribe((list) => {
				failedList = list;
			});
			unsubList();
			assert.deepEqual(failedList, ['peer-a']);

			let allFailed = true;
			const unsubAll = allPeersFailed.subscribe((v) => {
				allFailed = v;
			});
			unsubAll();
			assert.equal(allFailed, false);

			// Now both fail
			pcB!.simulateConnectionState('failed');
			const unsubAll2 = allPeersFailed.subscribe((v) => {
				allFailed = v;
			});
			unsubAll2();
			assert.equal(allFailed, true);

			manager.destroy();
		});

		test('PeerConnectionSession.restartIce initiates renegotiation with iceRestart: true and tracks retry lifecycle', async () => {
			let rawPc: MockRTCPeerConnection | null = null;
			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			// Initial failure
			rawPc!.simulateConnectionState('failed');
			assert.equal(session.getSessionInfo().connectionState, 'failed');
			assert.equal(session.getSessionInfo().retryCount, 0);
			assert.equal(session.getSessionInfo().hasFailedAfterRetry, false);

			// Trigger ICE restart
			const offer = await session.restartIce();
			assert.ok(offer);
			assert.equal(offer.type, 'offer');
			assert.equal(rawPc!.restartIceCalled, true);
			assert.equal(rawPc!.lastOfferOptions?.iceRestart, true);
			assert.equal(session.getSessionInfo().connectionState, 'connecting');
			assert.equal(session.getSessionInfo().retryCount, 1);
			assert.equal(session.getSessionInfo().hasFailedAfterRetry, false);

			// Second failure marks hasFailedAfterRetry
			rawPc!.simulateConnectionState('failed');
			assert.equal(session.getSessionInfo().connectionState, 'failed');
			assert.equal(session.getSessionInfo().hasFailedAfterRetry, true);

			session.close();
		});

		test('WebRtcManager.restartPeerIce triggers ICE restart on session and transmits offer over signaling', async () => {
			let pcInstance: MockRTCPeerConnection | null = null;
			let transmittedOffer: any = null;
			let targetPeer: string | null = null;

			const mockSignaling = {
				on: () => () => {},
				isConnected: () => true,
				sendSdpOffer: (peerId: string, offer: any) => {
					targetPeer = peerId;
					transmittedOffer = offer;
				},
				sendIceCandidates: () => {},
				sendSdpAnswer: () => {}
			};

			const manager = new WebRtcManager(
				{
					activeKey: testKey,
					iceServers: dummyIceServers,
					rtcPeerConnectionFactory: (cfg) => {
						pcInstance = new MockRTCPeerConnection(cfg);
						return pcInstance as unknown as RTCPeerConnection;
					}
				},
				mockSignaling as any
			);

			await manager.getOrCreateSession('peer-target', true);
			pcInstance!.simulateConnectionState('failed');

			// Non-existent peer fails gracefully
			const failedUnknown = await manager.restartPeerIce('unknown-peer');
			assert.equal(failedUnknown, false);

			// Existing peer initiates restart and sends offer
			const success = await manager.restartPeerIce('peer-target');
			assert.equal(success, true);
			assert.equal(targetPeer, 'peer-target');
			assert.ok(transmittedOffer);
			assert.equal(transmittedOffer.type, 'offer');
			assert.equal(pcInstance!.lastOfferOptions?.iceRestart, true);

			manager.destroy();
		});

		test('reconnection after ICE restart recovers session state and resets failure indicators', async () => {
			let rawPc: MockRTCPeerConnection | null = null;
			const session = new PeerConnectionSession({
				localPeerId: 'peer-alice',
				remotePeerId: 'peer-bob',
				isInitiator: true,
				iceServers: dummyIceServers,
				activeKey: testKey,
				onIceCandidate: () => {},
				rtcPeerConnectionFactory: (cfg) => {
					rawPc = new MockRTCPeerConnection(cfg);
					return rawPc as unknown as RTCPeerConnection;
				}
			});

			rawPc!.simulateConnectionState('failed');
			assert.equal(session.getSessionInfo().connectionState, 'failed');

			await session.restartIce();
			assert.equal(session.getSessionInfo().connectionState, 'connecting');
			assert.equal(session.getSessionInfo().retryCount, 1);

			// Connection recovers
			rawPc!.simulateConnectionState('connected');
			assert.equal(session.getSessionInfo().connectionState, 'connected');
			assert.equal(session.getSessionInfo().retryCount, 0);
			assert.equal(session.getSessionInfo().hasFailedAfterRetry, false);

			session.close();
		});
	});
});

