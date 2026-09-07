<script lang="ts">
	interface Props {
		isOpen: boolean;
		onClose: () => void;
		canDetonate?: boolean;
		onDetonate?: () => void;
	}

	let {
		isOpen,
		onClose,
		canDetonate = false,
		onDetonate
	}: Props = $props();
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 font-['Inter',sans-serif] transition-all"
		role="dialog"
		aria-modal="true"
		aria-labelledby="security-modal-title"
	>
		<div class="bg-[#0a0d16]/95 border border-[#1a2233] rounded-2xl max-w-lg w-full p-6 sm:p-7 space-y-5 text-zinc-100 shadow-[0_0_60px_rgba(0,0,0,0.9)] backdrop-blur-xl relative">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-white/5 pb-3.5">
				<div class="flex items-center space-x-2.5">
					<span class="text-xs font-bold uppercase tracking-widest text-cyan-400 font-['Orbitron',sans-serif]">
						SECURITY ARCHITECTURE
					</span>
					<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-400 uppercase font-semibold font-mono">
						AUDITED
					</span>
				</div>
				<button
					type="button"
					onclick={onClose}
					class="text-zinc-400 hover:text-white w-8 h-8 rounded-full flex items-center justify-center bg-[#111624] hover:bg-[#182033] border border-white/10 text-xs font-bold transition-all cursor-pointer"
					aria-label="Close security info"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"/>
						<line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			</div>

			<h2 id="security-modal-title" class="text-sm sm:text-base font-bold uppercase tracking-wide text-white font-['Orbitron',sans-serif]">
				Why FastChat Room Is Secure
			</h2>

			<!-- Security Points Grid -->
			<div class="space-y-3 text-xs">
				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-1">
					<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
						<svg class="w-4 h-4 shrink-0 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
							<path d="m9 12 2 2 4-4"/>
						</svg>
						<span>1. Zero Server Logs</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						The signaling service runs strictly in RAM and persists zero message logs, zero IP logs, and zero disk records. Communication is direct peer-to-peer over WebRTC data channels.
					</p>
				</div>

				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-1">
					<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
						<svg class="w-4 h-4 shrink-0 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
							<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
						</svg>
						<span>2. End-to-End Encryption (AES-256-GCM)</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						All chat messages and 16KB file transfer chunks are encrypted in the browser with AES-256-GCM using keys derived locally via HKDF-SHA256 with unique 96-bit IVs.
					</p>
				</div>

				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-1">
					<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
						<svg class="w-4 h-4 shrink-0 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/>
							<polyline points="12 6 12 12 16 14"/>
						</svg>
						<span>3. Ephemeral Auto-Deletion</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						Rooms exist only for their countdown lifespan. When the timer expires, the server permanently destroys all session mapping tables and salt records.
					</p>
				</div>

				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-1">
					<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
						<svg class="w-4 h-4 shrink-0 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
							<circle cx="9" cy="7" r="4"/>
							<line x1="17" x2="22" y1="8" y2="13"/>
							<line x1="22" x2="17" y1="8" y2="13"/>
						</svg>
						<span>4. Zero Accounts & Zero Client Storage</span>
					</div>
					<p class="text-zinc-400 leading-relaxed text-[11px]">
						No user accounts, no login cookies, and zero persistent browser web-storage mechanisms. Once the session terminates, all in-memory keys evaporate completely.
					</p>
				</div>
			</div>

			{#if canDetonate && onDetonate}
				<!-- Destructive Owner Action: Detonate Room -->
				<div class="pt-2 border-t border-red-900/40">
					<div class="p-3.5 rounded-xl bg-red-950/20 border border-red-500/30 space-y-2.5">
						<div class="font-bold text-red-400 uppercase tracking-wider flex items-center justify-between text-[11px] font-['Orbitron',sans-serif]">
							<span class="flex items-center gap-1.5">
								<svg class="w-4 h-4 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M12 9v4"/>
									<path d="M12 17h.01"/>
									<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
								</svg>
								EMERGENCY DESTRUCTION
							</span>
							<span class="text-[9px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 font-mono">
								OWNER ONLY
							</span>
						</div>
						<p class="text-zinc-400 text-[11px] leading-relaxed">
							Instantly and irreversibly destroys this room without grace period. All participants are disconnected immediately and all ephemeral keys and in-memory tables are destroyed with zero trace.
						</p>
						<button
							type="button"
							onclick={() => {
								onClose();
								onDetonate();
							}}
							class="w-full min-h-[38px] px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 active:scale-[0.99] text-white font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(239,68,68,0.3)] flex items-center justify-center gap-2 cursor-pointer"
						>
							<svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="9"/>
								<line x1="12" y1="8" x2="12" y2="12"/>
								<line x1="12" y1="16" x2="12.01" y2="16"/>
							</svg>
							Detonate Room
						</button>
					</div>
				</div>
			{/if}

			<!-- Footer -->
			<div class="pt-2 flex justify-end">
				<button
					type="button"
					onclick={onClose}
					class="min-h-[40px] px-5 py-2 rounded-full bg-white hover:bg-zinc-200 text-black font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] cursor-pointer"
				>
					Acknowledge & Close
				</button>
			</div>
		</div>
	</div>
{/if}
