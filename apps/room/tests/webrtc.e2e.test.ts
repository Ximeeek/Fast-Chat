import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium, type Browser } from 'playwright';
import { build } from 'vite';

describe('WebRTC Real Two-Browser E2E Integration (Playwright)', () => {
	let server: http.Server;
	let localUrl: string;
	let bundleCode: string;
	let browser: Browser;

	before(async () => {
		// 1. Start ephemeral HTTP server on 127.0.0.1 to provide a standard W3C Secure Context
		// for window.crypto.subtle and RTCPeerConnection inside headless Chromium contexts.
		server = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<!DOCTYPE html><html><head><title>WebRTC E2E</title></head><body></body></html>');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Invalid server address');
		localUrl = `http://127.0.0.1:${address.port}`;

		// 2. Compile WebRTC mesh session and cryptographic modules into a self-contained IIFE bundle
		const buildResult = await build({
			configFile: false,
			build: {
				lib: {
					entry: 'src/lib/webrtc/index.ts',
					formats: ['iife'],
					name: 'FastChatWebRtc'
				},
				write: false
			}
		});

		const code = (buildResult as any)[0]?.output?.[0]?.code;
		if (!code) {
			throw new Error('Failed to compile WebRTC bundle using Vite');
		}
		bundleCode = code;

		// 3. Launch headless Edge/Chromium with loopback enabled for deterministic local ICE resolution
		browser = await chromium.launch({
			executablePath: 'C:\\Program Files (x86)\\Microsoft\\EdgeCore\\152.0.4191.62\\msedge.exe',
			headless: true,
			args: [
				'--no-sandbox',
				'--allow-loopback-in-peer-connection'
			]
		});
	});

	after(async () => {
		if (browser) {
			await browser.close();
		}
		if (server) {
			server.close();
		}
	});

	test('two real browser contexts establish RTCDataChannel and exchange AES-256-GCM encrypted chunks', async (t) => {
		// Enforce a strict 15-second timeout to guarantee deterministic test execution
		const timeout = setTimeout(() => {
			assert.fail('E2E WebRTC test timed out after 15 seconds');
		}, 15000);

		try {
			// 1. Create two isolated browser contexts representing separate participants
			const ctx1 = await browser.newContext();
			const ctx2 = await browser.newContext();
			const p1 = await ctx1.newPage();
			const p2 = await ctx2.newPage();

			// 2. Navigate to local secure context and evaluate the bundled WebRTC/crypto subsystem
			await p1.goto(localUrl);
			await p2.goto(localUrl);
			await p1.evaluate((code) => { (0, eval)(code); }, bundleCode);
			await p2.evaluate((code) => { (0, eval)(code); }, bundleCode);

			// 3. Establish cross-context signaling channel via Playwright exposed functions
			await p1.exposeFunction('signalToP2', async (msg: any) => {
				await p2.evaluate(async (m) => {
					if (m.type === 'offer') {
						const ans = await (window as any).session.handleRemoteOffer(m.sdp);
						if (ans) {
							await (window as any).signalToP1({ type: 'answer', sdp: ans });
						}
					} else if (m.type === 'cand') {
						await (window as any).session.addRemoteIceCandidate(m.cand);
					}
				}, msg);
			});

			await p2.exposeFunction('signalToP1', async (msg: any) => {
				await p1.evaluate(async (m) => {
					if (m.type === 'answer') {
						await (window as any).session.handleRemoteAnswer(m.sdp);
					} else if (m.type === 'cand') {
						await (window as any).session.addRemoteIceCandidate(m.cand);
					}
				}, msg);
			});

			// 4. Initialize Peer 2 (polite responder) with a shared 256-bit AES-GCM room key
			await p2.evaluate(async () => {
				const { PeerConnectionSession } = (window as any).FastChatWebRtc;
				(window as any).__receivedMessages = [];

				const rawKey = new Uint8Array(32);
				crypto.getRandomValues(rawKey);
				(window as any).__testKey = await crypto.subtle.importKey(
					'raw',
					rawKey,
					{ name: 'AES-GCM', length: 256 },
					true,
					['encrypt', 'decrypt']
				);

				(window as any).session = new PeerConnectionSession({
					localPeerId: 'peer-2',
					remotePeerId: 'peer-1',
					isInitiator: false,
					iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
					activeKey: (window as any).__testKey,
					onIceCandidate: (cand: any) => (window as any).signalToP1({ type: 'cand', cand }),
					onMessage: (payload: Uint8Array) => {
						const text = new TextDecoder().decode(payload);
						(window as any).__receivedMessages.push(text);
					}
				});

				(window as any).__rawKeyHex = Array.from(rawKey)
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
			});

			const rawKeyHex = await p2.evaluate(() => (window as any).__rawKeyHex);

			// 5. Initialize Peer 1 (impolite initiator) with the identical cryptographic room key
			await p1.evaluate(async (hex) => {
				const { PeerConnectionSession } = (window as any).FastChatWebRtc;
				(window as any).__p1ReceivedMessages = [];

				const rawKey = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte: string) => parseInt(byte, 16)));
				(window as any).__testKey = await crypto.subtle.importKey(
					'raw',
					rawKey,
					{ name: 'AES-GCM', length: 256 },
					true,
					['encrypt', 'decrypt']
				);

				(window as any).session = new PeerConnectionSession({
					localPeerId: 'peer-1',
					remotePeerId: 'peer-2',
					isInitiator: true,
					iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
					activeKey: (window as any).__testKey,
					onIceCandidate: (cand: any) => (window as any).signalToP2({ type: 'cand', cand }),
					onMessage: (payload: Uint8Array) => {
						const text = new TextDecoder().decode(payload);
						(window as any).__p1ReceivedMessages.push(text);
					}
				});
			}, rawKeyHex);

			// 6. Initiate SDP offer/answer negotiation from Peer 1
			await p1.evaluate(async () => {
				const offer = await (window as any).session.createInitialOffer();
				await (window as any).signalToP2({ type: 'offer', sdp: offer });
			});

			// 7. Poll until binary RTCDataChannel readyState reaches 'open' on both browser instances
			let channelsOpen = false;
			for (let i = 0; i < 40; i++) {
				const [s1, s2] = await Promise.all([
					p1.evaluate(() => (window as any).session.getSessionInfo()),
					p2.evaluate(() => (window as any).session.getSessionInfo())
				]);

				if (s1.dataChannelState === 'open' && s2.dataChannelState === 'open') {
					channelsOpen = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 150));
			}

			assert.equal(channelsOpen, true, 'RTCDataChannel must reach open state on both browser peers');

			// 8. Send outbound encrypted chunk from Peer 1 -> Peer 2 via AES-256-GCM
			const outboundPayload = 'Confidential payload: Browser 1 -> Browser 2';
			await p1.evaluate(async (msg) => {
				await (window as any).session.send(msg);
			}, outboundPayload);

			// 9. Verify decryption on Peer 2
			let peer2Received = false;
			for (let i = 0; i < 20; i++) {
				const msgs = await p2.evaluate(() => (window as any).__receivedMessages);
				if (msgs && msgs.includes(outboundPayload)) {
					peer2Received = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(peer2Received, true, 'Peer 2 must successfully receive and decrypt chunk from Peer 1');

			// 10. Send reverse encrypted chunk from Peer 2 -> Peer 1 via AES-256-GCM
			const returnPayload = 'Acknowledge payload: Browser 2 -> Browser 1';
			await p2.evaluate(async (msg) => {
				await (window as any).session.send(msg);
			}, returnPayload);

			// 11. Verify decryption on Peer 1
			let peer1Received = false;
			for (let i = 0; i < 20; i++) {
				const msgs = await p1.evaluate(() => (window as any).__p1ReceivedMessages);
				if (msgs && msgs.includes(returnPayload)) {
					peer1Received = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			assert.equal(peer1Received, true, 'Peer 1 must successfully receive and decrypt return chunk from Peer 2');

			// 12. Verify connection type stats detection (direct host/srflx topology)
			const [type1, type2] = await Promise.all([
				p1.evaluate(() => (window as any).session.getSessionInfo().connectionType),
				p2.evaluate(() => (window as any).session.getSessionInfo().connectionType)
			]);
			assert.equal(type1, 'direct', 'Peer 1 connection topology should be detected as direct');
			assert.equal(type2, 'direct', 'Peer 2 connection topology should be detected as direct');

			await ctx1.close();
			await ctx2.close();
		} finally {
			clearTimeout(timeout);
		}
	});
});
