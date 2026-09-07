<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut, cubicIn } from 'svelte/easing';

	interface Props {
		message: string | null;
		title?: string;
		onDismiss?: () => void;
	}

	let { message = null, title = 'Action Failed', onDismiss }: Props = $props();

	let isVisible = $state(false);
	let isHovered = $state(false);
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function clearDismissTimer() {
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
	}

	function startTimer(durationMs: number) {
		clearDismissTimer();
		dismissTimer = setTimeout(() => {
			closeNotice();
		}, durationMs);
	}

	function closeNotice() {
		clearDismissTimer();
		isVisible = false;
		onDismiss?.();
	}

	function handleMouseEnter() {
		isHovered = true;
		clearDismissTimer();
	}

	function handleMouseLeave() {
		isHovered = false;
		startTimer(1500);
	}

	$effect(() => {
		if (message) {
			isVisible = true;
			if (!isHovered) {
				startTimer(4500);
			}
		} else {
			clearDismissTimer();
			isVisible = false;
		}
	});

	onDestroy(() => {
		clearDismissTimer();
	});
</script>

{#if isVisible && message}
	<!-- Mobile Alert Modal (< 640px) -->
	<div
		in:fade={{ duration: 250 }}
		out:fade={{ duration: 200 }}
		class="block sm:hidden fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 font-['Inter',sans-serif]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="error-toast-mobile-title"
		tabindex="-1"
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
					<span id="error-toast-mobile-title" class="text-xs font-bold uppercase tracking-wider text-red-300 font-['Orbitron',sans-serif]">
						{title}
					</span>
				</div>
			</div>

			<div class="space-y-1.5">
				<p class="text-red-200/90 text-xs leading-relaxed font-mono break-words">
					{message}
				</p>
			</div>

			<button
				type="button"
				onclick={closeNotice}
				class="w-full py-2.5 px-4 rounded-xl bg-red-500/25 hover:bg-red-500/35 active:bg-red-500/40 border border-red-400/40 text-red-100 font-bold uppercase tracking-wider text-xs transition-all cursor-pointer shadow-sm"
			>
				Dismiss
			</button>
		</div>
	</div>

	<!-- Desktop Bottom-Right Notification (>= 640px) -->
	<aside
		in:fly={{ y: 32, duration: 400, easing: cubicOut }}
		out:fly={{ y: 24, duration: 300, easing: cubicIn }}
		onmouseenter={handleMouseEnter}
		onmouseleave={handleMouseLeave}
		class="hidden sm:block fixed bottom-5 right-5 z-50 max-w-sm w-full p-4 rounded-2xl bg-[#240e14]/95 border border-red-400/50 text-red-100 shadow-[0_0_35px_rgba(248,113,113,0.25)] backdrop-blur-xl font-['Inter',sans-serif] transition-opacity duration-300 {isHovered ? 'opacity-100 ring-1 ring-red-400/40' : 'opacity-95'}"
		role="alert"
		aria-live="polite"
	>
		<div class="space-y-2.5">
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
						{title}
					</span>
				</div>
				<button
					type="button"
					onclick={closeNotice}
					class="text-red-300 hover:text-white text-xs px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-400/30 transition-colors cursor-pointer"
					aria-label="Dismiss notification"
				>
					Dismiss
				</button>
			</div>

			<p class="text-red-200/90 text-xs leading-relaxed font-mono break-words">
				{message}
			</p>
		</div>
	</aside>
{/if}
