<script lang="ts">
	import { goto } from '$app/navigation';
	import { signalingClient } from '$lib/signaling/client';
	import { roomStore } from '$lib/stores/room';
	import { formatRoomCodeInput, validateRoomCode } from '$lib/utils/roomCode';

	let enablePassword = $state(false);
	let password = $state('');
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);

	// Join existing room form state
	let manualCode = $state('');
	let joinError = $state<string | null>(null);

	function handleCodeInput(e: Event) {
		const target = e.target as HTMLInputElement;
		manualCode = formatRoomCodeInput(target.value);
		joinError = null;
	}

	function handleJoinExisting(e: SubmitEvent) {
		e.preventDefault();
		if (!validateRoomCode(manualCode)) {
			joinError = 'Invalid room code format. Expected: 0000-0000-0000';
			return;
		}
		goto(`/room/${manualCode}`);
	}

	async function handleCreateRoom(e: SubmitEvent) {
		e.preventDefault();
		isSubmitting = true;
		errorMessage = null;

		try {
			const res = await signalingClient.createRoom({
				password: enablePassword && password.trim() ? password.trim() : undefined
			});
			goto(`/room/${res.code}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to create room';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Create Room - FastChat</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#0a0a0a] text-zinc-100 font-mono">
	<div class="w-full max-w-md bg-[#121212] p-6 sm:p-8 border border-[#262626]">
		<header class="mb-6 text-center">
			<div class="inline-block px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-widest bg-black text-[#ccff00] border border-[#262626] mb-3">
				FASTCHAT // P2P MESH
			</div>
			<h1 class="text-2xl font-bold tracking-tight uppercase text-white">SESSION DISPATCH</h1>
			<p class="text-xs text-zinc-500 mt-1 uppercase tracking-wider">Anonymous • Ephemeral • End-to-End Encrypted</p>
		</header>

		{#if errorMessage}
			<div role="alert" class="mb-4 p-3 bg-red-950/40 border border-red-800 text-red-400 text-xs">
				{errorMessage}
			</div>
		{/if}

		<form onsubmit={handleCreateRoom} class="space-y-4">
			<div class="border-t border-b border-[#262626] py-3">
				<label class="flex items-center space-x-2.5 cursor-pointer text-xs uppercase tracking-wider text-zinc-300 font-medium">
					<input
						type="checkbox"
						bind:checked={enablePassword}
						class="w-4 h-4 bg-black border border-[#262626] text-[#ccff00] focus:ring-0 focus:outline-none"
					/>
					<span>Protect with password</span>
				</label>

				{#if enablePassword}
					<div class="mt-3">
						<label for="room-password" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
							Room Password
						</label>
						<input
							id="room-password"
							type="password"
							bind:value={password}
							placeholder="Enter room password"
							required={enablePassword}
							class="w-full px-3 py-2.5 bg-black border border-[#262626] text-zinc-100 text-sm focus:outline-none focus:border-[#ccff00]"
						/>
					</div>
				{/if}
			</div>

			<button
				type="submit"
				disabled={isSubmitting}
				class="w-full min-h-[44px] py-2.5 px-4 bg-[#ccff00] hover:bg-[#b8e600] active:scale-[0.99] text-black font-bold uppercase tracking-wider text-xs transition-micro disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
			>
				{#if isSubmitting}
					Creating Session...
				{:else}
					Create New Room
				{/if}
			</button>
		</form>

		<div class="relative my-6">
			<div class="absolute inset-0 flex items-center">
				<div class="w-full border-t border-[#262626]"></div>
			</div>
			<div class="relative flex justify-center text-[10px] uppercase tracking-widest">
				<span class="bg-[#121212] px-3 text-zinc-500 font-medium">OR JOIN EXISTING</span>
			</div>
		</div>

		<form onsubmit={handleJoinExisting} class="space-y-3">
			{#if joinError}
				<div role="alert" class="p-2.5 bg-red-950/40 border border-red-800 text-red-400 text-xs">
					{joinError}
				</div>
			{/if}
			<div>
				<label for="manual-code" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
					Room Identifier
				</label>
				<input
					id="manual-code"
					type="text"
					value={manualCode}
					oninput={handleCodeInput}
					placeholder="0000-0000-0000"
					maxlength={14}
					class="w-full px-3 py-2.5 bg-black border border-[#262626] text-zinc-100 text-sm font-mono tracking-widest text-center focus:outline-none focus:border-[#ccff00]"
				/>
			</div>
			<button
				type="submit"
				class="w-full min-h-[44px] py-2.5 px-4 bg-black hover:bg-[#1c1c1c] text-zinc-200 border border-[#262626] hover:border-zinc-500 font-semibold uppercase tracking-wider text-xs transition-micro cursor-pointer"
			>
				Join Room
			</button>
		</form>
	</div>
</main>
