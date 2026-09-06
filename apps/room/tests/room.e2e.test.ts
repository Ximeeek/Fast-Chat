import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

import { createServer, type ViteDevServer } from 'vite';

const SIGNALING_PORT = 3000;
const VITE_PORT = 5178;
const WS_URL = `ws://127.0.0.1:${SIGNALING_PORT}/ws`;
const HTTP_URL = `http://127.0.0.1:${SIGNALING_PORT}`;
const APP_URL = `http://127.0.0.1:${VITE_PORT}`;

describe('Full Application E2E: Two Browsers Same-Host WebRTC Flow', () => {
	let signalingProcess: ChildProcess;
	let viteServer: ViteDevServer;
	let browser: Browser;

	before(async () => {
		// 1. Spawn local signaling server on default port 3000
		const signalingExe = existsSync(
			join(process.cwd(), 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe')
		)
			? join(process.cwd(), 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe')
			: join(process.cwd(), '..', '..', 'services', 'signaling', 'target', 'debug', 'fastchat-signaling.exe');

		signalingProcess = spawn(signalingExe, [], {
			env: {
				...process.env,
				PORT: String(SIGNALING_PORT),
				HOST: '127.0.0.1',
				RUST_LOG: 'info'
			},
			stdio: 'pipe'
		});

		// Wait for signaling server health check
		let signalingReady = false;
		for (let i = 0; i < 50; i++) {
			try {
				const res = await fetch(`${HTTP_URL}/health`);
				if (res.ok) {
					signalingReady = true;
					break;
				}
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		if (!signalingReady) {
			throw new Error('Signaling server failed to start within timeout');
		}

		// 2. Start Vite dev server in-process on port 5178
		viteServer = await createServer({
			server: {
				port: VITE_PORT,
				host: '127.0.0.1'
			}
		});
		await viteServer.listen();

		// 3. Launch headless Chromium with loopback peer connection enabled
		const customExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
		browser = await chromium.launch({
			...(customExecutablePath ? { executablePath: customExecutablePath } : {}),
			headless: true,
			args: ['--no-sandbox', '--allow-loopback-in-peer-connection']
		});
	});

	after(async () => {
		if (browser) {
			await browser.close();
		}
		if (viteServer) {
			await viteServer.close();
		}
		if (signalingProcess) {
			signalingProcess.kill('SIGTERM');
		}
	});

	test('two browser contexts join room, establish WebRTC P2P, exchange chat and initiate file transfer without error', async () => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();

		try {
			const page1 = await ctx1.newPage();
			const page2 = await ctx2.newPage();

			page1.on('console', (msg) => console.log('[BROWSER 1]', msg.type(), msg.text()));
			page2.on('console', (msg) => console.log('[BROWSER 2]', msg.type(), msg.text()));

			// 1. Page 1 creates a new room via /create
			await page1.goto(`${APP_URL}/create`);
			await page1.waitForSelector('button:has-text("Create New Room")', { timeout: 10000 });
			await page1.click('button:has-text("Create New Room")');

			// Wait for navigation to /room/[code]
			await page1.waitForURL(/\/room\/\d{4}-\d{4}-\d{4}/, { timeout: 10000 });
			const page1Url = page1.url();
			const roomCodeMatch = page1Url.match(/\d{4}-\d{4}-\d{4}/);
			assert.ok(roomCodeMatch, 'Expected room code in URL');
			const roomCode = roomCodeMatch[0];

			// Wait for Page 1 active room interface
			await page1.waitForSelector('input[placeholder*="Type an encrypted message"]', {
				timeout: 10000
			});

			// 2. Page 2 opens the room directly: /room/[code]
			await page2.goto(`${APP_URL}/room/${roomCode}`);

			// Verify Symptom 1 is resolved: Page 2 must NOT show "Unable to Join Session" or "WebSocket is not connected"
			const joinError = await page2
				.waitForSelector('h2:has-text("Unable to Join Session")', { timeout: 1500 })
				.catch(() => null);
			assert.equal(joinError, null, 'Page 2 should not fail with "Unable to Join Session"');

			// Page 2 must transition to active room interface
			await page2.waitForSelector('input[placeholder*="Type an encrypted message"]', {
				timeout: 15000
			});

			// 3. Verify WebRTC peer connection establishes between Page 1 and Page 2
			await Promise.all([
				page1.waitForSelector('div[title*="(1 data channels open)"]', { timeout: 15000 }),
				page2.waitForSelector('div[title*="(1 data channels open)"]', { timeout: 15000 }),
				page1.waitForSelector('text=Connected', { timeout: 15000 }),
				page2.waitForSelector('text=Connected', { timeout: 15000 })
			]);

			// 4. Test bidirectional E2E encrypted chat over WebRTC DataChannel
			// Page 1 sends message to Page 2
			const msgFrom1 = `Hello from Peer 1 at ${Date.now()}`;
			await page1.fill('input[placeholder*="Type an encrypted message"]', msgFrom1);
			await page1.click('button[type="submit"]:has-text("Send")');

			// Page 2 receives message
			await page2.waitForSelector(`text=${msgFrom1}`, { timeout: 10000 });

			// Page 2 sends message back to Page 1
			const msgFrom2 = `Hello from Peer 2 at ${Date.now()}`;
			await page2.fill('input[placeholder*="Type an encrypted message"]', msgFrom2);
			await page2.click('button[type="submit"]:has-text("Send")');

			// Page 1 receives message
			await page1.waitForSelector(`text=${msgFrom2}`, { timeout: 10000 });

			// 5. Test File Transfer over WebRTC DataChannel
			// Page 1 initiates file transfer with a synthetic test file
			const fileInput = await page1.waitForSelector('input[type="file"]', { timeout: 5000 });
			assert.ok(fileInput, 'File input element should be present');

			await fileInput.setInputFiles({
				name: 'fastchat-e2e-payload.bin',
				mimeType: 'application/octet-stream',
				buffer: Buffer.from('FASTCHAT_E2E_PAYLOAD_BINARY_DATA_TEST_12345')
			});

			// Click Send Files button
			const sendFileBtn = await page1.waitForSelector('button:has-text("Send 1 file")', {
				timeout: 5000
			});
			await sendFileBtn.click();

			// Assert no "No open WebRTC peer connections available for file transfer" error on Page 1
			const fileSendError = await page1.$('div[role="alert"]:has-text("No open WebRTC")');
			assert.equal(fileSendError, null, 'File transfer should not fail with "No open WebRTC peer connections"');

			// Page 2 must receive the incoming transfer offer for fastchat-e2e-payload.bin
			await page2.waitForSelector('text=fastchat-e2e-payload.bin', { timeout: 10000 });
		} finally {
			await ctx1.close();
			await ctx2.close();
		}
	});
});
