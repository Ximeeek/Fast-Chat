<script lang="ts">
	interface Props {
		roomCode: string;
	}

	let { roomCode }: Props = $props();

	let copied = $state(false);
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	async function copyToClipboard() {
		if (!roomCode) return;
		try {
			await navigator.clipboard.writeText(roomCode);
			copied = true;
			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy room code:', err);
		}
	}
</script>

<div class="w-full">
	<button
		type="button"
		onclick={copyToClipboard}
		class="w-full p-4 sm:p-5 bg-[#121212] border-2 transition-micro text-left cursor-pointer group select-none {copied
			? 'border-[#ccff00] bg-[#18181b]'
			: 'border-[#262626] hover:border-zinc-500'}"
		aria-label="Room code {roomCode}. Click to copy to clipboard."
		title="Click to copy room code"
	>
		<!-- Meta Tag Bar -->
		<div class="flex items-center justify-between gap-2 mb-2">
			<div class="flex items-center space-x-2">
				<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
					ROOM IDENTIFIER
				</span>
				<span class="text-[9px] px-1.5 py-0.2 bg-black text-zinc-500 border border-[#262626] uppercase">
					SECURE MESH
				</span>
			</div>

			<div class="flex items-center space-x-1.5">
				{#if copied}
					<span
						class="text-[11px] font-bold uppercase tracking-wider text-black bg-[#ccff00] px-2 py-0.5"
						role="status"
						aria-live="polite"
					>
						✓ COPIED TO CLIPBOARD
					</span>
				{:else}
					<span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 group-hover:text-[#ccff00] transition-micro">
						[ TAP TO COPY ]
					</span>
				{/if}
			</div>
		</div>

		<!-- Hero Code Display -->
		<div class="flex items-baseline justify-between gap-4">
			<span
				class="text-2xl sm:text-3xl md:text-4xl font-mono font-bold tracking-[0.18em] sm:tracking-[0.22em] transition-micro {copied
					? 'text-[#ccff00]'
					: 'text-white group-hover:text-[#ccff00]'}"
			>
				{roomCode}
			</span>

			<span class="text-xs text-zinc-600 group-hover:text-zinc-400 uppercase font-mono tracking-widest hidden sm:inline-block">
				SHARE //
			</span>
		</div>
	</button>
</div>
