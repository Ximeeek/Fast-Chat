<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { ChatMessage } from './types.ts';
	import { getSystemEventType, getSystemEventStyle } from './systemEvents.ts';

	interface Props {
		message: ChatMessage;
	}

	let { message }: Props = $props();

	const text = $derived(
		Array.isArray(message.segments)
			? message.segments.map((s) => (s.type === 'text' ? s.text : '')).join('')
			: ((message as any).content || '')
	);

	const eventType = $derived(getSystemEventType(text, message.systemType));
	const style = $derived(getSystemEventStyle(eventType));

	const extractedCode = $derived.by(() => {
		const match = text.match(/\b\d{4}-\d{4}-\d{4}\b/);
		return match ? match[0] : null;
	});

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	async function copyCode(codeToCopy: string) {
		try {
			await navigator.clipboard.writeText(codeToCopy);
			copied = true;
			if (copyTimeout) clearTimeout(copyTimeout);
			copyTimeout = setTimeout(() => {
				copied = false;
				copyTimeout = null;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy rotated room code:', err);
		}
	}

	onDestroy(() => {
		if (copyTimeout) clearTimeout(copyTimeout);
	});
</script>

<div class="flex items-center justify-center my-2" data-testid="system-message" data-event-type={eventType}>
	<div
		class="px-3.5 py-1.5 rounded-full {style.containerClass} text-[11px] font-mono flex items-center gap-2 max-w-[90%] text-center border transition-micro flex-wrap justify-center"
		role="status"
		aria-label="{style.ariaLabel}: {text}"
	>
		<!-- Left Icon indicator matching event type -->
		{#if eventType === 'join'}
			<!-- Arrow pointing right for peer/user join -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<line x1="5" y1="12" x2="19" y2="12" />
				<polyline points="12 5 19 12 12 19" />
			</svg>
		{:else if eventType === 'leave'}
			<!-- Arrow pointing left for peer/user leave -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<line x1="19" y1="12" x2="5" y2="12" />
				<polyline points="12 19 5 12 12 5" />
			</svg>
		{:else if eventType === 'mute'}
			<!-- Muted microphone -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<line x1="1" y1="1" x2="23" y2="23" />
				<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
				<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
				<line x1="12" y1="19" x2="12" y2="23" />
				<line x1="8" y1="23" x2="16" y2="23" />
			</svg>
		{:else if eventType === 'unmute'}
			<!-- Active microphone -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
				<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
				<line x1="12" y1="19" x2="12" y2="23" />
				<line x1="8" y1="23" x2="16" y2="23" />
			</svg>
		{:else if eventType === 'lock'}
			<!-- Lock closed -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
				<path d="M7 11V7a5 5 0 0 1 10 0v4" />
			</svg>
		{:else if eventType === 'unlock'}
			<!-- Lock open -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
				<path d="M7 11V7a5 5 0 0 1 9.9-1" />
			</svg>
		{:else if eventType === 'owner'}
			<!-- Crown indicator -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z" />
			</svg>
		{:else if eventType === 'security'}
			<!-- Shield protection -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				<polyline points="9 12 11 14 15 10" />
			</svg>
		{:else if eventType === 'closing'}
			<!-- Countdown clock -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<polyline points="12 6 12 12 16 14" />
			</svg>
		{:else if eventType === 'rotated'}
			<!-- Rotation arrows -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
			</svg>
		{:else}
			<!-- Information bubble -->
			<svg
				class="w-3.5 h-3.5 {style.iconClass} shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" />
				<line x1="12" y1="16" x2="12" y2="12" />
				<line x1="12" y1="8" x2="12.01" y2="8" />
			</svg>
		{/if}

		<span>{text}</span>

		{#if extractedCode}
			<button
				type="button"
				onclick={() => copyCode(extractedCode)}
				class="ml-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase transition-all flex items-center gap-1 cursor-pointer select-none {copied
					? 'bg-cyan-400 text-black shadow-[0_0_8px_#00e5ff]'
					: 'bg-white/10 hover:bg-white/20 text-cyan-300 border border-cyan-400/30'}"
				aria-label="Copy room code {extractedCode}"
				title="Copy room code"
			>
				{#if copied}
					<svg class="w-3 h-3 stroke-[2.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="20 6 9 17 4 12"/>
					</svg>
					<span>COPIED</span>
				{:else}
					<svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
					</svg>
					<span>COPY</span>
				{/if}
			</button>
		{/if}
	</div>
</div>
