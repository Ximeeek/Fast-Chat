<script lang="ts">
	interface Props {
		isOpen: boolean;
		timeRemaining: number;
		errorMessage?: string | null;
		isSubmitting?: boolean;
		onSubmit: (password: string) => Promise<void> | void;
		onLeave: () => void;
	}

	let {
		isOpen,
		timeRemaining,
		errorMessage = null,
		isSubmitting = false,
		onSubmit,
		onLeave
	}: Props = $props();

	let passwordInput = $state('');

	async function handleFormSubmit(e: SubmitEvent) {
		e.preventDefault();
		const trimmed = passwordInput.trim();
		if (!trimmed) return;
		await onSubmit(trimmed);
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 font-['Inter',sans-serif] transition-all"
		role="dialog"
		aria-modal="true"
		aria-labelledby="rekey-modal-title"
	>
		<div class="bg-[#0a0d16]/95 border border-amber-500/40 rounded-2xl max-w-md w-full p-6 sm:p-7 space-y-5 text-zinc-100 shadow-[0_0_60px_rgba(245,158,11,0.2)] backdrop-blur-xl relative">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-white/5 pb-3.5">
				<div class="flex items-center space-x-2.5">
					<span class="text-xs font-bold uppercase tracking-widest text-amber-400 font-['Orbitron',sans-serif]">
						SECURITY REKEY
					</span>
					<span
						class="text-[10px] px-2.5 py-0.5 rounded-full font-mono uppercase font-semibold border {timeRemaining <= 5
							? 'bg-red-500/20 border-red-500/40 text-red-400 animate-pulse'
							: 'bg-amber-500/15 border-amber-500/30 text-amber-400'}"
					>
						{timeRemaining}s remaining
					</span>
				</div>
			</div>

			<div class="space-y-2">
				<h2 id="rekey-modal-title" class="text-sm sm:text-base font-bold uppercase tracking-wide text-white font-['Orbitron',sans-serif]">
					Room Password Required
				</h2>
				<p class="text-zinc-400 text-xs leading-relaxed">
					The room owner set or changed the room password. Enter the password within <span class="text-amber-300 font-semibold">{timeRemaining} seconds</span> to derive rotated encryption keys and remain connected.
				</p>
			</div>

			<form onsubmit={handleFormSubmit} class="space-y-4">
				<div>
					<label for="rekey-password-input" class="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 font-mono">
						New Password
					</label>
					<input
						id="rekey-password-input"
						type="password"
						bind:value={passwordInput}
						placeholder="Enter room password"
						disabled={isSubmitting}
						class="w-full min-h-[42px] px-3.5 rounded-xl bg-[#05070c] border border-white/15 focus:border-amber-400 focus:outline-none text-zinc-100 text-sm font-mono placeholder:text-zinc-600 disabled:opacity-50"
					/>
				</div>

				{#if errorMessage}
					<div class="p-2.5 rounded-lg bg-red-950/40 border border-red-800/50 text-red-300 text-xs flex items-center gap-2">
						<svg class="w-4 h-4 shrink-0 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"/>
							<line x1="12" y1="8" x2="12" y2="12"/>
							<line x1="12" y1="16" x2="12.01" y2="16"/>
						</svg>
						<span>{errorMessage}</span>
					</div>
				{/if}

				<div class="pt-2 flex items-center justify-end gap-2.5">
					<button
						type="button"
						onclick={onLeave}
						class="min-h-[40px] px-4 py-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 font-semibold text-xs uppercase tracking-wider transition-all cursor-pointer"
					>
						Leave Room
					</button>
					<button
						type="submit"
						disabled={isSubmitting || !passwordInput.trim()}
						class="min-h-[40px] px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black font-bold uppercase text-xs transition-all shadow-[0_0_20px_rgba(245,158,11,0.3)] cursor-pointer disabled:cursor-not-allowed font-['Orbitron',sans-serif]"
					>
						{isSubmitting ? 'Verifying...' : 'Confirm'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
