<script lang="ts">
	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen, onClose }: Props = $props();
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 font-mono transition-micro"
		role="dialog"
		aria-modal="true"
		aria-labelledby="security-modal-title"
	>
		<div class="bg-[#121212] border-2 border-[#262626] max-w-lg w-full p-6 space-y-4 text-zinc-100 shadow-2xl">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[#262626] pb-3">
				<div class="flex items-center space-x-2">
					<span class="text-xs font-bold uppercase tracking-widest text-[#ccff00]">
						SECURITY ARCHITECTURE
					</span>
					<span class="text-[10px] px-1.5 py-0.5 bg-black border border-[#262626] text-zinc-400 uppercase">
						AUDITED
					</span>
				</div>
				<button
					type="button"
					onclick={onClose}
					class="text-zinc-400 hover:text-white px-2 py-1 bg-black border border-[#262626] text-xs font-bold transition-micro cursor-pointer"
					aria-label="Close security info"
				>
					✕
				</button>
			</div>

			<h2 id="security-modal-title" class="text-sm font-bold uppercase tracking-wide text-white">
				Why FastChat Room Is Secure
			</h2>

			<!-- Security Points Grid -->
			<div class="space-y-3 text-xs">
				<div class="p-3 bg-black border border-[#262626] space-y-1">
					<div class="font-bold text-[#ccff00] uppercase tracking-wider flex items-center gap-1.5">
						<span>🛡</span>
						<span>1. Zero Server Logs</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						The signaling service runs strictly in RAM and persists zero message logs, zero IP logs, and zero disk records. Communication is direct peer-to-peer over WebRTC data channels.
					</p>
				</div>

				<div class="p-3 bg-black border border-[#262626] space-y-1">
					<div class="font-bold text-[#ccff00] uppercase tracking-wider flex items-center gap-1.5">
						<span>🔒</span>
						<span>2. End-to-End Encryption (AES-256-GCM)</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						All chat messages and 16KB file transfer chunks are encrypted in the browser with AES-256-GCM using keys derived locally via HKDF-SHA256 with unique 96-bit IVs.
					</p>
				</div>

				<div class="p-3 bg-black border border-[#262626] space-y-1">
					<div class="font-bold text-[#ccff00] uppercase tracking-wider flex items-center gap-1.5">
						<span>⏳</span>
						<span>3. Ephemeral Auto-Deletion</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						Rooms exist only for their countdown lifespan. When the timer expires, the server permanently destroys all session mapping tables and salt records.
					</p>
				</div>

				<div class="p-3 bg-black border border-[#262626] space-y-1">
					<div class="font-bold text-[#ccff00] uppercase tracking-wider flex items-center gap-1.5">
						<span>🚫</span>
						<span>4. Zero Accounts & Zero Client Storage</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						No user accounts, no login cookies, and zero persistent browser web-storage mechanisms. Once the session terminates, all in-memory keys evaporate completely.
					</p>
				</div>
			</div>

			<!-- Footer -->
			<div class="pt-2 flex justify-end">
				<button
					type="button"
					onclick={onClose}
					class="min-h-[38px] px-4 py-1.5 bg-[#ccff00] hover:bg-[#b8e600] text-black font-bold uppercase text-xs transition-micro cursor-pointer"
				>
					Acknowledge & Close
				</button>
			</div>
		</div>
	</div>
{/if}
