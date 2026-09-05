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
	class="w-full p-4 sm:p-5 bg-black border-2 border-red-600 font-mono text-zinc-100 transition-micro space-y-3"
>
	<div class="flex flex-wrap items-center justify-between gap-3 border-b border-red-900/60 pb-3">
		<div class="flex items-center space-x-2">
			<span class="inline-block px-2 py-0.5 bg-red-600 text-black text-[11px] font-bold uppercase tracking-wider">
				LAST CHANCE
			</span>
			<span class="text-xs sm:text-sm font-bold uppercase tracking-wider text-red-400">
				ROOM SESSION TERMINATING
			</span>
		</div>

		<div class="flex items-center space-x-1.5 font-bold text-sm sm:text-base tabular-nums">
			<span class="text-zinc-400 text-xs uppercase tracking-wider">CLOSING IN:</span>
			<span class="text-[#ccff00] bg-black px-2 py-0.5 border border-red-800">
				{countdown !== null ? `${countdown}s` : '10s'}
			</span>
		</div>
	</div>

	<p class="text-xs text-zinc-300 leading-relaxed">
		Room has reached final 10-second grace window. Ephemeral cryptographic keys and in-memory data
		will be permanently destroyed. Download decrypted logs and files immediately.
	</p>

	<div class="flex flex-wrap items-center gap-2.5 pt-1">
		<button
			type="button"
			onclick={onDownloadChatLog}
			class="min-h-[44px] px-4 py-2 bg-[#ccff00] hover:bg-[#b8e600] active:scale-[0.99] text-black font-bold uppercase tracking-wider text-xs transition-micro cursor-pointer flex items-center gap-2"
		>
			<span>⤓</span>
			<span>Download chat log</span>
		</button>

		<button
			type="button"
			onclick={onDownloadFiles}
			disabled={!hasFiles || isZipping}
			class="min-h-[44px] px-4 py-2 bg-black hover:bg-[#1a1a1a] text-zinc-200 border border-[#3f3f46] hover:border-[#ccff00] disabled:opacity-40 disabled:hover:border-[#3f3f46] font-bold uppercase tracking-wider text-xs transition-micro cursor-pointer disabled:cursor-not-allowed flex items-center gap-2"
			title={hasFiles ? 'Download all transferred files as .zip' : 'No received files available'}
		>
			<span>⤓</span>
			<span>{isZipping ? 'Archiving files...' : hasFiles ? 'Download files' : 'No files to download'}</span>
		</button>
	</div>
</aside>
