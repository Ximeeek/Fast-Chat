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

<div class="min-h-screen flex items-center justify-center p-4 bg-[#050608] text-zinc-100 font-sans bg-cyber-grid relative overflow-hidden">
	<div class="absolute w-72 h-72 bg-blue-600/15 blur-[90px] pointer-events-none rounded-full"></div>
	<div class="text-center rounded-2xl border border-[#1a2233] bg-[#0a0d16]/90 backdrop-blur-md p-8 max-w-sm w-full shadow-[0_0_50px_rgba(0,0,0,0.8)] relative z-10">
		<div class="inline-block w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-4 shadow-[0_0_15px_rgba(0,229,255,0.3)]"></div>
		<h1 class="text-lg font-bold tracking-widest uppercase mb-1.5 font-['Orbitron',sans-serif] text-white">
			FASTCHAT ROOM
		</h1>
		<p class="text-zinc-400 mb-4 text-xs tracking-wider font-mono">INITIALIZING ROOM...</p>
		<a href="/create" class="text-cyan-400 hover:underline text-xs tracking-wider uppercase font-semibold">Click if not redirected</a>
	</div>
</div>
