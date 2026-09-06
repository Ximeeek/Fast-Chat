<script lang="ts">
	import { onMount } from 'svelte';
	import { highlightCode, escapeHtml } from './highlighter.ts';
	import { getLanguageDisplayName } from './languageDetection.ts';

	interface Props {
		content: string;
		language?: string | null;
	}

	let { content, language = null }: Props = $props();

	let highlightedHtml = $state('');
	let isCopied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	const displayLanguage = $derived(getLanguageDisplayName(language).toUpperCase());

	$effect(() => {
		highlightedHtml = escapeHtml(content);
		let isCancelled = false;
		highlightCode(content, language).then((html) => {
			if (!isCancelled) {
				highlightedHtml = html;
			}
		});
		return () => {
			isCancelled = true;
		};
	});

	async function handleCopy() {
		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard) {
				await navigator.clipboard.writeText(content);
				isCopied = true;
				if (copyTimeout) clearTimeout(copyTimeout);
				copyTimeout = setTimeout(() => {
					isCopied = false;
				}, 2000);
			}
		} catch (err) {
			console.error('Failed to copy code snippet to clipboard:', err);
		}
	}
</script>

<div class="w-full my-1 rounded-xl overflow-hidden border border-white/10 bg-[#04060b] shadow-[0_4px_20px_rgba(0,0,0,0.6)] font-mono">
	<!-- Code Header Bar -->
	<div class="flex items-center justify-between px-3.5 py-2 bg-[#080c16] border-b border-white/5 select-none">
		<div class="flex items-center gap-2">
			<span class="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_6px_#00e5ff]"></span>
			<span class="text-[11px] font-bold tracking-wider text-cyan-300 uppercase">
				{displayLanguage}
			</span>
		</div>
		<button
			type="button"
			onclick={handleCopy}
			class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono transition-all cursor-pointer border {isCopied ? 'bg-emerald-950/50 border-emerald-500/50 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'bg-[#0f1422] hover:bg-[#161e33] border-white/10 text-zinc-300 hover:text-white'}"
			title="Copy raw code to clipboard"
			aria-label="Copy code to clipboard"
		>
			{#if isCopied}
				<svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="20 6 9 17 4 12"/>
				</svg>
				<span>Copied!</span>
			{:else}
				<svg class="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
				</svg>
				<span>Copy</span>
			{/if}
		</button>
	</div>

	<!-- Highlighted Code Body -->
	<pre class="p-3.5 text-xs overflow-x-auto leading-relaxed text-zinc-200 selection:bg-cyan-500/30 selection:text-white"><code class="font-mono">{@html highlightedHtml}</code></pre>
</div>

<style>
	:global(.token.comment),
	:global(.token.prolog),
	:global(.token.doctype),
	:global(.token.cdata) {
		color: #71717a;
		font-style: italic;
	}

	:global(.token.punctuation) {
		color: #94a3b8;
	}

	:global(.token.property),
	:global(.token.tag),
	:global(.token.boolean),
	:global(.token.number),
	:global(.token.constant),
	:global(.token.symbol),
	:global(.token.deleted) {
		color: #f59e0b;
	}

	:global(.token.selector),
	:global(.token.attr-name),
	:global(.token.string),
	:global(.token.char),
	:global(.token.builtin),
	:global(.token.inserted) {
		color: #34d399;
	}

	:global(.token.operator),
	:global(.token.entity),
	:global(.token.url) {
		color: #38bdf8;
	}

	:global(.token.atrule),
	:global(.token.attr-value),
	:global(.token.keyword) {
		color: #00e5ff;
		font-weight: 600;
	}

	:global(.token.function),
	:global(.token.class-name) {
		color: #c084fc;
	}

	:global(.token.regex),
	:global(.token.important),
	:global(.token.variable) {
		color: #fbbf24;
	}
</style>
