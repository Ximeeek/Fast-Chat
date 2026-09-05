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

<div class="min-h-screen flex items-center justify-center p-4 bg-gray-50 text-gray-800">
	<div class="text-center">
		<h1 class="text-2xl font-bold mb-2">FastChat Room</h1>
		<p class="text-gray-500 mb-4 text-sm">Redirecting to room creation...</p>
		<a href="/create" class="text-blue-600 underline text-sm">Click here if not redirected automatically</a>
	</div>
</div>
