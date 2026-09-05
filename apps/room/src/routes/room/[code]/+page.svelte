<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { signalingClient } from '$lib/signaling/client';
	import { webRtcManager } from '$lib/webrtc';
	import { roomStore, isRoomActive, peerCount } from '$lib/stores/room';
	import { webrtcPeers, openDataChannelsCount, hasFailedPeers } from '$lib/stores/webrtc';
	import { chatStore } from '$lib/stores/chat';
	import { serializeChatMessage, deserializeChatMessage, formatChatLog, downloadChatLog } from '$lib/chat';
	import { FileSender, FileReceiver, isFileChunkPacket, parseFileChunkPacket } from '$lib/transfer';
	import { transferStore } from '$lib/stores/transfer';
	import FileTransfer from '$lib/transfer/FileTransfer.svelte';
	import { validateRoomCode } from '$lib/utils/roomCode';
	import RoomCodeHero from '$lib/room/RoomCodeHero.svelte';
	import RoomTimer from '$lib/room/RoomTimer.svelte';
	import RoomClosingBanner from '$lib/room/RoomClosingBanner.svelte';
	import SecurityInfoPanel from '$lib/room/SecurityInfoPanel.svelte';
	import ConnectionBadge from '$lib/room/ConnectionBadge.svelte';
	import { completedFiles } from '$lib/stores/transfer';
	import { downloadFiles } from '$lib/transfer/archive';
	import type { ServerSignalingMessage } from '$lib/types/signaling';

	const roomCode = $page.params.code || '';
	const isValidCode = validateRoomCode(roomCode);

	let password = $state('');
	let isJoining = $state(false);
	let joinError = $state<string | null>(null);
	let copySuccess = $state(false);
	let signalingEvents = $state<{ time: string; type: string; details: string }[]>([]);
	let unsubMessage: (() => void) | null = null;
	let messageInput = $state('');
	let isSending = $state(false);
	let unsubWebRtcMessage: (() => void) | null = null;
	let fileSender = $state<FileSender | null>(null);
	let fileReceiver = $state<FileReceiver | null>(null);
	let isSecurityInfoOpen = $state(false);
	let isZippingFiles = $state(false);

	const isChatDisabled = $derived($hasFailedPeers && $openDataChannelsCount === 0);
	const chatPlaceholder = $derived(
		isChatDisabled
			? 'Type an encrypted message (No open WebRTC peer connections)...'
			: 'Type an encrypted message...'
	);

	// Expiration countdown
	let now = $state(Math.floor(Date.now() / 1000));
	let timerInterval: ReturnType<typeof setInterval> | null = null;

	let remainingSeconds = $derived.by(() => {
		if (!$roomStore.expiresAt) return null;
		const diff = $roomStore.expiresAt - now;
		return diff > 0 ? diff : 0;
	});

	let closingCountdown = $derived.by(() => {
		if (!$roomStore.closingDeadline) return null;
		const diff = $roomStore.closingDeadline - now;
		return diff > 0 ? diff : 0;
	});

	function formatSeconds(totalSec: number): string {
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	function formatMessageTime(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	async function performJoin(roomPassword?: string) {
		if (!isValidCode) return;
		isJoining = true;
		joinError = null;

		try {
			await signalingClient.joinRoom(roomCode, {
				password: roomPassword ? roomPassword.trim() : undefined
			});
		} catch (err) {
			joinError = err instanceof Error ? err.message : 'Failed to join room';
		} finally {
			isJoining = false;
		}
	}

	function handleJoinSubmit(e: SubmitEvent) {
		e.preventDefault();
		performJoin(password);
	}

	async function handleSendMessage(e?: SubmitEvent) {
		e?.preventDefault();
		const trimmed = messageInput.trim();
		if (!trimmed || isSending || isChatDisabled) return;

		isSending = true;
		const id = typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const sender = $chatStore.username || 'anonymous';
		const timestamp = Date.now();

		if (import.meta.env.DEV) {
			const targetPeers = Array.from(
				new Set([...$roomStore.peers, ...webRtcManager.getSessionPeerIds()])
			);
			const peerStates = targetPeers.map((peerId) => {
				const session = webRtcManager.getSession(peerId);
				return {
					peerId,
					dataChannelState: session?.getSessionInfo().dataChannelState ?? 'none'
				};
			});
			console.debug('[Chat:Sender:Trigger]', {
				targetPeers,
				contentLengthBytes: new TextEncoder().encode(trimmed).byteLength,
				peerStates,
				timestamp: Date.now()
			});
		}

		// Optimistically append local message
		chatStore.addMessage({
			id,
			sender,
			content: trimmed,
			timestamp,
			isSelf: true
		});

		messageInput = '';

		try {
			const payload = serializeChatMessage({
				type: 'chat',
				id,
				sender,
				content: trimmed,
				timestamp
			});
			await webRtcManager.broadcast(payload);
		} catch (err) {
			if (import.meta.env.DEV) {
				console.error('[Chat:Sender:BroadcastError]', {
					error:
						err instanceof Error
							? { name: err.name, message: err.message, stack: err.stack }
							: String(err),
					timestamp: Date.now()
				});
			}
			console.error('Failed to broadcast chat message:', err);
		} finally {
			isSending = false;
		}
	}

	function handleDownloadChatLog() {
		const log = formatChatLog(roomCode, $chatStore.messages);
		const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
		const filename = `chat-log-${roomCode || 'room'}-${timestamp}.txt`;
		downloadChatLog(filename, log);
	}

	async function handleDownloadAllFiles() {
		if ($completedFiles.length === 0 || isZippingFiles) return;
		isZippingFiles = true;
		try {
			await downloadFiles($completedFiles);
		} catch (err) {
			console.error('Failed to bundle files into ZIP:', err);
		} finally {
			isZippingFiles = false;
		}
	}

	async function copyRoomCode() {
		try {
			await navigator.clipboard.writeText(roomCode);
			copySuccess = true;
			setTimeout(() => {
				copySuccess = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy room code:', err);
		}
	}

	async function handleRoomExtended(newExpiresAt: number) {
		try {
			const payload = new TextEncoder().encode(
				JSON.stringify({
					type: 'room-extended',
					expiresAt: newExpiresAt
				})
			);
			await webRtcManager.broadcast(payload);
		} catch (err) {
			console.error('Failed to broadcast room-extended packet:', err);
		}
	}

	function leaveRoom() {
		webRtcManager.disconnectAll();
		signalingClient.disconnect();
		roomStore.reset();
		chatStore.reset();
		transferStore.reset();
		goto('/create');
	}

	onMount(() => {
		chatStore.initUsername();
		webRtcManager.init();
		timerInterval = setInterval(() => {
			now = Math.floor(Date.now() / 1000);
		}, 1000);

		fileSender = new FileSender(webRtcManager, {
			onProgress: (transferId, peerId, progress) => {
				transferStore.updateOutgoingProgress(transferId, peerId, progress);
			}
		});

		fileReceiver = new FileReceiver({
			webRtcManager,
			onTransferOffered: (transfer) => {
				transferStore.addIncomingTransfer(transfer);
			},
			onProgress: (transfer) => {
				transferStore.updateIncomingProgress(transfer);
			},
			onCompleted: (record) => {
				transferStore.addCompletedRecord(record);
			}
		});

		unsubWebRtcMessage = webRtcManager.onMessage((peerId, payload) => {
			if (isFileChunkPacket(payload)) {
				const chunk = parseFileChunkPacket(payload);
				if (chunk && fileReceiver) {
					fileReceiver.handleBinaryChunk(chunk);
				}
				return;
			}

			if (payload.length > 0 && payload[0] === 0x7b) {
				try {
					const jsonStr = new TextDecoder().decode(payload);
					const data = JSON.parse(jsonStr);

					if (data.type === 'chat') {
						const wireMsg = deserializeChatMessage(payload);
						if (import.meta.env.DEV) {
							console.debug('[Chat:Receiver:Deserialize]', {
								peerId,
								success: Boolean(wireMsg),
								messageId: wireMsg?.id ?? null,
								timestamp: Date.now()
							});
						}
						if (wireMsg) {
							chatStore.addMessage({
								id: wireMsg.id,
								sender: wireMsg.sender,
								content: wireMsg.content,
								timestamp: wireMsg.timestamp,
								isSelf: false,
								senderPeerId: peerId
							});
							if (import.meta.env.DEV) {
								console.debug('[Chat:Receiver:StoreAdded]', {
									peerId,
									messageId: wireMsg.id,
									timestamp: Date.now()
								});
							}
						}
					} else if (
						data.type === 'file-meta' ||
						data.type === 'file-complete' ||
						data.type === 'file-cancel'
					) {
						fileReceiver?.handleControlMessage(peerId, data);
					} else if (data.type === 'file-ready') {
						fileSender?.handleControlMessage(peerId, data);
					} else if (data.type === 'room-extended' && typeof data.expiresAt === 'number') {
						roomStore.updateExpiresAt(data.expiresAt);
					}
				} catch {
					// Ignore invalid JSON payload
				}
			}
		});

		if (!isValidCode) {
			return;
		}

		// Handle signaling events for room closure
		const unsubClosed = signalingClient.on('ROOM_CLOSED', () => {
			leaveRoom();
		});

		// Auto-connect if not connected
		if (!signalingClient.isConnected()) {
			signalingClient.connect().catch((err) => {
				console.error('Signaling connection error:', err);
			});
		}

		// Listen to incoming signaling messages for activity feed and WebRTC prep
		unsubMessage = signalingClient.onAnyMessage((msg: ServerSignalingMessage) => {
			const time = new Date().toLocaleTimeString();
			let details = '';

			switch (msg.type) {
				case 'PEER_JOINED':
					details = `Peer connected: ${msg.peer_id || msg.peerId}`;
					break;
				case 'PEER_LEFT':
					details = `Peer disconnected: ${msg.peer_id || msg.peerId}`;
					break;
				case 'SDP_OFFER':
					details = `SDP offer relayed from ${msg.sender_peer_id || msg.senderPeerId}`;
					break;
				case 'SDP_ANSWER':
					details = `SDP answer relayed from ${msg.sender_peer_id || msg.senderPeerId}`;
					break;
				case 'ICE_CANDIDATES':
					details = `ICE candidates relayed from ${msg.sender_peer_id || msg.senderPeerId}`;
					break;
				case 'REKEY':
					details = `Room rekeyed with new salt`;
					break;
				case 'ROOM_CLOSING':
					details = `Room closing grace period started`;
					break;
				case 'ROOM_CLOSED':
					details = `Room closed: ${msg.reason}`;
					break;
				case 'ERROR':
					details = `Error: [${msg.code}] ${msg.message}`;
					break;
				default:
					details = msg.type;
			}

			signalingEvents = [
				{ time, type: msg.type, details },
				...signalingEvents.slice(0, 19)
			];
		});

		// Auto-join if not already connected to this room
		if ($roomStore.code !== roomCode || $roomStore.lifecycle === 'idle') {
			performJoin();
		}
	});

	onDestroy(() => {
		webRtcManager.disconnectAll();
		signalingClient.disconnect();
		roomStore.reset();
		chatStore.reset();
		transferStore.reset();
		if (unsubWebRtcMessage) {
			unsubWebRtcMessage();
		}
		if (timerInterval) {
			clearInterval(timerInterval);
		}
		if (unsubMessage) {
			unsubMessage();
		}
	});
</script>

<svelte:head>
	<title>Room {roomCode} - FastChat</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="min-h-screen bg-[#050608] text-zinc-100 p-3 sm:p-6 flex flex-col items-center font-['Inter',sans-serif] bg-cyber-grid relative overflow-hidden">
	<!-- Background ambient glow -->
	<div class="absolute -top-24 left-1/2 -translate-x-1/2 w-[700px] h-[350px] bg-blue-600/15 blur-[120px] pointer-events-none rounded-full"></div>

	{#if !isValidCode}
		<div class="w-full max-w-lg bg-[#0a0d16]/95 backdrop-blur-xl p-8 sm:p-10 rounded-2xl border border-red-500/40 text-center shadow-[0_0_50px_rgba(0,0,0,0.85)] relative z-10">
			<div class="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400 mx-auto mb-4">
				<svg class="w-6 h-6 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/>
					<line x1="15" y1="9" x2="9" y2="15"/>
					<line x1="9" y1="9" x2="15" y2="15"/>
				</svg>
			</div>
			<h1 class="text-xl font-bold uppercase tracking-tight mb-2 text-white font-['Orbitron',sans-serif]">Invalid Room Code</h1>
			<p class="text-xs text-zinc-400 mb-6 font-mono leading-relaxed">
				The room identifier <code class="bg-[#06080e] px-2.5 py-1 rounded text-red-300 border border-white/5">{roomCode}</code>
				does not conform to the required <code class="text-zinc-200">0000-0000-0000</code> format.
			</p>
			<a
				href="/create"
				class="inline-block py-2.5 px-6 rounded-full bg-white hover:bg-zinc-200 text-black font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)]"
			>
				Return to Room Creation
			</a>
		</div>
	{:else if $roomStore.lifecycle === 'closed'}
		<div class="w-full max-w-lg bg-[#0a0d16]/95 backdrop-blur-xl p-8 sm:p-10 rounded-2xl border border-white/10 text-center shadow-[0_0_50px_rgba(0,0,0,0.85)] relative z-10">
			<div class="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-cyan-400 mx-auto mb-4">
				<svg class="w-6 h-6 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/>
					<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
				</svg>
			</div>
			<h1 class="text-xl font-bold uppercase tracking-tight mb-2 text-white font-['Orbitron',sans-serif]">Room Session Terminated</h1>
			<p class="text-xs text-zinc-400 mb-6 leading-relaxed">
				{$roomStore.closureReason || 'This room has reached expiration or was closed by participants.'}
			</p>
			<button
				onclick={leaveRoom}
				class="py-2.5 px-6 rounded-full bg-white hover:bg-zinc-200 text-black font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] cursor-pointer"
			>
				Create a New Room
			</button>
		</div>
	{:else if !$isRoomActive && joinError && (joinError.includes('INVALID_PASSWORD') || joinError.includes('password'))}
		<div class="w-full max-w-md bg-[#0a0d16]/95 backdrop-blur-xl p-7 sm:p-9 rounded-2xl border border-[#1a2233] shadow-[0_0_60px_rgba(0,0,0,0.85)] relative z-10">
			<div class="text-[10px] uppercase tracking-widest text-cyan-400 font-bold mb-1.5 text-center font-mono">
				SECURITY GATEWAY
			</div>
			<h1 class="text-xl sm:text-2xl font-black uppercase tracking-tight mb-2 text-center text-white font-['Orbitron',sans-serif]">
				Password Required
			</h1>
			<p class="text-xs text-zinc-400 mb-6 text-center">
				Room <span class="text-cyan-300 font-mono font-bold">{roomCode}</span> is protected by an encryption key.
			</p>

			{#if joinError}
				<div role="alert" class="mb-4 p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
					{joinError}
				</div>
			{/if}

			<form onsubmit={handleJoinSubmit} class="space-y-4">
				<div>
					<label for="join-password" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 font-mono">
						Enter Room Password
					</label>
					<input
						id="join-password"
						type="password"
						bind:value={password}
						required
						placeholder="Room password"
						class="w-full px-3.5 py-2.5 rounded-lg bg-[#06080e] border border-[#1e2538] text-zinc-100 text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all"
					/>
				</div>

				<button
					type="submit"
					disabled={isJoining}
					class="w-full min-h-[46px] py-2.5 px-4 rounded-full bg-white hover:bg-zinc-200 active:scale-[0.99] text-black font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] disabled:opacity-50 cursor-pointer"
				>
					{#if isJoining}
						Verifying Password...
					{:else}
						Unlock & Join Room
					{/if}
				</button>
			</form>
		</div>
	{:else if !$isRoomActive}
		<div class="w-full max-w-md bg-[#0a0d16]/95 backdrop-blur-xl p-8 sm:p-10 rounded-2xl border border-[#1a2233] text-center shadow-[0_0_60px_rgba(0,0,0,0.85)] relative z-10">
			{#if joinError}
				<div class="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400 mx-auto mb-4">
					<svg class="w-6 h-6 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"/>
						<line x1="15" y1="9" x2="9" y2="15"/>
						<line x1="9" y1="9" x2="15" y2="15"/>
					</svg>
				</div>
				<h2 class="text-lg font-bold uppercase tracking-tight mb-2 text-white font-['Orbitron',sans-serif]">Unable to Join Session</h2>
				<p class="text-xs text-red-300 mb-6">{joinError}</p>
				<div class="flex items-center justify-center gap-2.5">
					<button
						onclick={() => performJoin(password)}
						class="min-h-[40px] py-2 px-5 rounded-full bg-white hover:bg-zinc-200 text-black text-xs font-bold uppercase transition-all shadow-sm cursor-pointer"
					>
						Retry Connection
					</button>
					<a
						href="/create"
						class="min-h-[40px] py-2 px-5 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-300 border border-white/10 text-xs uppercase flex items-center transition-all"
					>
						Return Home
					</a>
				</div>
			{:else}
				<div class="inline-block w-9 h-9 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-4 shadow-[0_0_15px_rgba(0,229,255,0.3)]"></div>
				<h2 class="text-lg font-bold uppercase tracking-tight text-white font-['Orbitron',sans-serif]">Connecting to Mesh...</h2>
				<p class="text-xs text-zinc-500 font-mono mt-1.5">{roomCode}</p>
			{/if}
		</div>
	{:else}
		<div class="w-full max-w-4xl bg-[#0a0d16]/95 backdrop-blur-xl rounded-2xl border border-[#1a2233] overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.85)] relative z-10">
			<!-- Minimal Chrome Header -->
			<header class="p-3.5 sm:p-4 border-b border-white/5 bg-[#06080e]/90 flex flex-wrap items-center justify-between gap-3">
				<!-- Left: Identity, Connection & Participants -->
				<div class="flex flex-wrap items-center gap-2.5">
					<div class="inline-flex items-center px-3 py-1 rounded-full bg-blue-500/15 border border-blue-500/30 text-[10px] uppercase font-bold text-white tracking-widest font-['Orbitron',sans-serif]">
						FASTCHAT
					</div>

					<ConnectionBadge />

					<div class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-[#0a0d16] border border-white/10 text-[10px] text-zinc-400 uppercase font-semibold font-mono">
						<span>PEERS:</span>
						<strong class="text-cyan-300 tabular-nums">{$peerCount + 1}</strong>
					</div>

					{#if $roomStore.isOwner}
						<span class="inline-flex items-center px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold uppercase font-mono">
							OWNER
						</span>
					{/if}
				</div>

				<!-- Right: Timer, Log Export, Security & Leave Action -->
				<div class="flex items-center gap-2 font-['Inter',sans-serif]">
					<RoomTimer
						expiresAt={$roomStore.expiresAt}
						{roomCode}
						peerId={$roomStore.peerId}
						isOwner={$roomStore.isOwner}
						lifecycle={$roomStore.lifecycle}
						onExtended={handleRoomExtended}
					/>

					<!-- Quick Log Export -->
					<button
						type="button"
						onclick={handleDownloadChatLog}
						class="min-h-[38px] px-3.5 py-1 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-300 hover:text-white border border-white/10 hover:border-blue-500/40 uppercase font-semibold text-xs transition-all cursor-pointer flex items-center gap-1.5"
						title="Export decrypted chat log as .txt"
						aria-label="Download chat log"
					>
						<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
							<polyline points="7 10 12 15 17 10"/>
							<line x1="12" x2="12" y1="15" y2="3"/>
						</svg>
						<span class="hidden sm:inline">LOG</span>
					</button>

					<!-- Security Architecture Modal Trigger -->
					<button
						type="button"
						onclick={() => (isSecurityInfoOpen = true)}
						class="min-h-[38px] px-3.5 py-1 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-300 hover:text-white border border-white/10 hover:border-blue-500/40 uppercase font-semibold text-xs transition-all cursor-pointer flex items-center gap-1.5"
						title="Why FastChat Room is secure"
						aria-label="Security specifications"
					>
						<svg class="w-3.5 h-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
							<path d="m9 12 2 2 4-4"/>
						</svg>
						<span class="hidden sm:inline">SECURITY</span>
					</button>

					<!-- Leave Session -->
					<button
						type="button"
						onclick={leaveRoom}
						class="min-h-[38px] px-4 py-1 rounded-full bg-red-950/30 hover:bg-red-900/50 text-red-400 hover:text-red-200 border border-red-800/40 uppercase font-bold text-xs transition-all cursor-pointer flex items-center gap-1.5"
						title="Leave and disconnect from room"
					>
						<svg class="w-3.5 h-3.5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
							<polyline points="16 17 21 12 16 7"/>
							<line x1="21" x2="9" y1="12" y2="12"/>
						</svg>
						<span class="hidden sm:inline">LEAVE</span>
					</button>
				</div>
			</header>

			<!-- Room Closing 10-Second Grace Warning Banner -->
			{#if $roomStore.lifecycle === 'closing'}
				<div class="p-3.5 sm:p-4 border-b border-red-800/30 bg-[#06080e]">
					<RoomClosingBanner
						countdown={closingCountdown}
						onDownloadChatLog={handleDownloadChatLog}
						onDownloadFiles={handleDownloadAllFiles}
						hasFiles={$completedFiles.length > 0}
						isZipping={isZippingFiles}
					/>
				</div>
			{/if}

			<!-- Room Content Section -->
			<div class="p-4 sm:p-6 space-y-6">
				<!-- Hero Room Code Element -->
				<RoomCodeHero {roomCode} />

				<!-- Participants -->
				<div>
					<h2 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 mb-2.5 font-mono">
						PARTICIPANTS ({$peerCount + 1})
					</h2>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
						<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 text-xs flex items-center justify-between">
							<div class="flex items-center space-x-2">
								<span class="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#00e5ff]"></span>
								<span class="font-mono text-zinc-200">
									{$roomStore.peerId} (You)
								</span>
							</div>
							{#if $roomStore.isOwner}
								<span class="text-[10px] rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 px-2 py-0.5 uppercase font-bold font-mono">
									Owner
								</span>
							{/if}
						</div>
						{#each $roomStore.peers as peer (peer)}
							{@const peerInfo = $webrtcPeers[peer]}
							{@const isConnected = peerInfo?.dataChannelState === 'open'}
							{@const isFailed = peerInfo?.connectionState === 'failed'}
							<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
								<div class="flex items-center space-x-2">
									<span class="w-2 h-2 rounded-full {isConnected ? 'bg-cyan-400 shadow-[0_0_8px_#00e5ff]' : isFailed ? 'bg-red-500 shadow-[0_0_8px_#ef4444]' : 'bg-amber-400 animate-pulse'}"></span>
									<span class="font-mono text-zinc-300">{peer}</span>
								</div>
								<div class="flex items-center gap-2">
									{#if isConnected}
										<span class="text-[10px] text-cyan-300 uppercase font-bold font-mono">Connected</span>
									{:else if isFailed}
										<span class="text-[10px] text-red-400 uppercase font-bold font-mono">Connection Failed</span>
									{:else}
										<span class="text-[10px] text-amber-400 uppercase font-bold animate-pulse font-mono">Connecting...</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- End-to-End Encrypted Chat -->
				<section class="rounded-2xl border border-white/5 bg-[#06080e] overflow-hidden shadow-[0_4px_25px_rgba(0,0,0,0.5)]">
					<div class="p-3.5 bg-[#080b12] border-b border-white/5 flex flex-wrap items-center justify-between gap-2.5">
						<div class="flex items-center space-x-2.5">
							<span class="text-xs font-bold uppercase tracking-wider text-white font-['Orbitron',sans-serif]">ENCRYPTED CHAT</span>
							<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-blue-500/15 text-cyan-300 border border-blue-500/30 font-medium uppercase font-mono">
								AES-256-GCM
							</span>
						</div>
						<div class="flex items-center space-x-3 font-mono">
							<div class="text-[11px] text-zinc-400">
								POSTING AS: <strong class="text-cyan-300 font-bold">{$chatStore.username || '...'}</strong>
							</div>
							<button
								type="button"
								onclick={handleDownloadChatLog}
								class="px-3 py-1 rounded-full text-[11px] bg-[#111624] hover:bg-[#182033] text-zinc-300 border border-white/10 hover:border-cyan-400 uppercase font-semibold transition-all cursor-pointer"
								title="Download decrypted chat log as .txt"
							>
								Download Log
							</button>
						</div>
					</div>

					<!-- Message List -->
					<div class="p-4 sm:p-5 h-72 sm:h-80 overflow-y-auto space-y-3.5 bg-[#030407]/60">
						{#if $chatStore.messages.length === 0}
							<div class="h-full flex items-center justify-center text-xs text-zinc-600 uppercase tracking-widest font-mono">
								NO MESSAGES IN SESSION • P2P CHAT IS LIVE
							</div>
						{:else}
							{#each $chatStore.messages as msg (msg.id)}
								<div class="flex flex-col {msg.isSelf ? 'items-end' : 'items-start'}">
									<div class="flex items-center space-x-1.5 mb-1.5 text-[10px] text-zinc-500 font-mono">
										<span class="font-bold {msg.isSelf ? 'text-cyan-300' : 'text-zinc-400'}">
											{msg.isSelf ? `${msg.sender} (You)` : msg.sender}
										</span>
										<span>•</span>
										<span class="tabular-nums">{formatMessageTime(msg.timestamp)}</span>
									</div>
									<div class="max-w-[85%] sm:max-w-[75%] p-3.5 text-xs sm:text-sm leading-relaxed break-words rounded-2xl {msg.isSelf ? 'rounded-tr-sm bg-blue-600/20 text-white border border-blue-500/30 shadow-[0_2px_15px_rgba(0,102,255,0.1)]' : 'rounded-tl-sm bg-[#0c101c] text-zinc-200 border border-white/10 shadow-[0_2px_10px_rgba(0,0,0,0.5)]'}">
										{msg.content}
									</div>
								</div>
							{/each}
						{/if}
					</div>

					<!-- Chat Input Form -->
					{#if isChatDisabled}
						<div role="alert" class="p-2.5 bg-red-950/20 border-t border-red-500/20 text-red-300 font-mono text-[11px] flex items-center gap-2">
							<svg class="w-3.5 h-3.5 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10"/>
								<line x1="12" y1="8" x2="12" y2="12"/>
								<line x1="12" y1="16" x2="12.01" y2="16"/>
							</svg>
							<span>No open WebRTC peer connections available for chat</span>
						</div>
					{/if}
					<form onsubmit={handleSendMessage} class="p-3 sm:p-3.5 border-t border-white/5 bg-[#080b12] flex items-center space-x-2.5">
						<input
							type="text"
							bind:value={messageInput}
							disabled={isChatDisabled}
							placeholder={chatPlaceholder}
							class="flex-1 px-4 py-2.5 rounded-full bg-[#05070c] border border-[#1e2538] text-zinc-100 text-xs sm:text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all placeholder:text-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed"
							maxlength="4000"
						/>
						<button
							type="submit"
							disabled={!messageInput.trim() || isSending || isChatDisabled}
							class="min-h-[40px] px-6 py-2 rounded-full bg-white hover:bg-zinc-200 disabled:opacity-40 text-black text-xs font-bold uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(255,255,255,0.2)] cursor-pointer disabled:cursor-not-allowed"
						>
							Send
						</button>
					</form>
				</section>

				<!-- End-to-End Encrypted File Transfer -->
				{#if fileSender && fileReceiver}
					<FileTransfer {fileSender} {fileReceiver} username={$chatStore.username || 'anonymous'} />
				{/if}
			</div>
		</div>

		<!-- Security Specifications Modal -->
		<SecurityInfoPanel
			isOpen={isSecurityInfoOpen}
			onClose={() => (isSecurityInfoOpen = false)}
		/>
	{/if}
</main>
