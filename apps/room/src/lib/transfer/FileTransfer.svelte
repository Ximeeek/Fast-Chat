<script lang="ts">
	import {
		transferStore,
		activeUploads,
		activeDownloads,
		completedFiles,
		historicalTransfers,
		hasLargeFileRamWarning,
		hasActiveUpload
	} from '$lib/stores/transfer';
	import { isFileSystemAccessSupported, formatFileSize, RAM_HARD_LIMIT_BYTES } from '$lib/transfer';
	import { downloadFiles } from '$lib/transfer/archive';
	import { openDataChannelsCount, hasFailedPeers } from '$lib/stores/webrtc';
	import type { FileSender } from '$lib/transfer/sender';
	import type { FileReceiver } from '$lib/transfer/receiver';
	import type { FileTransferSyncManager } from '$lib/transfer/sync';

	interface Props {
		fileSender?: FileSender | null;
		fileReceiver?: FileReceiver | null;
		fileTransferSync?: FileTransferSyncManager | null;
		username?: string;
	}

	let { fileSender, fileReceiver, fileTransferSync, username = 'anonymous' }: Props = $props();

	let fileInput: HTMLInputElement | null = null;
	let selectedFiles = $state<File[]>([]);
	let isZipping = $state(false);
	let isSending = $state(false);
	let sendError = $state<string | null>(null);

	const isUploadActive = $derived(isSending || $hasActiveUpload);
	const fsSupported = isFileSystemAccessSupported();
	const openChannels = $derived($openDataChannelsCount);
	const hasFailed = $derived($hasFailedPeers);
	const canSendFiles = $derived(openChannels > 0 && !isUploadActive);

	function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files && target.files.length > 0) {
			selectedFiles = Array.from(target.files);
		}
	}

	async function handleSendFiles() {
		if (isUploadActive || !fileSender || selectedFiles.length === 0 || openChannels === 0) return;
		isSending = true;
		sendError = null;

		try {
			for (const file of selectedFiles) {
				try {
					const transfer = await fileSender.sendFile(file, {
						senderUsername: username
					});
					transferStore.addOutgoingTransfer(transfer);
				} catch (err) {
					sendError = err instanceof Error ? err.message : 'Failed to initiate transfer';
				}
			}

			selectedFiles = [];
			if (fileInput) fileInput.value = '';
		} finally {
			isSending = false;
		}
	}

	async function handleAcceptFileSystem(transferId: string) {
		if (!fileReceiver) return;
		try {
			await fileReceiver.acceptWithFileSystem(transferId);
		} catch (err) {
			console.error('Failed to accept transfer via File System Access API:', err);
		}
	}

	async function handleAcceptBlob(transferId: string) {
		if (!fileReceiver) return;
		try {
			await fileReceiver.acceptWithBlob(transferId);
		} catch (err) {
			sendError = err instanceof Error ? err.message : 'Failed to accept transfer via Blob fallback';
			console.error('Failed to accept transfer via Blob fallback:', err);
		}
	}

	async function handleDownloadAll() {
		if ($completedFiles.length === 0 || isZipping) return;
		isZipping = true;
		try {
			await downloadFiles($completedFiles);
		} catch (err) {
			console.error('Failed to bundle files into ZIP:', err);
		} finally {
			isZipping = false;
		}
	}

	function handleCancelOutgoing(transferId: string, peerId?: string) {
		fileSender?.cancelTransfer(transferId, peerId, 'Cancelled by local user');
	}

	function handleAbortIncoming(transferId: string) {
		fileReceiver?.abortTransfer(transferId, 'Cancelled by local user');
	}

	async function handleRequestHistoricalFile(fileId: string) {
		if (!fileTransferSync) return;
		try {
			await fileTransferSync.requestFile(fileId);
		} catch (err) {
			console.error('Failed to request historical file:', err);
		}
	}
</script>

<section class="rounded-2xl border border-[#1a2233] bg-[#0a0d16]/95 backdrop-blur-md space-y-5 p-5 sm:p-6 font-['Inter',sans-serif] text-zinc-100 shadow-[0_4px_25px_rgba(0,0,0,0.5)]">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between pb-3.5 border-b border-white/5 gap-2.5">
		<div class="flex items-center space-x-2.5">
			<span class="text-xs sm:text-sm font-bold uppercase tracking-wider text-white font-['Orbitron',sans-serif]">FILE TRANSFER</span>
			{#if fsSupported}
				<span class="text-[10px] px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 uppercase font-medium font-mono" title="Streaming directly to disk without RAM buffer">
					DISK STREAMING
				</span>
			{/if}
		</div>

		{#if $completedFiles.length > 0}
			<button
				type="button"
				onclick={handleDownloadAll}
				disabled={isZipping}
				class="min-h-[38px] px-4 py-1.5 rounded-full bg-white hover:bg-zinc-200 active:scale-[0.99] disabled:opacity-50 text-black text-xs font-bold uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(255,255,255,0.2)] cursor-pointer disabled:cursor-not-allowed"
			>
				{#if isZipping}
					ARCHIVING ZIP...
				{:else if $completedFiles.length === 1}
					DOWNLOAD FILE
				{:else}
					DOWNLOAD ALL ({$completedFiles.length}) [.ZIP]
				{/if}
			</button>
		{/if}
	</div>

	<!-- Send Files Input Zone -->
	<div class="space-y-3">
		<div class="flex flex-wrap items-center gap-3">
			<input
				type="file"
				bind:this={fileInput}
				multiple
				disabled={isUploadActive}
				onchange={handleFileSelect}
				class="text-xs text-zinc-400 file:mr-3 file:py-2 file:px-4 file:rounded-full file:border file:border-white/10 file:bg-[#111624] file:text-zinc-200 hover:file:border-cyan-400 file:text-xs file:font-semibold file:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			/>
			{#if selectedFiles.length > 0}
				<button
					type="button"
					onclick={handleSendFiles}
					disabled={!canSendFiles}
					class="min-h-[38px] px-5 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase tracking-wider text-xs transition-all shadow-[0_0_15px_rgba(0,102,255,0.3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
					title={openChannels === 0 ? 'No open WebRTC peer connections available for file transfer' : ''}
				>
					Send {selectedFiles.length} {selectedFiles.length === 1 ? 'file' : 'files'}
				</button>
			{/if}

			{#if selectedFiles.length > 0 && openChannels === 0}
				<span class="text-xs text-amber-400 bg-amber-950/40 px-3.5 py-1.5 rounded-full border border-amber-500/30 font-medium font-mono">
					No open WebRTC peer connections available
				</span>
			{/if}

			{#if isUploadActive}
				<span class="text-xs text-cyan-300 bg-cyan-950/40 px-3.5 py-1.5 rounded-full border border-cyan-500/30 font-medium flex items-center gap-2">
					<span class="inline-block w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#00e5ff]"></span>
					STREAMING TO MESH...
				</span>
			{/if}
		</div>

		{#if sendError}
			<div role="alert" class="p-3 rounded-xl text-xs bg-red-950/40 border border-red-500/40 text-red-300">
				{sendError}
			</div>
		{/if}
	</div>

	<!-- Global High RAM Warning Banner -->
	{#if $hasLargeFileRamWarning}
		<div role="alert" class="p-3.5 rounded-xl bg-amber-950/30 border border-amber-500/40 text-amber-300 text-xs space-y-1">
			<div class="font-bold flex items-center space-x-1.5 uppercase tracking-wider font-['Orbitron',sans-serif] text-[11px]">
				<svg class="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
					<line x1="12" x2="12" y1="9" y2="13"/>
					<line x1="12" x2="12.01" y1="17" y2="17"/>
				</svg>
				<span>High RAM Usage Warning (>500MB)</span>
			</div>
			<p class="text-[11px] text-amber-300/80 leading-relaxed">
				Your browser does not support the File System Access API. Receiving files over 500MB requires assembling chunks in memory, which may cause high RAM usage.
			</p>
		</div>
	{/if}

	<!-- Outgoing Transfers (Per-Recipient Mesh Progress) -->
	{#if $activeUploads.length > 0}
		<div class="space-y-3 pt-2">
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 font-mono">
				OUTGOING TRANSFERS
			</h3>

			{#each $activeUploads as transfer (transfer.transferId)}
				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-2.5 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%] text-zinc-200" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-zinc-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<!-- Per-Recipient Progress Bars -->
					<div class="space-y-2 pt-1">
						{#each Array.from(transfer.recipients.entries()) as [peerId, prog] (peerId)}
							<div class="space-y-1.5 bg-[#0a0d16] p-2.5 rounded-lg border border-white/5">
								<div class="flex items-center justify-between text-[11px] text-zinc-400">
									<span class="font-mono text-zinc-500">PEER: {peerId.slice(0, 8)}...</span>
									<div class="flex items-center space-x-2">
										<span class="uppercase font-bold {prog.status === 'completed' ? 'text-cyan-400' : prog.status === 'failed' ? 'text-red-400' : 'text-zinc-300'}">
											{prog.status}
										</span>
										<span class="font-mono text-zinc-400">{prog.percentage}%</span>
										{#if prog.status === 'sending' || prog.status === 'offered'}
											<button
												type="button"
												onclick={() => handleCancelOutgoing(transfer.transferId, peerId)}
												class="text-red-400 hover:text-red-300 ml-1 cursor-pointer"
												title="Cancel transfer to this peer"
											>
												<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<line x1="18" y1="6" x2="6" y2="18"/>
													<line x1="6" y1="6" x2="18" y2="18"/>
												</svg>
											</button>
										{/if}
									</div>
								</div>
								<div class="w-full bg-[#06080e] rounded-full h-1.5 overflow-hidden border border-white/5">
									<div
										class="h-full rounded-full transition-all duration-200 {prog.status === 'completed' ? 'bg-cyan-400' : 'bg-gradient-to-r from-blue-500 to-cyan-400'}"
										style="width: {prog.percentage}%"
									></div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Incoming Transfers -->
	{#if $activeDownloads.length > 0}
		<div class="space-y-3 pt-2">
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 font-mono">
				INCOMING TRANSFERS
			</h3>

			{#each $activeDownloads as transfer (transfer.transferId)}
				<div class="p-3.5 rounded-xl bg-[#06080e] border border-white/5 space-y-2.5 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%] text-zinc-200" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-zinc-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<div class="text-[11px] text-zinc-400 flex items-center justify-between">
						<span>FROM: <strong class="font-mono text-zinc-200">{transfer.sender}</strong></span>
						<span class="uppercase font-bold text-cyan-400 font-mono">{transfer.status}</span>
					</div>

					<!-- Offered State Acceptance Options -->
					{#if transfer.status === 'offered'}
						{#if transfer.ramLimitExceeded}
							<div role="alert" class="p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-[11px] space-y-1">
								<div class="font-bold flex items-center space-x-1.5 text-red-300 uppercase font-['Orbitron',sans-serif]">
									<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<circle cx="12" cy="12" r="10"/>
										<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
									</svg>
									<span>File exceeds browser memory limits</span>
								</div>
								<p class="text-[11px] text-red-400 leading-relaxed">
									File size ({formatFileSize(transfer.fileSize)}) exceeds the {formatFileSize(RAM_HARD_LIMIT_BYTES)} in-memory assembly limit for browsers without File System Access API support. Transfer cannot be accepted.
								</p>
							</div>
						{:else if transfer.ramWarning}
							<div class="p-2.5 rounded-xl bg-amber-950/30 border border-amber-500/40 text-amber-300 text-[11px] flex items-center gap-2">
								<svg class="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
									<line x1="12" x2="12" y1="9" y2="13"/>
									<line x1="12" x2="12.01" y1="17" y2="17"/>
								</svg>
								<span>File is over 500MB ({formatFileSize(transfer.fileSize)}). Browser lacks disk streaming; memory buffer required.</span>
							</div>
						{/if}

						<div class="flex items-center space-x-2 pt-1">
							{#if fsSupported}
								<button
									type="button"
									onclick={() => handleAcceptFileSystem(transfer.transferId)}
									class="min-h-[36px] px-4 py-1.5 rounded-full bg-white hover:bg-zinc-200 text-black font-bold uppercase text-xs transition-all cursor-pointer shadow-sm"
								>
									Save to Disk (Stream)
								</button>
							{/if}
							{#if !transfer.ramLimitExceeded && (!fsSupported || transfer.fileSize <= RAM_HARD_LIMIT_BYTES)}
								<button
									type="button"
									onclick={() => handleAcceptBlob(transfer.transferId)}
									class="min-h-[36px] px-4 py-1.5 rounded-full bg-[#111624] hover:bg-[#182033] text-zinc-200 border border-white/10 hover:border-cyan-400 font-bold uppercase text-xs transition-all cursor-pointer"
								>
									{fsSupported ? 'Download to RAM' : 'Accept & Download'}
								</button>
							{/if}
							<button
								type="button"
								onclick={() => handleAbortIncoming(transfer.transferId)}
								class="min-h-[36px] px-3.5 py-1.5 rounded-full bg-black/40 hover:bg-red-950/40 text-zinc-400 hover:text-red-400 border border-white/10 text-xs uppercase transition-all cursor-pointer"
							>
								{transfer.ramLimitExceeded ? 'Dismiss' : 'Decline'}
							</button>
						</div>
					{:else if transfer.status === 'receiving'}
						<!-- Receiving Progress Bar -->
						<div class="space-y-1.5 pt-1">
							<div class="flex justify-between text-[11px] text-zinc-400 font-mono">
								<span>{formatFileSize(transfer.bytesReceived)} / {formatFileSize(transfer.fileSize)}</span>
								<span>{Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)}%</span>
							</div>
							<div class="w-full bg-[#06080e] rounded-full h-1.5 overflow-hidden border border-white/5">
								<div
									class="bg-gradient-to-r from-blue-500 to-cyan-400 h-full rounded-full transition-all duration-200"
									style="width: {Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)}%"
								></div>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Earlier Transfers (Synchronized History from Room Participants) -->
	{#if $historicalTransfers.length > 0}
		<div class="space-y-3 pt-3 border-t border-white/5" data-testid="historical-transfers-section">
			<div class="flex items-center justify-between">
				<h3 class="text-[11px] font-bold uppercase tracking-wider text-cyan-400 font-mono flex items-center gap-1.5">
					<svg class="w-3.5 h-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"/>
						<polyline points="12 6 12 12 16 14"/>
					</svg>
					<span>EARLIER TRANSFERS ({$historicalTransfers.length})</span>
				</h3>
				<span class="text-[10px] text-zinc-500 font-mono uppercase">On-Demand Sync</span>
			</div>

			<ul class="space-y-2.5 text-xs">
				{#each $historicalTransfers as file (file.fileId)}
					<li class="p-3.5 rounded-xl bg-[#06080e] border border-cyan-500/20 hover:border-cyan-500/40 space-y-2 transition-colors" data-testid="historical-file-{file.fileId}">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div class="flex items-center space-x-2.5 truncate max-w-[70%]">
								<svg class="w-4 h-4 text-cyan-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
									<polyline points="14 2 14 8 20 8"/>
									<line x1="16" y1="13" x2="8" y2="13"/>
									<line x1="16" y1="17" x2="8" y2="17"/>
								</svg>
								<span class="font-medium truncate text-zinc-200" title={file.fileName}>{file.fileName}</span>
								<span class="text-zinc-500 text-[11px] font-mono">({formatFileSize(file.fileSize)})</span>
							</div>

							<!-- Action Buttons / Status Badges -->
							<div class="flex items-center space-x-2">
								{#if file.status === 'available'}
									<button
										type="button"
										onclick={() => handleRequestHistoricalFile(file.fileId)}
										class="min-h-[32px] px-3.5 py-1 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold uppercase text-[11px] transition-all cursor-pointer shadow-[0_0_12px_rgba(0,229,255,0.25)] flex items-center gap-1.5"
										data-testid="download-historical-btn"
									>
										<svg class="w-3 h-3 text-black" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
											<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
											<polyline points="7 10 12 15 17 10"/>
											<line x1="12" x2="12" y1="15" y2="3"/>
										</svg>
										<span>Download</span>
									</button>
								{:else if file.status === 'requesting'}
									<span class="text-[10px] px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 uppercase font-mono font-bold animate-pulse flex items-center gap-1.5">
										<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
										Requesting...
									</span>
								{:else if file.status === 'downloading'}
									<span class="text-[10px] px-2.5 py-1 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 uppercase font-mono font-bold flex items-center gap-1.5">
										<span class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
										Downloading ({file.progress ?? 0}%)
									</span>
								{:else if file.status === 'completed'}
									{#if file.downloadUrl || file.blob}
										<a
											href={file.downloadUrl || (file.blob ? URL.createObjectURL(file.blob) : '#')}
											download={file.fileName}
											class="min-h-[32px] px-3.5 py-1 rounded-full bg-white hover:bg-zinc-200 text-black font-bold uppercase text-[11px] transition-all shrink-0 flex items-center gap-1.5 shadow-sm"
										>
											<svg class="w-3 h-3 text-cyan-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
												<polyline points="20 6 9 17 4 12"/>
											</svg>
											<span>Save File</span>
										</a>
									{:else}
										<span class="text-[10px] px-2.5 py-1 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 uppercase font-mono font-bold">
											Completed
										</span>
									{/if}
								{:else if file.status === 'unavailable'}
									<span class="text-[10px] px-2.5 py-1 rounded-full bg-red-950/40 text-red-400 border border-red-500/30 uppercase font-mono font-bold flex items-center gap-1">
										<svg class="w-3 h-3 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<circle cx="12" cy="12" r="10"/>
											<line x1="15" y1="9" x2="9" y2="15"/>
											<line x1="9" y1="9" x2="15" y2="15"/>
										</svg>
										<span>Unavailable</span>
									</span>
								{/if}
							</div>
						</div>

						<!-- Metadata subtitle: Sender & Timestamp -->
						<div class="text-[11px] text-zinc-400 flex items-center justify-between font-mono">
							<span>FROM: <strong class="text-zinc-300">{file.senderUsername || file.senderPeerId.slice(0, 8) + '...'}</strong></span>
							<span class="text-zinc-500">{new Date(file.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
						</div>

						<!-- Progress bar during active downloading -->
						{#if file.status === 'downloading' && typeof file.progress === 'number'}
							<div class="w-full bg-[#030407] rounded-full h-1.5 overflow-hidden border border-white/5 mt-1.5">
								<div
									class="bg-gradient-to-r from-blue-500 to-cyan-400 h-full rounded-full transition-all duration-200"
									style="width: {file.progress}%"
								></div>
							</div>
						{/if}

						<!-- Explicit error message banner for unavailable files -->
						{#if file.status === 'unavailable'}
							<div role="alert" class="p-2 rounded-lg bg-red-950/30 border border-red-500/30 text-red-300 text-[11px] font-mono flex items-center gap-1.5 mt-1">
								<svg class="w-3.5 h-3.5 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="12" cy="12" r="10"/>
									<line x1="12" y1="8" x2="12" y2="12"/>
									<line x1="12" y1="16" x2="12.01" y2="16"/>
								</svg>
								<span>{file.error || 'File unavailable: original sender has left the room'}</span>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Completed Files List -->
	{#if $completedFiles.length > 0}
		<div class="space-y-2.5 pt-3 border-t border-white/5">
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 font-mono">
				COMPLETED FILES ({$completedFiles.length})
			</h3>
			<ul class="space-y-2 text-xs">
				{#each $completedFiles as file (file.transferId)}
					<li class="p-3 rounded-xl bg-[#06080e] border border-white/5 flex items-center justify-between">
						<div class="flex items-center space-x-2.5 truncate">
							<svg class="w-4 h-4 text-cyan-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="20 6 9 17 4 12"/>
							</svg>
							<span class="font-medium truncate text-zinc-200" title={file.fileName}>{file.fileName}</span>
							<span class="text-zinc-500 text-[11px] font-mono">({formatFileSize(file.fileSize)})</span>
							{#if file.storageMode === 'filesystem'}
								<span class="text-[10px] text-cyan-300 bg-cyan-950/40 px-2 py-0.5 rounded-full border border-cyan-500/30 uppercase font-mono">
									SAVED TO DISK
								</span>
							{/if}
						</div>

						{#if file.downloadUrl || file.blob}
							<a
								href={file.downloadUrl || (file.blob ? URL.createObjectURL(file.blob) : '#')}
								download={file.fileName}
								class="px-3.5 py-1 rounded-full bg-cyan-500/15 hover:bg-cyan-500 text-cyan-300 hover:text-black border border-cyan-500/30 font-bold uppercase text-[11px] transition-all shrink-0"
							>
								DOWNLOAD
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
