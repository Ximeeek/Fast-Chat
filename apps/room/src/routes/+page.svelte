<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	onMount(() => {
		goto('/create', { replaceState: true });
	});
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4 bg-[#0a0a0a] text-zinc-100 font-mono">
	<div class="text-center border border-[#262626] bg-[#121212] p-8 max-w-sm w-full">
		<h1 class="text-xl font-bold tracking-wider uppercase mb-2">FASTCHAT // ROOM</h1>
		<p class="text-zinc-500 mb-4 text-xs tracking-wide">DISPATCHING SESSION...</p>
		<a href="/create" class="text-[#ccff00] hover:underline text-xs tracking-wider uppercase">Click if not redirected</a>
	</div>
</div>
