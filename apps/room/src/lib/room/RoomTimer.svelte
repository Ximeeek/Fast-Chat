<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { signalingClient } from '$lib/signaling/client';
	import { roomStore } from '$lib/stores/room';

	interface Props {
		expiresAt: number | null;
		roomCode: string;
		peerId: string | null;
		isOwner: boolean;
		lifecycle: string;
		onExtended?: (newExpiresAt: number) => void;
	}

	let {
		expiresAt,
		roomCode,
		peerId,
		isOwner,
		lifecycle,
		onExtended
	}: Props = $props();

	let now = $state(Math.floor(Date.now() / 1000));
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let isExtending = $state(false);
	let extendError = $state<string | null>(null);

	onMount(() => {
		now = Math.floor(Date.now() / 1000);
		timerInterval = setInterval(() => {
			now = Math.floor(Date.now() / 1000);
		}, 1000);
	});

	onDestroy(() => {
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	});

	const remainingSeconds = $derived.by(() => {
		if (!expiresAt) return null;
		const diff = expiresAt - now;
		return diff > 0 ? diff : 0;
	});

	// ExtendableWindow from Phase 2 state machine: remaining <= 2:00 (120s) and room active
	const isInExtendableWindow = $derived(
		remainingSeconds !== null &&
		remainingSeconds <= 120 &&
		remainingSeconds > 0 &&
		lifecycle === 'joined'
	);

	const canExtend = $derived(
		isInExtendableWindow &&
		isOwner &&
		!isExtending &&
		Boolean(peerId && roomCode)
	);

	function formatTime(totalSec: number): string {
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}

	async function handleExtend() {
		if (!canExtend || !peerId || !roomCode) return;
		isExtending = true;
		extendError = null;

		try {
			await signalingClient.extendRoom(roomCode, peerId);
			const currentBase = expiresAt && expiresAt > now ? expiresAt : now;
			const newExpiresAt = currentBase + 300;
			roomStore.updateExpiresAt(newExpiresAt);
			onExtended?.(newExpiresAt);
		} catch (err) {
			extendError = err instanceof Error ? err.message : 'Failed to extend room';
			setTimeout(() => {
				extendError = null;
			}, 4000);
		} finally {
			isExtending = false;
		}
	}
</script>

<div class="flex items-center gap-2 font-mono">
	<!-- Server-Synced Countdown Timer -->
	<div
		class="px-3.5 py-1.5 rounded-xl bg-[#06080e] border transition-all flex flex-col items-center justify-center min-w-[96px] {isInExtendableWindow
			? 'border-amber-500/60 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
			: 'border-white/10 text-white'}"
		title={isInExtendableWindow
			? 'Extendable Window active (< 2:00 remaining)'
			: 'Room lifetime remaining'}
	>
		<div class="text-[9px] uppercase tracking-widest font-semibold {isInExtendableWindow ? 'text-amber-400' : 'text-zinc-500'}">
			EXPIRES IN
		</div>
		<div class="text-base sm:text-lg font-bold tabular-nums tracking-widest leading-none mt-0.5">
			{remainingSeconds !== null ? formatTime(remainingSeconds) : '--:--'}
		</div>
	</div>

	<!-- "+5:00" Extension Action Button -->
	{#if isInExtendableWindow && isOwner}
		<div class="flex flex-col items-start">
			<button
				type="button"
				onclick={handleExtend}
				disabled={!canExtend}
				class="min-h-[40px] px-3.5 py-1 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase tracking-wider text-xs transition-all cursor-pointer shadow-[0_0_15px_rgba(0,102,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
				title="Add 5 minutes to room duration"
			>
				{#if isExtending}
					<span class="inline-block w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
					<span>+5:00...</span>
				{:else}
					<span>+5:00</span>
				{/if}
			</button>
			{#if extendError}
				<span class="text-[9px] text-red-400 mt-1 uppercase max-w-[120px] truncate" title={extendError}>
					{extendError}
				</span>
			{/if}
		</div>
	{/if}
</div>
