<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut, cubicIn } from 'svelte/easing';
	import { isFileSystemAccessSupported } from '$lib/transfer/receiver';

	let isVisible = $state(false);
	let timeLeft = $state(10);
	let countdownTimer: ReturnType<typeof setInterval> | null = null;
	let loadTimer: ReturnType<typeof setTimeout> | null = null;

	function dismiss() {
		if (countdownTimer) {
			clearInterval(countdownTimer);
			countdownTimer = null;
		}
		isVisible = false;
	}

	function startCountdown() {
		if (countdownTimer) clearInterval(countdownTimer);
		timeLeft = 10;
		countdownTimer = setInterval(() => {
			timeLeft = Math.max(0, timeLeft - 1);
		}, 1000);
	}

	onMount(() => {
		if (isFileSystemAccessSupported()) return;

		const showNotice = () => {
			isVisible = true;
			startCountdown();
		};

		if (document.readyState === 'complete') {
			loadTimer = setTimeout(showNotice, 250);
		} else {
			window.addEventListener('load', showNotice, { once: true });
		}
	});

	onDestroy(() => {
		if (loadTimer) clearTimeout(loadTimer);
		if (countdownTimer) clearInterval(countdownTimer);
	});
</script>

{#if isVisible}
	<!-- Mobile Alert Modal (< 640px) -->
	<div
		in:fade={{ duration: 250 }}
		out:fade={{ duration: 200 }}
		class="block sm:hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 font-['Inter',sans-serif]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="browser-limit-mobile-title"
	>
		<div
			in:fly={{ y: 24, duration: 300, easing: cubicOut }}
			out:fly={{ y: 24, duration: 200, easing: cubicIn }}
			class="bg-[#240e14]/95 border border-red-400/50 rounded-2xl max-w-sm w-full p-5 space-y-4 text-zinc-100 shadow-[0_0_40px_rgba(248,113,113,0.25)] backdrop-blur-xl"
		>
			<div class="flex items-center justify-between border-b border-red-500/20 pb-3">
				<div class="flex items-center space-x-2">
					<svg
						class="w-5 h-5 text-red-400 shrink-0"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<circle cx="12" cy="12" r="10" />
						<line x1="12" y1="8" x2="12" y2="12" />
						<line x1="12" y1="16" x2="12.01" y2="16" />
					</svg>
					<span class="text-xs font-bold uppercase tracking-wider text-red-300 font-['Orbitron',sans-serif]">
						Browser Notice
					</span>
				</div>
				<span class="text-[10px] px-2 py-0.5 rounded-full font-mono uppercase font-semibold bg-red-500/20 border border-red-400/30 text-red-300">
					1 GB Max
				</span>
			</div>

			<div class="space-y-2">
				<h3 id="browser-limit-mobile-title" class="text-sm font-bold uppercase tracking-wide text-white font-['Orbitron',sans-serif]">
					File Transfer Limit: 1 GB
				</h3>
				<p class="text-red-200/90 text-xs leading-relaxed">
					This browser lacks direct disk streaming. Transfers larger than 1 GB are temporarily disabled to prevent memory crashes. This browser limitation will be resolved in a future update.
				</p>
			</div>

			<button
				type="button"
				onclick={dismiss}
				class="w-full py-2.5 px-4 rounded-xl bg-red-500/25 hover:bg-red-500/35 active:bg-red-500/40 border border-red-400/40 text-red-100 font-bold uppercase tracking-wider text-xs transition-all cursor-pointer shadow-sm"
			>
				Understood
			</button>
		</div>
	</div>

	<!-- Desktop Bottom-Right Notification (>= 640px) -->
	<aside
		in:fly={{ y: 32, duration: 400, easing: cubicOut }}
		out:fly={{ y: 24, duration: 300, easing: cubicIn }}
		class="hidden sm:block fixed bottom-5 right-5 z-50 max-w-sm w-full p-4 rounded-2xl bg-[#240e14]/95 border border-red-400/50 text-red-100 shadow-[0_0_35px_rgba(248,113,113,0.25)] backdrop-blur-xl font-['Inter',sans-serif] transition-shadow"
		role="alert"
		aria-live="polite"
	>
		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<div class="flex items-center space-x-2">
					<svg
						class="w-4 h-4 text-red-400 shrink-0"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<circle cx="12" cy="12" r="10" />
						<line x1="12" y1="8" x2="12" y2="12" />
						<line x1="12" y1="16" x2="12.01" y2="16" />
					</svg>
					<span class="text-xs font-bold uppercase tracking-wider text-red-300 font-['Orbitron',sans-serif]">
						1 GB Transfer Cap
					</span>
				</div>
				<div class="flex items-center space-x-2">
					<span class="text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold bg-red-500/20 border border-red-400/30 text-red-300">
						{timeLeft}s
					</span>
					<button
						type="button"
						onclick={dismiss}
						class="text-red-300 hover:text-white text-xs px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-400/30 transition-colors cursor-pointer"
						aria-label="Dismiss notification"
					>
						Dismiss
					</button>
				</div>
			</div>

			<p class="text-red-200/90 text-xs leading-relaxed">
				This browser lacks direct disk streaming. Transfers over 1 GB are temporarily disabled to prevent memory crashes. This browser limitation will be resolved in a future update.
			</p>

			<!-- 10-second countdown indicator bar -->
			<div class="w-full bg-black/40 rounded-full h-1 overflow-hidden border border-red-500/20">
				<div
					class="h-full bg-gradient-to-r from-red-500 to-rose-400 rounded-full animate-progress-bar w-full"
					onanimationend={dismiss}
				></div>
			</div>
		</div>
	</aside>
{/if}

<style>
	@keyframes shrinkProgressBar {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}

	.animate-progress-bar {
		transform-origin: left;
		animation: shrinkProgressBar 10s linear forwards;
		will-change: transform;
	}
</style>
