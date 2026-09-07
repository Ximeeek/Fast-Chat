<script lang="ts">
	interface Props {
		isOwner?: boolean;
		hasPassword?: boolean;
		onSetPassword?: (password: string) => Promise<void> | void;
		canLockRoom?: boolean;
		isLocked?: boolean;
		onToggleLock?: () => void;
	}

	let {
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
				setTimeout(() => {
					statusMessage = null;
				}, 4000);
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to update password';
			statusMessage = null;
		} finally {
			isSubmitting = false;
		}
	}
</script>

{#if isOwner || canLockRoom}
	<section class="space-y-2.5" aria-label="Room Access and Security Controls">
		<div class="flex items-center justify-between">
			<h2 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 font-mono flex items-center gap-2">
				<span>ROOM ACCESS & SECURITY</span>
				{#if isOwner}
					<span class="text-[9px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono uppercase font-semibold">
						Owner Controls
					</span>
				{/if}
			</h2>
		</div>

		<div class="grid grid-cols-1 {isOwner && canLockRoom ? 'md:grid-cols-2' : ''} gap-3 sm:gap-4">
			{#if isOwner}
				<!-- Room Password Protection Card -->
				<div class="p-4 sm:p-5 rounded-2xl bg-[#06080e] border border-white/5 hover:border-cyan-500/20 transition-all flex flex-col justify-between gap-3 shadow-[0_4px_25px_rgba(0,0,0,0.4)] relative overflow-hidden group">
					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
								<svg class="w-4 h-4 text-cyan-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
								</svg>
								<span>Room Password Protection</span>
							</div>
							{#if hasPassword}
								<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono uppercase font-bold border border-emerald-500/30 flex items-center gap-1 shrink-0">
									<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
									Protected
								</span>
							{:else}
								<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-mono uppercase font-bold border border-amber-500/30 flex items-center gap-1 shrink-0">
									<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
									Unprotected
								</span>
							{/if}
						</div>

						<p class="text-zinc-400 text-[11px] leading-relaxed font-['Inter',sans-serif]">
							{hasPassword
								? 'Change the room password. Existing participants will have 15s to enter the new password.'
								: 'Set a room password to enforce end-to-end key rotation (REKEY) across all participants.'}
						</p>
					</div>

					<form onsubmit={handleSubmit} class="space-y-2 pt-1">
						<div class="flex gap-2">
							<input
								type="password"
								bind:value={passwordInput}
								placeholder={hasPassword ? 'Enter new password' : 'Enter room password'}
								disabled={isSubmitting}
								class="flex-1 min-h-[38px] px-3 rounded-xl bg-[#0a0d16] border border-white/10 focus:border-cyan-400 focus:outline-none text-zinc-100 text-xs font-mono placeholder:text-zinc-600 disabled:opacity-50 transition-colors"
								aria-label="Room password"
							/>
							<button
								type="submit"
								disabled={isSubmitting || !passwordInput.trim()}
								class="min-h-[38px] px-3.5 sm:px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black font-bold uppercase text-[11px] tracking-wider transition-all cursor-pointer disabled:cursor-not-allowed shrink-0 font-['Orbitron',sans-serif] shadow-[0_0_15px_rgba(0,229,255,0.2)]"
							>
								{isSubmitting ? 'Updating...' : hasPassword ? 'Change Password' : 'Set Password'}
							</button>
						</div>

						{#if errorMessage}
							<div role="alert" class="text-red-400 text-[11px] font-medium flex items-center gap-1.5 font-mono">
								<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<circle cx="12" cy="12" r="10"/>
									<line x1="12" y1="8" x2="12" y2="12"/>
									<line x1="12" y1="16" x2="12.01" y2="16"/>
								</svg>
								<span>{errorMessage}</span>
							</div>
						{/if}

						{#if statusMessage}
							<div role="status" class="text-emerald-400 text-[11px] font-medium flex items-center gap-1.5 font-mono">
								<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M20 6 9 17l-5-5"/>
								</svg>
								<span>{statusMessage}</span>
							</div>
						{/if}
					</form>
				</div>
			{/if}

			{#if canLockRoom}
				<!-- Room Entry Lock Card -->
				<div class="p-4 sm:p-5 rounded-2xl bg-[#06080e] border border-white/5 hover:border-cyan-500/20 transition-all flex flex-col justify-between gap-3 shadow-[0_4px_25px_rgba(0,0,0,0.4)] relative overflow-hidden group">
					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<div class="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-2 font-['Orbitron',sans-serif] text-[11px]">
								<svg class="w-4 h-4 text-cyan-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
								</svg>
								<span>Room Entry Lock</span>
							</div>
							{#if isLocked}
								<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-red-500/15 text-red-300 font-mono uppercase font-bold border border-red-500/30 flex items-center gap-1 shrink-0">
									<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>
									Locked
								</span>
							{:else}
								<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono uppercase font-bold border border-emerald-500/30 flex items-center gap-1 shrink-0">
									<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
									Open
								</span>
							{/if}
						</div>

						<p class="text-zinc-400 text-[11px] leading-relaxed font-['Inter',sans-serif]">
							{isLocked
								? 'Room entry is currently locked. New participants cannot join, while existing members continue uninterrupted.'
								: 'Room is open to new participants who have the room identifier.'}
						</p>
					</div>

					<div class="pt-1">
						<button
							type="button"
							onclick={onToggleLock}
							class="w-full min-h-[38px] px-4 rounded-xl font-bold uppercase text-xs tracking-wider transition-all cursor-pointer font-['Orbitron',sans-serif] flex items-center justify-center gap-2 {isLocked
								? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-[0_0_15px_rgba(16,185,129,0.3)]'
								: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 hover:border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.15)]'}"
						>
							{#if isLocked}
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 9.9-1"/>
								</svg>
								<span>Unlock Entry</span>
							{:else}
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
									<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
								</svg>
								<span>Lock Entry</span>
							{/if}
						</button>
					</div>
				</div>
			{/if}
		</div>
	</section>
{/if}
