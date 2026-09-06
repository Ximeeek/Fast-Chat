<script lang="ts">
	import { goto } from '$app/navigation';
	import { signalingClient } from '$lib/signaling/client';
	import { formatRoomCodeInput, validateRoomCode, encodeRoomToken } from '$lib/utils/roomCode';
	import SecurityInfoPanel from '$lib/room/SecurityInfoPanel.svelte';

	let enablePassword = $state(false);
	let password = $state('');
	let isSubmitting = $state(false);
	let errorMessage = $state<string | null>(null);

	// Join existing room form state
	let manualCode = $state('');
	let joinError = $state<string | null>(null);
	let isSecurityInfoOpen = $state(false);

	const codePlaceholder = '0000-0000-0000';
	const hasNonDigits = $derived(/[^\d-]/.test(manualCode));
	const maskSuffix = $derived(!hasNonDigits ? codePlaceholder.slice(manualCode.length) : '');

	function handleCodeKeyDown(e: KeyboardEvent) {
		if (
			['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Home', 'End'].includes(e.key) ||
			e.ctrlKey ||
			e.metaKey
		) {
			return;
		}
		if (!/^\d$/.test(e.key)) {
			e.preventDefault();
			joinError = 'Only numbers are allowed. Expected room code format: 0000-0000-0000';
		}
	}

	function handleCodeInput(e: Event) {
		const target = e.target as HTMLInputElement;
		const raw = target.value.trim();
		if (/[^\d-]/.test(raw)) {
			manualCode = raw;
			joinError = 'Only numbers are allowed. Expected room code format: 0000-0000-0000';
		} else {
			manualCode = formatRoomCodeInput(raw);
			target.value = manualCode;
			joinError = null;
		}
	}

	function handleJoinExisting(e: SubmitEvent) {
		e.preventDefault();
		if (/[^\d-]/.test(manualCode)) {
			joinError = 'Only numbers are allowed. Expected room code format: 0000-0000-0000';
			return;
		}
		if (!validateRoomCode(manualCode)) {
			joinError = 'Invalid room code format. Expected: 0000-0000-0000';
			return;
		}
		const token = encodeRoomToken(manualCode);
		goto(`/room/${token}`);
	}

	async function handleCreateRoom(e: SubmitEvent) {
		e.preventDefault();
		isSubmitting = true;
		errorMessage = null;

		try {
			const res = await signalingClient.createRoom({
				password: enablePassword && password.trim() ? password.trim() : undefined
			});
			const token = encodeRoomToken(res.code);
			goto(`/room/${token}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to create room';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Start Private Chat - FastChat Room</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6 bg-[#050608] text-zinc-100 font-['Inter',sans-serif] bg-cyber-grid relative overflow-hidden">
	<!-- Ambient backdrop glow -->
	<div class="absolute w-[500px] h-[350px] bg-blue-600/15 blur-[120px] pointer-events-none rounded-full"></div>

	<div class="w-full max-w-md bg-[#0a0d16]/95 backdrop-blur-xl p-7 sm:p-9 rounded-2xl border border-[#1a2233] shadow-[0_0_60px_rgba(0,0,0,0.85)] relative z-10">
		<header class="mb-7 text-center">
			<div class="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 text-[11px] font-semibold uppercase tracking-wider mb-3.5 shadow-[0_0_15px_rgba(0,102,255,0.15)]">
				<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
				<span>DIRECT PEER-TO-PEER ENCRYPTED</span>
			</div>
			<h1 class="text-2xl sm:text-3xl font-black tracking-tight uppercase text-white font-['Orbitron',sans-serif]">
				START PRIVATE CHAT
			</h1>
			<p class="text-xs text-zinc-400 mt-1.5 font-mono leading-relaxed">
				Ephemeral rooms • Zero accounts • Instant auto-wipe
			</p>
		</header>

		{#if errorMessage}
			<div role="alert" class="mb-5 p-3.5 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
				{errorMessage}
			</div>
		{/if}

		<form onsubmit={handleCreateRoom} class="space-y-4">
			<div class="rounded-xl bg-[#06080e] border border-white/5 p-4 transition-all">
				<!-- Custom Styled Checkbox -->
				<label class="flex items-start gap-3 cursor-pointer group select-none">
					<div class="relative flex items-center justify-center mt-0.5">
						<input
							type="checkbox"
							bind:checked={enablePassword}
							class="sr-only peer"
						/>
						<div class="w-5 h-5 rounded-md bg-[#0a0d16] border border-[#222b3d] peer-checked:bg-blue-600 peer-checked:border-cyan-400 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/50 flex items-center justify-center transition-all duration-200 group-hover:border-zinc-500 shadow-sm">
							<svg
								class="w-3.5 h-3.5 text-white stroke-[2.5] transition-all duration-150 {enablePassword ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<polyline points="20 6 9 17 4 12"/>
							</svg>
						</div>
					</div>
					<div class="flex flex-col">
						<span class="text-xs uppercase tracking-wider text-zinc-200 font-medium group-hover:text-white transition-colors">
							Protect with password
						</span>
						<span class="text-[10px] text-zinc-500 font-mono mt-0.5">
							Derive secondary encryption key from passphrase
						</span>
					</div>
				</label>

				<!-- Smooth Accordion Expansion for Password Field -->
				<div
					class="grid transition-[grid-template-rows,opacity] duration-300 ease-out {enablePassword
						? 'grid-rows-[1fr] opacity-100 mt-3 pt-3 border-t border-white/5'
						: 'grid-rows-[0fr] opacity-0'}"
				>
					<div class="overflow-hidden">
						<label for="room-password" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 font-mono">
							Room Password
						</label>
						<input
							id="room-password"
							type="password"
							bind:value={password}
							placeholder="Enter room password"
							required={enablePassword}
							class="w-full px-3.5 py-2.5 rounded-lg bg-[#0a0d16] border border-[#1e2538] text-zinc-100 text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all font-sans"
						/>
					</div>
				</div>
			</div>

			<button
				type="submit"
				disabled={isSubmitting}
				class="w-full min-h-[48px] py-3 px-5 rounded-full bg-white hover:bg-zinc-200 active:scale-[0.99] text-black font-bold uppercase tracking-wider text-xs sm:text-sm transition-all shadow-[0_0_25px_rgba(255,255,255,0.2)] disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2.5 group"
			>
				{#if isSubmitting}
					<span class="inline-block w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
					<span>Creating Session...</span>
				{:else}
					<svg class="w-3.5 h-3.5 fill-black group-hover:scale-110 transition-transform" viewBox="0 0 16 16">
						<circle cx="2" cy="2" r="1.5"/>
						<circle cx="8" cy="2" r="1.5"/>
						<circle cx="14" cy="2" r="1.5"/>
						<circle cx="2" cy="8" r="1.5"/>
						<circle cx="8" cy="8" r="1.5"/>
						<circle cx="14" cy="8" r="1.5"/>
						<circle cx="2" cy="14" r="1.5"/>
						<circle cx="8" cy="14" r="1.5"/>
						<circle cx="14" cy="14" r="1.5"/>
					</svg>
					<span>Create New Room</span>
				{/if}
			</button>
		</form>

		<div class="relative my-7">
			<div class="absolute inset-0 flex items-center">
				<div class="w-full border-t border-[#1a2233]"></div>
			</div>
			<div class="relative flex justify-center text-[10px] uppercase tracking-widest font-mono">
				<span class="bg-[#0a0d16] px-3.5 text-zinc-500 font-medium">OR JOIN EXISTING</span>
			</div>
		</div>

		<form onsubmit={handleJoinExisting} class="space-y-4">
			{#if joinError}
				<div role="alert" class="p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
					{joinError}
				</div>
			{/if}
			<div>
				<label for="manual-code" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 font-mono">
					Room Identifier
				</label>
				<!-- Fixed-position overlay input preventing text jumping and aligning over mask -->
				<div class="relative flex items-center rounded-xl bg-[#06080e] border border-[#1e2538] focus-within:border-cyan-400 focus-within:ring-1 focus-within:ring-cyan-400 transition-all overflow-hidden">
					<!-- Visual placeholder mask layer for numeric codes -->
					{#if !hasNonDigits}
						<div
							class="absolute inset-0 px-4 py-3 flex items-center font-['JetBrains_Mono',monospace] text-sm tracking-[0.22em] pointer-events-none select-none text-left"
							aria-hidden="true"
						>
							<span class="opacity-0">{manualCode}</span><span class="text-zinc-600">{maskSuffix}</span>
						</div>
					{/if}
					<!-- Real input on top with exact matching typography -->
					<input
						id="manual-code"
						type="text"
						inputmode="numeric"
						placeholder={hasNonDigits ? '' : '0000-0000-0000'}
						value={manualCode}
						onkeydown={handleCodeKeyDown}
						oninput={handleCodeInput}
						maxlength={60}
						autocomplete="off"
						spellcheck="false"
						class="w-full px-4 py-3 bg-transparent text-cyan-300 text-sm font-['JetBrains_Mono',monospace] {!hasNonDigits ? 'tracking-[0.22em]' : 'tracking-normal'} text-left focus:outline-none relative z-10"
					/>
				</div>
			</div>
			<button
				type="submit"
				class="w-full min-h-[46px] py-2.5 px-4 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-200 hover:text-white border border-white/10 hover:border-blue-500/50 font-semibold uppercase tracking-wider text-xs transition-all cursor-pointer"
			>
				Join Room
			</button>
		</form>

		<!-- Zero-Persistence Architecture Overview (Audited Specs) -->
		<div class="mt-8 pt-6 border-t border-[#1a2233] space-y-3">
			<div class="flex items-center justify-between">
				<div class="flex items-center space-x-2">
					<span class="text-[11px] font-bold uppercase tracking-wider text-zinc-300 font-mono">
						ZERO PERSISTENCE ARCHITECTURE
					</span>
					<span class="text-[9px] px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 uppercase font-mono">
						AUDITED
					</span>
				</div>
				<button
					type="button"
					onclick={() => (isSecurityInfoOpen = true)}
					class="text-[10px] text-cyan-400 hover:text-cyan-300 uppercase font-bold tracking-wider cursor-pointer font-mono flex items-center gap-1 transition-colors"
				>
					<span>View Specs</span>
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M5 12h14"/>
						<path d="m12 5 7 7-7 7"/>
					</svg>
				</button>
			</div>

			<div class="grid grid-cols-2 gap-2 text-[10px] font-mono">
				<div class="p-2.5 rounded-xl bg-[#06080e] border border-white/5 space-y-0.5">
					<div class="text-zinc-200 font-bold uppercase">ZERO LOGS</div>
					<div class="text-zinc-500">RAM-only relay</div>
				</div>
				<div class="p-2.5 rounded-xl bg-[#06080e] border border-white/5 space-y-0.5">
					<div class="text-zinc-200 font-bold uppercase">E2E ENCRYPTED</div>
					<div class="text-zinc-500">AES-256-GCM</div>
				</div>
				<div class="p-2.5 rounded-xl bg-[#06080e] border border-white/5 space-y-0.5">
					<div class="text-zinc-200 font-bold uppercase">AUTO-DELETION</div>
					<div class="text-zinc-500">Purged on expiry</div>
				</div>
				<div class="p-2.5 rounded-xl bg-[#06080e] border border-white/5 space-y-0.5">
					<div class="text-zinc-200 font-bold uppercase">NO ACCOUNTS</div>
					<div class="text-zinc-500">Zero stored tokens</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Security Specifications Modal -->
	<SecurityInfoPanel
		isOpen={isSecurityInfoOpen}
		onClose={() => (isSecurityInfoOpen = false)}
	/>
</main>
