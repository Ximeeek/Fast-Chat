<script lang="ts">
	interface Props {
		countdown: number | null;
		onDownloadChatLog: () => void;
		onDownloadFiles: () => void;
		hasFiles: boolean;
		isZipping?: boolean;
	}

	let {
		countdown,
		onDownloadChatLog,
		onDownloadFiles,
		hasFiles,
		isZipping = false
	}: Props = $props();
</script>

<aside
	role="alert"
	aria-live="assertive"
	class="w-full p-5 rounded-2xl bg-red-950/40 border border-red-500/50 font-['Inter',sans-serif] text-zinc-100 shadow-[0_0_30px_rgba(239,68,68,0.2)] space-y-3 relative overflow-hidden backdrop-blur-md"
>
	<div class="flex flex-wrap items-center justify-between gap-3 border-b border-red-800/40 pb-3">
		<div class="flex items-center space-x-2.5">
			<span class="inline-block px-2.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-bold uppercase tracking-wider">
				LAST CHANCE
			</span>
			<span class="text-xs sm:text-sm font-bold uppercase tracking-wider text-red-300 font-['Orbitron',sans-serif]">
				ROOM SESSION TERMINATING
			</span>
		</div>

		<div class="flex items-center space-x-2 font-bold text-sm sm:text-base tabular-nums font-mono">
			<span class="text-zinc-400 text-xs uppercase tracking-wider">CLOSING IN:</span>
			<span class="text-white bg-red-900/60 px-2.5 py-0.5 rounded-lg border border-red-500/50">
				{countdown !== null ? `${countdown}s` : '10s'}
			</span>
		</div>
	</div>

	<p class="text-xs text-zinc-300 leading-relaxed">
		Room has reached final 10-second grace window. Ephemeral cryptographic keys and in-memory data
		will be permanently destroyed. Download decrypted logs and files immediately.
	</p>

	<div class="flex flex-wrap items-center gap-3 pt-1">
		<button
			type="button"
			onclick={onDownloadChatLog}
			class="min-h-[42px] px-5 py-2 rounded-full bg-white hover:bg-zinc-200 active:scale-[0.99] text-black font-bold uppercase tracking-wider text-xs transition-all shadow-[0_0_15px_rgba(255,255,255,0.2)] cursor-pointer flex items-center gap-2"
		>
			<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
				<polyline points="7 10 12 15 17 10"/>
				<line x1="12" x2="12" y1="15" y2="3"/>
			</svg>
			<span>Download chat log</span>
		</button>

		<button
			type="button"
			onclick={onDownloadFiles}
			disabled={!hasFiles || isZipping}
			class="min-h-[42px] px-5 py-2 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-200 border border-white/10 hover:border-blue-500/50 disabled:opacity-40 font-bold uppercase tracking-wider text-xs transition-all cursor-pointer disabled:cursor-not-allowed flex items-center gap-2"
			title={hasFiles ? 'Download all transferred files as .zip' : 'No received files available'}
		>
			<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
				<polyline points="7 10 12 15 17 10"/>
				<line x1="12" x2="12" y1="15" y2="3"/>
			</svg>
			<span>{isZipping ? 'Archiving files...' : hasFiles ? 'Download files' : 'No files to download'}</span>
		</button>
	</div>
</aside>
