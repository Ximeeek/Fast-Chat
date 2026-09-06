<script lang="ts">
	interface Props {
		isOpen: boolean;
		onClose: () => void;
		isOwner?: boolean;
		hasPassword?: boolean;
		onSetPassword?: (password: string) => Promise<void> | void;
		canLockRoom?: boolean;
		isLocked?: boolean;
		onToggleLock?: () => void;
	}

	let {
		isOpen,
		onClose,
		isOwner = false,
		hasPassword = false,
		onSetPassword,
		canLockRoom = false,
		isLocked = false,
		onToggleLock
	}: Props = $props();

	let passwordInput = $state('');
	let isSubmitting = $state(false);
	let statusMessage = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		const trimmed = passwordInput.trim();
		if (!trimmed) {
			errorMessage = 'Password cannot be empty';
			statusMessage = null;
			return;
		}

		errorMessage = null;
		isSubmitting = true;
		try {
			if (onSetPassword) {
				await onSetPassword(trimmed);
				statusMessage = hasPassword
					? 'Room password successfully updated.'
					: 'Room password successfully configured.';
				passwordInput = '';
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to update password';
			statusMessage = null;
		} finally {
			isSubmitting = false;
		}
	}
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

			{#if isOwner}
				<!-- Room Password Management (Owner Only) -->
				<section class="p-4 rounded-xl bg-[#0e1424] border border-cyan-500/30 space-y-3 shadow-[0_0_20px_rgba(0,229,255,0.05)]">
					<div class="flex items-center justify-between">
						<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
							<svg class="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
								<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
							</svg>
							<span>Room Password Protection</span>
						</div>
						{#if hasPassword}
							<span class="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono uppercase font-bold border border-emerald-500/30">
								Protected
							</span>
						{:else}
							<span class="text-[9px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-mono uppercase font-bold border border-amber-500/30">
								Unprotected
							</span>
						{/if}
					</div>

					<p class="text-zinc-400 text-[11px] leading-relaxed">
						{hasPassword
							? 'Change the room password. Existing participants will have 15s to enter the new password.'
							: 'Set a room password to enforce end-to-end key rotation (REKEY) across all participants.'}
					</p>

					<form onsubmit={handleSubmit} class="space-y-2.5">
						<div class="flex gap-2">
							<input
								type="password"
								bind:value={passwordInput}
								placeholder={hasPassword ? 'Enter new password' : 'Enter room password'}
								disabled={isSubmitting}
								class="flex-1 min-h-[38px] px-3 rounded-lg bg-[#05070c] border border-white/10 focus:border-cyan-400 focus:outline-none text-zinc-100 text-xs font-mono placeholder:text-zinc-600 disabled:opacity-50"
							/>
							<button
								type="submit"
								disabled={isSubmitting || !passwordInput.trim()}
								class="min-h-[38px] px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black font-bold uppercase text-xs transition-all cursor-pointer disabled:cursor-not-allowed shrink-0 font-['Orbitron',sans-serif]"
							>
								{isSubmitting ? 'Updating...' : hasPassword ? 'Change Password' : 'Set Password'}
							</button>
						</div>

						{#if errorMessage}
							<div class="text-red-400 text-[11px] font-medium flex items-center gap-1.5">
								<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<circle cx="12" cy="12" r="10"/>
									<line x1="12" y1="8" x2="12" y2="12"/>
									<line x1="12" y1="16" x2="12.01" y2="16"/>
								</svg>
								<span>{errorMessage}</span>
							</div>
						{/if}

						{#if statusMessage}
							<div class="text-emerald-400 text-[11px] font-medium flex items-center gap-1.5">
								<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M20 6 9 17l-5-5"/>
								</svg>
								<span>{statusMessage}</span>
							</div>
						{/if}
					</form>
				</section>
			{/if}

			{#if canLockRoom}
				<!-- Room Entry Lock (gated by canLockRoom / Permission::LockRoom) -->
				<section class="p-4 rounded-xl bg-[#0e1424] border border-cyan-500/30 space-y-3 shadow-[0_0_20px_rgba(0,229,255,0.05)]">
					<div class="flex items-center justify-between">
						<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
							<svg class="w-4 h-4 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
								<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
							</svg>
							<span>Blokada dołączania do pokoju</span>
						</div>
						{#if isLocked}
							<span class="text-[9px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 font-mono uppercase font-bold border border-red-500/30">
								Zablokowany
							</span>
						{:else}
							<span class="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono uppercase font-bold border border-emerald-500/30">
								Otwarty
							</span>
						{/if}
					</div>

					<p class="text-zinc-400 text-[11px] leading-relaxed">
						{isLocked
							? 'Dołączanie do pokoju jest obecnie zablokowane. Nowi uczestnicy nie mogą wejść, a obecni kontynuują bez przerw.'
							: 'Pokój jest otwarty dla nowych uczestników posiadających identyfikator pokoju.'}
					</p>

					<div class="pt-1">
						<button
							type="button"
							onclick={onToggleLock}
							class="w-full min-h-[38px] px-4 rounded-lg font-bold uppercase text-xs transition-all cursor-pointer font-['Orbitron',sans-serif] flex items-center justify-center gap-2 {isLocked ? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40'}"
						>
							{#if isLocked}
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 9.9-1"/>
								</svg>
								<span>Odblokuj dołączanie</span>
							{:else}
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
								</svg>
								<span>Zablokuj dołączanie</span>
							{/if}
						</button>
					</div>
				</section>
			{/if}

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
