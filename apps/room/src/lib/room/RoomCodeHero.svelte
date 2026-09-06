<script lang="ts">
	import { onDestroy } from 'svelte';

	interface Props {
		roomCode: string;
		roomToken?: string;
	}

	let { roomCode, roomToken }: Props = $props();

	let copied = $state(false);
	let displayCode = $state('');
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let scrambleInterval: ReturnType<typeof setInterval> | null = null;

	function startScramble() {
		if (!roomCode) return;
		const target = roomCode;
		const totalFrames = 16;
		let frame = 0;

		if (scrambleInterval) clearInterval(scrambleInterval);
		scrambleInterval = setInterval(() => {
			frame++;
			const progress = frame / totalFrames;
			const revealedCount = Math.floor(progress * target.length);

			let result = '';
			for (let i = 0; i < target.length; i++) {
				const char = target[i];
				if (char === '-') {
					result += '-';
				} else if (i < revealedCount) {
					result += char;
				} else {
					result += Math.floor(Math.random() * 10).toString();
				}
			}
			displayCode = result;

			if (frame >= totalFrames) {
				displayCode = target;
				if (scrambleInterval) {
					clearInterval(scrambleInterval);
					scrambleInterval = null;
				}
			}
		}, 28);
	}

	$effect(() => {
		if (roomCode) {
			startScramble();
		}
	});

	onDestroy(() => {
		if (scrambleInterval) clearInterval(scrambleInterval);
		if (timeoutId) clearTimeout(timeoutId);
	});

	async function copyToClipboard() {
		if (!roomCode) return;
		try {
			const shareTarget = typeof window !== 'undefined' && roomToken
				? `${window.location.origin}/room/${roomToken}`
				: roomCode;
			await navigator.clipboard.writeText(shareTarget);
			copied = true;
			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy room link:', err);
		}
	}
</script>

<div class="w-full">
	<button
		type="button"
		onclick={copyToClipboard}
		class="w-full p-5 sm:p-6 rounded-2xl bg-[#0a0d16]/95 backdrop-blur-md border transition-all text-left cursor-pointer group select-none relative overflow-hidden shadow-[0_4px_25px_rgba(0,0,0,0.5)] {copied
			? 'border-cyan-400 shadow-[0_0_30px_rgba(0,229,255,0.25)] bg-[#0c1322]'
			: 'border-[#1a2233] hover:border-cyan-500/50 hover:bg-[#0c101c]'}"
		aria-label="Room code {roomCode}. Click to copy encrypted invite link."
		title="Click to copy encrypted room invite link"
	>
		<!-- Symmetric hover glow bar across full top border -->
		<div class="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>

		<!-- Meta Tag Bar -->
		<div class="flex items-center justify-between gap-2 mb-3">
			<div class="flex items-center space-x-2.5">
				<span class="text-[11px] font-bold uppercase tracking-widest text-zinc-400 font-mono">
					ROOM IDENTIFIER
				</span>
				<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30 uppercase font-semibold font-mono">
					SECURE ROOM
				</span>
				{#if roomToken}
					<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/25 uppercase font-mono hidden md:inline">
						TOKEN: {roomToken.slice(0, 8)}...
					</span>
				{/if}
			</div>

			<div class="flex items-center space-x-1.5 font-mono">
				{#if copied}
					<span
						class="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-black bg-cyan-400 px-3 py-0.5 rounded-full shadow-[0_0_12px_#00e5ff]"
						role="status"
						aria-live="polite"
					>
						<svg class="w-3 h-3 stroke-[2.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="20 6 9 17 4 12"/>
						</svg>
						<span>LINK COPIED</span>
					</span>
				{:else}
					<span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 group-hover:text-cyan-400 transition-colors">
						[ COPY ENCRYPTED LINK ]
					</span>
				{/if}
			</div>
		</div>

		<!-- Hero Code Display -->
		<div class="flex items-baseline justify-between gap-4">
			<span
				class="text-2xl sm:text-3xl md:text-4xl font-['JetBrains_Mono',monospace] font-bold tracking-[0.18em] sm:tracking-[0.22em] transition-all {copied
					? 'text-cyan-300 drop-shadow-[0_0_15px_rgba(0,229,255,0.4)]'
					: 'text-white group-hover:text-cyan-200'}"
			>
				{displayCode}
			</span>

			<div class="flex items-center gap-1.5 text-xs text-zinc-500 group-hover:text-cyan-400 transition-colors uppercase font-mono tracking-wider hidden sm:flex">
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
					<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
				</svg>
				<span>Copy</span>
			</div>
		</div>
	</button>
</div>
