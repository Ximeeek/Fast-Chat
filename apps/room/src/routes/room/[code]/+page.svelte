<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { signalingClient } from '$lib/signaling/client';
	import { webRtcManager } from '$lib/webrtc';
	import { roomStore, isRoomActive, peerCount } from '$lib/stores/room';
	import { chatStore } from '$lib/stores/chat';
	import { serializeChatMessage, deserializeChatMessage } from '$lib/chat';
	import { validateRoomCode } from '$lib/utils/roomCode';
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
			console.error('Failed to broadcast chat message:', err);
		} finally {
			isSending = false;
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

	function leaveRoom() {
		webRtcManager.disconnectAll();
		signalingClient.disconnect();
		roomStore.reset();
		chatStore.reset();
		goto('/create');
	}

	onMount(() => {
		chatStore.initUsername();
		webRtcManager.init();
		timerInterval = setInterval(() => {
			now = Math.floor(Date.now() / 1000);
		}, 1000);

		unsubWebRtcMessage = webRtcManager.onMessage((peerId, payload) => {
			const wireMsg = deserializeChatMessage(payload);
			if (wireMsg) {
				chatStore.addMessage({
					id: wireMsg.id,
					sender: wireMsg.sender,
					content: wireMsg.content,
					timestamp: wireMsg.timestamp,
					isSelf: false,
					senderPeerId: peerId
				});
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

<main class="min-h-screen bg-gray-100 text-gray-900 p-6 flex flex-col items-center">
	{#if !isValidCode}
		<div class="w-full max-w-lg bg-white p-8 rounded-lg shadow border border-red-200 text-center">
			<div class="text-red-500 text-5xl mb-4">?</div>
			<h1 class="text-2xl font-bold mb-2">Invalid Room Code</h1>
			<p class="text-gray-600 mb-6">
				The room code <code class="bg-gray-100 px-2 py-1 rounded text-red-600 font-mono">{roomCode}</code>
				does not conform to the required <code class="font-mono">0000-0000-0000</code> format.
			</p>
			<a
				href="/create"
				class="inline-block py-2.5 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
			>
				Return to Room Creation
			</a>
		</div>
	{:else if $roomStore.lifecycle === 'closed'}
		<div class="w-full max-w-lg bg-white p-8 rounded-lg shadow border border-gray-300 text-center">
			<div class="text-gray-400 text-5xl mb-4">??</div>
			<h1 class="text-2xl font-bold mb-2">Room Closed</h1>
			<p class="text-gray-600 mb-4">
				{$roomStore.closureReason || 'This room has been closed or expired.'}
			</p>
			<button
				onclick={leaveRoom}
				class="py-2.5 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
			>
				Create a New Room
			</button>
		</div>
	{:else if !$isRoomActive && joinError && (joinError.includes('INVALID_PASSWORD') || joinError.includes('password'))}
		<div class="w-full max-w-md bg-white p-8 rounded-lg shadow border border-gray-200">
			<h1 class="text-xl font-bold mb-2 text-center">Password Required</h1>
			<p class="text-sm text-gray-500 mb-6 text-center">
				Room <span class="font-mono font-bold text-gray-800">{roomCode}</span> is protected by a password.
			</p>

			{#if joinError}
				<div role="alert" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded">
					{joinError}
				</div>
			{/if}

			<form onsubmit={handleJoinSubmit} class="space-y-4">
				<div>
					<label for="join-password" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
						Enter Password
					</label>
					<input
						id="join-password"
						type="password"
						bind:value={password}
						required
						placeholder="Room password"
						class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
					/>
				</div>

				<button
					type="submit"
					disabled={isJoining}
					class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors disabled:opacity-50 text-sm"
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
		<div class="w-full max-w-md bg-white p-8 rounded-lg shadow border border-gray-200 text-center">
			{#if joinError}
				<div class="text-red-500 text-4xl mb-3">?</div>
				<h2 class="text-lg font-bold mb-2">Unable to Join Room</h2>
				<p class="text-sm text-red-600 mb-6">{joinError}</p>
				<button
					onclick={() => performJoin(password)}
					class="py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded mr-2"
				>
					Retry
				</button>
				<a
					href="/create"
					class="py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-medium rounded inline-block"
				>
					Return Home
				</a>
			{:else}
				<div class="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent mb-4"></div>
				<h2 class="text-lg font-bold">Connecting to Room...</h2>
				<p class="text-xs text-gray-500 font-mono mt-1">{roomCode}</p>
			{/if}
		</div>
	{:else}
		<div class="w-full max-w-2xl bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
			<!-- Header -->
			<header class="p-6 border-b border-gray-200 flex flex-wrap items-center justify-between gap-4">
				<div>
					<div class="flex items-center space-x-3">
						<h1 class="text-xl font-bold font-mono tracking-wide">{roomCode}</h1>
						<button
							onclick={copyRoomCode}
							class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded border border-gray-300 transition-colors"
						>
							{copySuccess ? 'Copied!' : 'Copy Code'}
						</button>
					</div>
					<div class="flex items-center space-x-2 mt-1">
						<span class="inline-block w-2.5 h-2.5 rounded-full {$roomStore.connectionState === 'connected' ? 'bg-green-500' : 'bg-yellow-500'}"></span>
						<span class="text-xs text-gray-500 uppercase tracking-wider font-semibold">
							{$roomStore.connectionState}
						</span>
						{#if $roomStore.isOwner}
							<span class="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-medium">Room Owner</span>
						{/if}
					</div>
				</div>

				<div class="flex items-center space-x-4">
					{#if remainingSeconds !== null}
						<div class="text-right">
							<div class="text-xs text-gray-500 uppercase font-semibold">Expires In</div>
							<div class="text-lg font-mono font-bold {remainingSeconds < 120 ? 'text-red-600' : 'text-gray-800'}">
								{formatSeconds(remainingSeconds)}
							</div>
						</div>
					{/if}

					<button
						onclick={leaveRoom}
						class="py-2 px-3 text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 font-medium rounded transition-colors"
					>
						Leave Room
					</button>
				</div>
			</header>

			<!-- Room Closing Alert -->
			{#if $roomStore.lifecycle === 'closing'}
				<div role="alert" class="p-4 bg-yellow-50 border-b border-yellow-200 text-yellow-800 text-sm flex items-center justify-between">
					<span>
						<strong>Room Expiring:</strong> This room has entered its closing grace period.
					</span>
					{#if closingCountdown !== null}
						<span class="font-mono font-bold text-red-600">
							Closing in: {closingCountdown}s
						</span>
					{/if}
				</div>
			{/if}

			<!-- Room Content Section -->
			<div class="p-6 space-y-6">
				<!-- Participants -->
				<div>
					<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-3">
						Participants ({$peerCount + 1})
					</h2>
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<div class="p-3 bg-blue-50 border border-blue-100 rounded text-sm flex items-center justify-between">
							<span class="font-mono text-xs text-blue-900 font-medium">
								{$roomStore.peerId} (You)
							</span>
							{#if $roomStore.isOwner}
								<span class="text-xs bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded">Owner</span>
							{/if}
						</div>
						{#each $roomStore.peers as peer (peer)}
							<div class="p-3 bg-gray-50 border border-gray-200 rounded text-sm flex items-center justify-between">
								<span class="font-mono text-xs text-gray-800">{peer}</span>
								<span class="text-xs text-green-600 font-medium">Connected</span>
							</div>
						{/each}
					</div>
				</div>

				<!-- End-to-End Encrypted Chat -->
				<section class="border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm">
					<div class="p-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
						<div class="flex items-center space-x-2">
							<h2 class="text-xs font-semibold uppercase tracking-wider text-gray-700">Encrypted Chat</h2>
							<span class="text-xs px-2 py-0.5 bg-green-100 text-green-800 rounded-full font-medium">AES-256-GCM</span>
						</div>
						<div class="text-xs text-gray-500">
							Posting as: <strong class="font-mono text-gray-800">{$chatStore.username || '...'}</strong>
						</div>
					</div>

					<!-- Message List -->
					<div class="p-4 h-64 overflow-y-auto space-y-3 bg-gray-50/50">
						{#if $chatStore.messages.length === 0}
							<div class="h-full flex items-center justify-center text-xs text-gray-400 italic">
								No messages yet. Send a message to chat across WebRTC peers.
							</div>
						{:else}
							{#each $chatStore.messages as msg (msg.id)}
								<div class="flex flex-col {msg.isSelf ? 'items-end' : 'items-start'}">
									<div class="flex items-center space-x-1 mb-1 text-[11px] text-gray-500">
										<span class="font-mono font-medium {msg.isSelf ? 'text-blue-700' : 'text-gray-700'}">
											{msg.isSelf ? `${msg.sender} (You)` : msg.sender}
										</span>
										<span>•</span>
										<span>{formatMessageTime(msg.timestamp)}</span>
									</div>
									<div class="max-w-[80%] rounded px-3 py-2 text-sm break-words shadow-sm {msg.isSelf ? 'bg-blue-600 text-white' : 'bg-white text-gray-800 border border-gray-200'}">
										{msg.content}
									</div>
								</div>
							{/each}
						{/if}
					</div>

					<!-- Chat Input Form -->
					<form onsubmit={handleSendMessage} class="p-3 border-t border-gray-200 bg-white flex items-center space-x-2">
						<input
							type="text"
							bind:value={messageInput}
							placeholder="Type an encrypted message..."
							class="flex-1 px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
							maxlength="4000"
						/>
						<button
							type="submit"
							disabled={!messageInput.trim() || isSending}
							class="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
						>
							Send
						</button>
					</form>
				</section>

				<!-- Signaling Activity Feed (WebRTC readiness verification) -->
				<div>
					<h2 class="text-sm font-semibold uppercase tracking-wider text-gray-500 mb-2">
						Signaling Activity
					</h2>
					<div class="bg-gray-900 text-gray-100 p-4 rounded text-xs font-mono max-h-48 overflow-y-auto space-y-1">
						{#if signalingEvents.length === 0}
							<div class="text-gray-500">Awaiting signaling events...</div>
						{:else}
							{#each signalingEvents as event, i (i)}
								<div class="flex items-start space-x-2">
									<span class="text-gray-500">[{event.time}]</span>
									<span class="text-blue-400 font-bold">{event.type}:</span>
									<span class="text-gray-300">{event.details}</span>
								</div>
							{/each}
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}
</main>
