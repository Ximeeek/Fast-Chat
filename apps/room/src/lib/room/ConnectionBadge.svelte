<script lang="ts">
	import { hasRelayedPeers, openDataChannelsCount } from '$lib/stores/webrtc';
	import { peerCount } from '$lib/stores/room';

	const totalPeers = $derived($peerCount);
	const isRelayed = $derived($hasRelayedPeers);
	const openChannels = $derived($openDataChannelsCount);

	const statusText = $derived.by(() => {
		if (totalPeers === 0) return 'P2P WAITING';
		if (isRelayed) return 'RELAYED (TURN)';
		return 'DIRECT P2P';
	});

	const statusTitle = $derived.by(() => {
		if (totalPeers === 0) return 'No WebRTC peers connected yet';
		if (isRelayed) return `Traversing TURN relay (${openChannels} data channels open)`;
		return `Direct encrypted peer-to-peer connection (${openChannels} data channels open)`;
	});
</script>

<div
	class="inline-flex items-center space-x-1.5 px-2.5 py-1 bg-black border border-[#262626] font-mono text-[10px] uppercase font-semibold transition-micro select-none"
	title={statusTitle}
>
	<span
		class="inline-block w-2 h-2 {totalPeers === 0
			? 'bg-zinc-600'
			: isRelayed
				? 'bg-amber-400 animate-pulse'
				: 'bg-[#ccff00]'}"
	></span>
	<span
		class={totalPeers === 0
			? 'text-zinc-500'
			: isRelayed
				? 'text-amber-400'
				: 'text-zinc-300'}
	>
		{statusText}
	</span>
</div>
