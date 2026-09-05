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

<main class="min-h-screen flex flex-col items-center justify-center p-6 bg-gray-50 text-gray-900">
	<div class="w-full max-w-md bg-white p-8 rounded-lg shadow border border-gray-200">
		<header class="mb-6 text-center">
			<h1 class="text-2xl font-bold tracking-tight">FastChat Room</h1>
			<p class="text-sm text-gray-500 mt-1">Anonymous, ephemeral peer-to-peer chat</p>
		</header>

		{#if errorMessage}
			<div role="alert" class="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">
				{errorMessage}
			</div>
		{/if}

		<form onsubmit={handleCreateRoom} class="space-y-4">
			<div class="border-t border-b border-gray-100 py-3">
				<label class="flex items-center space-x-2 cursor-pointer text-sm font-medium">
					<input
						type="checkbox"
						bind:checked={enablePassword}
						class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
					/>
					<span>Protect with password</span>
				</label>

				{#if enablePassword}
					<div class="mt-3">
						<label for="room-password" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
							Room Password
						</label>
						<input
							id="room-password"
							type="password"
							bind:value={password}
							placeholder="Enter room password"
							required={enablePassword}
							class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
						/>
					</div>
				{/if}
			</div>

			<button
				type="submit"
				disabled={isSubmitting}
				class="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors disabled:opacity-50"
			>
				{#if isSubmitting}
					Creating Room...
				{:else}
					Create New Room
				{/if}
			</button>
		</form>

		<div class="relative my-6">
			<div class="absolute inset-0 flex items-center">
				<div class="w-full border-t border-gray-200"></div>
			</div>
			<div class="relative flex justify-center text-xs uppercase">
				<span class="bg-white px-2 text-gray-400">or join existing</span>
			</div>
		</div>

		<form onsubmit={handleJoinExisting} class="space-y-3">
			{#if joinError}
				<div role="alert" class="p-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded">
					{joinError}
				</div>
			{/if}
			<div>
				<label for="manual-code" class="block text-xs font-semibold uppercase tracking-wider text-gray-600 mb-1">
					Room Code
				</label>
				<input
					id="manual-code"
					type="text"
					value={manualCode}
					oninput={handleCodeInput}
					placeholder="0000-0000-0000"
					maxlength={14}
					class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-mono tracking-wider text-center"
				/>
			</div>
			<button
				type="submit"
				class="w-full py-2 px-4 bg-gray-100 hover:bg-gray-200 text-gray-800 font-medium rounded transition-colors text-sm"
			>
				Join Room
			</button>
		</form>
	</div>
</main>
