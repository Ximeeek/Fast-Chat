<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { signalingClient } from '$lib/signaling/client';
	import { webRtcManager } from '$lib/webrtc';
	import { roomStore, isRoomActive, peerCount } from '$lib/stores/room';
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
		if (!trimmed || isSending) return;

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

<main class="min-h-screen bg-[#0a0a0a] text-zinc-100 p-3 sm:p-6 flex flex-col items-center font-mono">
	{#if !isValidCode}
		<div class="w-full max-w-lg bg-[#121212] p-8 border border-red-800 text-center">
			<div class="text-red-500 text-4xl mb-3">✕</div>
			<h1 class="text-xl font-bold uppercase tracking-tight mb-2">Invalid Room Code</h1>
			<p class="text-xs text-zinc-400 mb-6">
				The room identifier <code class="bg-black px-2 py-1 text-red-400 border border-[#262626]">{roomCode}</code>
				does not conform to the required <code class="text-zinc-200">0000-0000-0000</code> format.
			</p>
			<a
				href="/create"
				class="inline-block py-2.5 px-6 bg-[#ccff00] hover:bg-[#b8e600] text-black font-bold uppercase text-xs transition-micro"
			>
				Return to Room Creation
			</a>
		</div>
	{:else if $roomStore.lifecycle === 'closed'}
		<div class="w-full max-w-lg bg-[#121212] p-8 border border-[#262626] text-center">
			<div class="text-zinc-500 text-4xl mb-3">⚰</div>
			<h1 class="text-xl font-bold uppercase tracking-tight mb-2">Room Session Terminated</h1>
			<p class="text-xs text-zinc-400 mb-6">
				{$roomStore.closureReason || 'This room has reached expiration or was closed by participants.'}
			</p>
			<button
				onclick={leaveRoom}
				class="py-2.5 px-6 bg-[#ccff00] hover:bg-[#b8e600] text-black font-bold uppercase text-xs transition-micro cursor-pointer"
			>
				Create a New Room
			</button>
		</div>
	{:else if !$isRoomActive && joinError && (joinError.includes('INVALID_PASSWORD') || joinError.includes('password'))}
		<div class="w-full max-w-md bg-[#121212] p-6 sm:p-8 border border-[#262626]">
			<div class="text-[10px] uppercase tracking-widest text-[#ccff00] font-bold mb-1 text-center">SECURITY GATEWAY</div>
			<h1 class="text-xl font-bold uppercase tracking-tight mb-2 text-center">Password Required</h1>
			<p class="text-xs text-zinc-400 mb-6 text-center">
				Room <span class="text-zinc-200 font-bold">{roomCode}</span> is protected by an encryption key.
			</p>

			{#if joinError}
				<div role="alert" class="mb-4 p-3 bg-red-950/40 border border-red-800 text-red-400 text-xs">
					{joinError}
				</div>
			{/if}

			<form onsubmit={handleJoinSubmit} class="space-y-4">
				<div>
					<label for="join-password" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
						Enter Room Password
					</label>
					<input
						id="join-password"
						type="password"
						bind:value={password}
						required
						placeholder="Room password"
						class="w-full px-3 py-2.5 bg-black border border-[#262626] text-zinc-100 text-sm focus:outline-none focus:border-[#ccff00]"
					/>
				</div>

				<button
					type="submit"
					disabled={isJoining}
					class="w-full min-h-[44px] py-2.5 px-4 bg-[#ccff00] hover:bg-[#b8e600] text-black font-bold uppercase text-xs transition-micro disabled:opacity-50 cursor-pointer"
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
		<div class="w-full max-w-md bg-[#121212] p-8 border border-[#262626] text-center">
			{#if joinError}
				<div class="text-red-500 text-3xl mb-3">✕</div>
				<h2 class="text-lg font-bold uppercase tracking-tight mb-2">Unable to Join Session</h2>
				<p class="text-xs text-red-400 mb-6">{joinError}</p>
				<div class="flex items-center justify-center gap-2">
					<button
						onclick={() => performJoin(password)}
						class="min-h-[40px] py-2 px-4 bg-[#ccff00] hover:bg-[#b8e600] text-black text-xs font-bold uppercase transition-micro cursor-pointer"
					>
						Retry Connection
					</button>
					<a
						href="/create"
						class="min-h-[40px] py-2 px-4 bg-black hover:bg-[#1a1a1a] text-zinc-300 border border-[#262626] text-xs uppercase flex items-center transition-micro"
					>
						Return Home
					</a>
				</div>
			{:else}
				<div class="inline-block w-8 h-8 border-2 border-[#ccff00] border-t-transparent animate-spin mb-4"></div>
				<h2 class="text-lg font-bold uppercase tracking-tight">Connecting to Mesh...</h2>
				<p class="text-xs text-zinc-500 font-mono mt-1">{roomCode}</p>
			{/if}
		</div>
	{:else}
		<div class="w-full max-w-4xl bg-[#0a0a0a] border border-[#262626] overflow-hidden">
			<!-- Minimal Chrome Header -->
			<header class="p-3 sm:p-4 border-b border-[#262626] bg-[#121212] flex flex-wrap items-center justify-between gap-3">
				<!-- Left: Identity, Connection & Participants -->
				<div class="flex flex-wrap items-center gap-2">
					<div class="inline-flex items-center px-2 py-1 bg-black border border-[#262626] text-[10px] uppercase font-bold text-white tracking-wider">
						FASTCHAT
					</div>

					<ConnectionBadge />

					<div class="inline-flex items-center space-x-1.5 px-2 py-1 bg-black border border-[#262626] text-[10px] text-zinc-400 uppercase font-semibold">
						<span>PEERS:</span>
						<strong class="text-zinc-200 tabular-nums">{$peerCount + 1}</strong>
					</div>

					{#if $roomStore.isOwner}
						<span class="inline-flex items-center px-1.5 py-1 bg-black text-[#ccff00] border border-[#262626] text-[10px] font-bold uppercase">
							OWNER
						</span>
					{/if}
				</div>

				<!-- Right: Timer, Log Export, Security & Leave Action -->
				<div class="flex items-center gap-2">
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
						class="min-h-[38px] px-2.5 py-1 bg-black hover:bg-[#1c1c1c] text-zinc-300 border border-[#262626] hover:border-zinc-500 uppercase font-semibold text-xs transition-micro cursor-pointer flex items-center gap-1.5"
						title="Export decrypted chat log as .txt"
						aria-label="Download chat log"
					>
						<span>⤓</span>
						<span class="hidden sm:inline">LOG</span>
					</button>

					<!-- Security Architecture Modal Trigger -->
					<button
						type="button"
						onclick={() => (isSecurityInfoOpen = true)}
						class="min-h-[38px] px-2.5 py-1 bg-black hover:bg-[#1c1c1c] text-zinc-300 border border-[#262626] hover:border-zinc-500 uppercase font-semibold text-xs transition-micro cursor-pointer flex items-center gap-1.5"
						title="Why FastChat Room is secure"
						aria-label="Security specifications"
					>
						<span>🛡</span>
						<span class="hidden sm:inline">SECURITY</span>
					</button>

					<!-- Leave Session -->
					<button
						type="button"
						onclick={leaveRoom}
						class="min-h-[38px] px-3 py-1 bg-black hover:bg-red-950/40 text-red-400 border border-[#262626] hover:border-red-800 uppercase font-bold text-xs transition-micro cursor-pointer flex items-center gap-1"
						title="Leave and disconnect from room"
					>
						<span>✕</span>
						<span class="hidden sm:inline">LEAVE</span>
					</button>
				</div>
			</header>

			<!-- Room Closing 10-Second Grace Warning Banner -->
			{#if $roomStore.lifecycle === 'closing'}
				<div class="p-3 sm:p-4 border-b border-[#262626] bg-black">
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
					<h2 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 mb-2.5">
						PARTICIPANTS ({$peerCount + 1})
					</h2>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div class="p-3 bg-[#121212] border border-[#262626] text-xs flex items-center justify-between">
							<span class="font-mono text-zinc-200">
								{$roomStore.peerId} (You)
							</span>
							{#if $roomStore.isOwner}
								<span class="text-[10px] bg-black text-[#ccff00] border border-[#262626] px-1.5 py-0.5 uppercase font-bold">
									Owner
								</span>
							{/if}
						</div>
						{#each $roomStore.peers as peer (peer)}
							<div class="p-3 bg-[#121212] border border-[#262626] text-xs flex items-center justify-between">
								<span class="font-mono text-zinc-300">{peer}</span>
								<span class="text-[10px] text-[#ccff00] uppercase font-bold">Connected</span>
							</div>
						{/each}
					</div>
				</div>

				<!-- End-to-End Encrypted Chat -->
				<section class="border border-[#262626] bg-[#121212] overflow-hidden">
					<div class="p-3 bg-black border-b border-[#262626] flex flex-wrap items-center justify-between gap-2">
						<div class="flex items-center space-x-2">
							<span class="text-xs font-bold uppercase tracking-wider text-zinc-200">ENCRYPTED CHAT</span>
							<span class="text-[10px] px-2 py-0.5 bg-[#121212] text-[#ccff00] border border-[#262626] font-medium uppercase">
								AES-256-GCM
							</span>
						</div>
						<div class="flex items-center space-x-3">
							<div class="text-[11px] text-zinc-400">
								POSTING AS: <strong class="font-mono text-zinc-200">{$chatStore.username || '...'}</strong>
							</div>
							<button
								type="button"
								onclick={handleDownloadChatLog}
								class="px-2.5 py-1 text-[11px] bg-black hover:bg-[#1c1c1c] text-zinc-300 border border-[#262626] hover:border-zinc-500 uppercase font-semibold transition-micro cursor-pointer"
								title="Download decrypted chat log as .txt"
							>
								Download Log
							</button>
						</div>
					</div>

					<!-- Message List -->
					<div class="p-4 h-72 overflow-y-auto space-y-3 bg-black/50">
						{#if $chatStore.messages.length === 0}
							<div class="h-full flex items-center justify-center text-xs text-zinc-600 uppercase tracking-wider">
								NO MESSAGES IN SESSION // P2P CHAT IS LIVE
							</div>
						{:else}
							{#each $chatStore.messages as msg (msg.id)}
								<div class="flex flex-col {msg.isSelf ? 'items-end' : 'items-start'}">
									<div class="flex items-center space-x-1.5 mb-1 text-[10px] text-zinc-500">
										<span class="font-mono font-bold {msg.isSelf ? 'text-[#ccff00]' : 'text-zinc-400'}">
											{msg.isSelf ? `${msg.sender} (You)` : msg.sender}
										</span>
										<span>•</span>
										<span class="tabular-nums">{formatMessageTime(msg.timestamp)}</span>
									</div>
									<div class="max-w-[85%] sm:max-w-[75%] p-3 text-xs leading-relaxed break-words {msg.isSelf ? 'bg-[#18181b] text-zinc-100 border border-[#3f3f46]' : 'bg-[#121212] text-zinc-200 border border-[#262626]'}">
										{msg.content}
									</div>
								</div>
							{/each}
						{/if}
					</div>

					<!-- Chat Input Form -->
					<form onsubmit={handleSendMessage} class="p-3 border-t border-[#262626] bg-black flex items-center space-x-2">
						<input
							type="text"
							bind:value={messageInput}
							placeholder="Type an encrypted message..."
							class="flex-1 px-3 py-2.5 bg-[#121212] border border-[#262626] text-zinc-100 text-xs focus:outline-none focus:border-[#ccff00]"
							maxlength="4000"
						/>
						<button
							type="submit"
							disabled={!messageInput.trim() || isSending}
							class="min-h-[38px] px-5 py-2 bg-[#ccff00] hover:bg-[#b8e600] disabled:opacity-40 text-black text-xs font-bold uppercase tracking-wider transition-micro cursor-pointer disabled:cursor-not-allowed"
						>
							Send
						</button>
					</form>
				</section>

				<!-- End-to-End Encrypted File Transfer -->
				{#if fileSender && fileReceiver}
					<FileTransfer {fileSender} {fileReceiver} username={$chatStore.username || 'anonymous'} />
				{/if}

				<!-- Compact Security Info Box -->
				<aside class="p-3.5 bg-[#121212] border border-[#262626] space-y-2">
					<div class="flex items-center justify-between">
						<div class="flex items-center space-x-2">
							<span class="text-[10px] font-bold uppercase tracking-widest text-[#ccff00]">
								ZERO PERSISTENCE ARCHITECTURE
							</span>
							<span class="text-[9px] px-1.5 py-0.5 bg-black border border-[#262626] text-zinc-400 uppercase">
								AUDITED
							</span>
						</div>
						<button
							type="button"
							onclick={() => (isSecurityInfoOpen = true)}
							class="text-[10px] text-[#ccff00] hover:underline uppercase font-bold tracking-wider cursor-pointer"
						>
							[ VIEW FULL SPECS ]
						</button>
					</div>
					<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[10px] text-zinc-400">
						<div class="p-2 bg-black border border-[#1f1f23]">
							<div class="text-zinc-200 font-bold uppercase">ZERO LOGS</div>
							<div class="text-zinc-500 mt-0.5">RAM-only relay</div>
						</div>
						<div class="p-2 bg-black border border-[#1f1f23]">
							<div class="text-zinc-200 font-bold uppercase">E2E ENCRYPTED</div>
							<div class="text-zinc-500 mt-0.5">AES-256-GCM</div>
						</div>
						<div class="p-2 bg-black border border-[#1f1f23]">
							<div class="text-zinc-200 font-bold uppercase">AUTO-DELETION</div>
							<div class="text-zinc-500 mt-0.5">Purged on expiry</div>
						</div>
						<div class="p-2 bg-black border border-[#1f1f23]">
							<div class="text-zinc-200 font-bold uppercase">NO ACCOUNTS</div>
							<div class="text-zinc-500 mt-0.5">Zero stored tokens</div>
						</div>
					</div>
				</aside>
			</div>
		</div>

		<!-- Security Specifications Modal -->
		<SecurityInfoPanel
			isOpen={isSecurityInfoOpen}
			onClose={() => (isSecurityInfoOpen = false)}
		/>
	{/if}
</main>
