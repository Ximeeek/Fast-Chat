<script lang="ts">
	import { hasRelayedPeers, openDataChannelsCount, hasFailedPeers } from '$lib/stores/webrtc';
	import { peerCount } from '$lib/stores/room';

	const totalPeers = $derived($peerCount);
	const isRelayed = $derived($hasRelayedPeers);
	const openChannels = $derived($openDataChannelsCount);
	const hasFailed = $derived($hasFailedPeers);

	const isFailedState = $derived(totalPeers > 0 && openChannels === 0 && hasFailed);

	const statusText = $derived.by(() => {
		if (totalPeers === 0) return 'P2P WAITING';
		if (isFailedState) return 'CONNECTION FAILED';
		if (openChannels === 0) return 'P2P CONNECTING';
		if (isRelayed) return 'RELAYED (TURN)';
		return 'DIRECT P2P';
	});

	const statusTitle = $derived.by(() => {
		if (totalPeers === 0) return 'No WebRTC peers connected yet';
		if (isFailedState) return 'WebRTC peer connection failed. Retry available on participant.';
		if (openChannels === 0) return 'Establishing WebRTC peer connections...';
		if (isRelayed) return `Traversing TURN relay (${openChannels} data channels open)`;
		return `Direct encrypted peer-to-peer connection (${openChannels} data channels open)`;
	});
</script>

<div
	class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#0a0d16] border border-white/10 font-mono text-[10px] uppercase font-semibold transition-all select-none shadow-[0_0_15px_rgba(0,0,0,0.4)]"
	title={statusTitle}
>
	<span
		class="inline-block w-2 h-2 rounded-full {totalPeers === 0
			? 'bg-zinc-600'
			: isFailedState
				? 'bg-red-500 shadow-[0_0_8px_#ef4444]'
				: openChannels === 0
					? 'bg-amber-400 animate-pulse shadow-[0_0_8px_#fbbf24]'
					: isRelayed
						? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]'
						: 'bg-cyan-400 shadow-[0_0_8px_#00e5ff]'}"
	></span>
	<span
		class={totalPeers === 0
			? 'text-zinc-500'
			: isFailedState
				? 'text-red-400'
				: openChannels === 0
					? 'text-amber-400'
					: isRelayed
						? 'text-amber-400'
						: 'text-zinc-300'}
	>
		{statusText}
	</span>
</div>
