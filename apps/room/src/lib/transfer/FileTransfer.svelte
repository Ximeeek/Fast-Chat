<script lang="ts">
	import {
		transferStore,
		activeUploads,
		activeDownloads,
		completedFiles,
		hasLargeFileRamWarning,
		hasActiveUpload
	} from '$lib/stores/transfer';
	import { isFileSystemAccessSupported, formatFileSize, RAM_HARD_LIMIT_BYTES } from '$lib/transfer';
	import { downloadFiles } from '$lib/transfer/archive';
	import type { FileSender } from '$lib/transfer/sender';
	import type { FileReceiver } from '$lib/transfer/receiver';

	interface Props {
		fileSender?: FileSender;
		fileReceiver?: FileReceiver;
		username?: string;
	}

	let { fileSender, fileReceiver, username = 'anonymous' }: Props = $props();

	let fileInput: HTMLInputElement | null = null;
	let selectedFiles = $state<File[]>([]);
	let isZipping = $state(false);
	let isSending = $state(false);
	let sendError = $state<string | null>(null);

	const isUploadActive = $derived(isSending || $hasActiveUpload);
	const fsSupported = isFileSystemAccessSupported();

	function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files && target.files.length > 0) {
			selectedFiles = Array.from(target.files);
		}
	}

	async function handleSendFiles() {
		if (isUploadActive || !fileSender || selectedFiles.length === 0) return;
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
</script>

<section class="border border-[#262626] bg-[#121212] space-y-4 p-4 font-mono text-zinc-100">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between pb-3 border-b border-[#262626] gap-2">
		<div class="flex items-center space-x-2">
			<span class="text-xs font-bold uppercase tracking-wider text-zinc-200">FILE TRANSFER</span>
			<span class="text-[10px] px-2 py-0.5 bg-black text-zinc-400 border border-[#262626] uppercase font-medium">
				P2P ENCRYPTED
			</span>
			{#if fsSupported}
				<span class="text-[10px] px-2 py-0.5 bg-black text-[#ccff00] border border-[#262626] uppercase font-medium" title="Streaming directly to disk without RAM buffer">
					DISK STREAMING
				</span>
			{:else}
				<span class="text-[10px] px-2 py-0.5 bg-black text-amber-400 border border-[#262626] uppercase font-medium" title="In-memory aggregation fallback active">
					RAM BLOB FALLBACK
				</span>
			{/if}
		</div>

		{#if $completedFiles.length > 0}
			<button
				type="button"
				onclick={handleDownloadAll}
				disabled={isZipping}
				class="min-h-[36px] px-3 py-1 bg-[#ccff00] hover:bg-[#b8e600] active:scale-[0.99] disabled:opacity-50 text-black text-xs font-bold uppercase tracking-wider transition-micro cursor-pointer disabled:cursor-not-allowed"
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
		<div class="flex flex-wrap items-center gap-2">
			<input
				type="file"
				bind:this={fileInput}
				multiple
				disabled={isUploadActive}
				onchange={handleFileSelect}
				class="text-xs text-zinc-400 file:mr-3 file:py-2 file:px-3 file:border file:border-[#262626] file:bg-black file:text-zinc-200 hover:file:border-[#ccff00] file:text-xs file:font-mono file:cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			/>
			{#if selectedFiles.length > 0}
				<button
					type="button"
					onclick={handleSendFiles}
					disabled={isUploadActive}
					class="min-h-[36px] px-4 py-1.5 bg-black hover:bg-[#1a1a1a] text-[#ccff00] border border-[#ccff00] disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold uppercase tracking-wider transition-micro cursor-pointer"
				>
					Send {selectedFiles.length} {selectedFiles.length === 1 ? 'file' : 'files'}
				</button>
			{/if}

			{#if isUploadActive}
				<span class="text-xs text-[#ccff00] bg-black px-2.5 py-1.5 border border-[#262626] font-medium flex items-center gap-2">
					<span class="inline-block w-2 h-2 bg-[#ccff00] animate-pulse"></span>
					STREAMING TO MESH...
				</span>
			{/if}
		</div>

		{#if sendError}
			<div role="alert" class="p-2.5 text-xs bg-red-950/40 border border-red-800 text-red-400">
				{sendError}
			</div>
		{/if}
	</div>

	<!-- Global High RAM Warning Banner -->
	{#if $hasLargeFileRamWarning}
		<div role="alert" class="p-3 bg-amber-950/30 border border-amber-800 text-amber-300 text-xs space-y-1">
			<div class="font-bold flex items-center space-x-1.5 uppercase tracking-wider">
				<span>⚠</span>
				<span>High RAM Usage Warning (>500MB)</span>
			</div>
			<p class="text-[11px] text-amber-400 leading-relaxed">
				Your browser does not support the File System Access API. Receiving files over 500MB requires assembling chunks in memory, which may cause high RAM usage.
			</p>
		</div>
	{/if}

	<!-- Outgoing Transfers (Per-Recipient Mesh Progress) -->
	{#if $activeUploads.length > 0}
		<div class="space-y-3 pt-2">
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
				OUTGOING TRANSFERS
			</h3>

			{#each $activeUploads as transfer (transfer.transferId)}
				<div class="p-3 bg-black border border-[#262626] space-y-2 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%] text-zinc-200" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-zinc-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<!-- Per-Recipient Progress Bars -->
					<div class="space-y-2 pt-1">
						{#each Array.from(transfer.recipients.entries()) as [peerId, prog] (peerId)}
							<div class="space-y-1.5 bg-[#121212] p-2 border border-[#1f1f23]">
								<div class="flex items-center justify-between text-[11px] text-zinc-400">
									<span class="font-mono">PEER // {peerId.slice(0, 8)}...</span>
									<div class="flex items-center space-x-2">
										<span class="uppercase font-bold {prog.status === 'completed' ? 'text-[#ccff00]' : prog.status === 'failed' ? 'text-red-400' : 'text-zinc-300'}">
											{prog.status}
										</span>
										<span class="font-mono">{prog.percentage}%</span>
										{#if prog.status === 'sending' || prog.status === 'offered'}
											<button
												type="button"
												onclick={() => handleCancelOutgoing(transfer.transferId, peerId)}
												class="text-red-400 hover:text-red-300 ml-1 cursor-pointer"
												title="Cancel transfer to this peer"
											>
												✕
											</button>
										{/if}
									</div>
								</div>
								<div class="w-full bg-black border border-[#262626] h-1.5 overflow-hidden">
									<div
										class="h-full transition-all duration-200 {prog.status === 'completed' ? 'bg-[#ccff00]' : 'bg-zinc-300'}"
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
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
				INCOMING TRANSFERS
			</h3>

			{#each $activeDownloads as transfer (transfer.transferId)}
				<div class="p-3 bg-black border border-[#262626] space-y-2 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%] text-zinc-200" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-zinc-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<div class="text-[11px] text-zinc-400 flex items-center justify-between">
						<span>FROM: <strong class="font-mono text-zinc-200">{transfer.sender}</strong></span>
						<span class="uppercase font-bold text-[#ccff00]">{transfer.status}</span>
					</div>

					<!-- Offered State Acceptance Options -->
					{#if transfer.status === 'offered'}
						{#if transfer.ramLimitExceeded}
							<div role="alert" class="p-2.5 bg-red-950/40 border border-red-800 text-red-400 text-[11px] space-y-1">
								<div class="font-bold flex items-center space-x-1.5 text-red-300 uppercase">
									<span>🛑</span>
									<span>File exceeds browser memory limits</span>
								</div>
								<p class="text-[11px] text-red-400 leading-relaxed">
									File size ({formatFileSize(transfer.fileSize)}) exceeds the {formatFileSize(RAM_HARD_LIMIT_BYTES)} in-memory assembly limit for browsers without File System Access API support. Transfer cannot be accepted.
								</p>
							</div>
						{:else if transfer.ramWarning}
							<div class="p-2 bg-amber-950/30 border border-amber-800 text-amber-300 text-[11px]">
								⚠ File is over 500MB ({formatFileSize(transfer.fileSize)}). This browser does not support disk streaming; file will consume RAM.
							</div>
						{/if}

						<div class="flex items-center space-x-2 pt-1">
							{#if fsSupported}
								<button
									type="button"
									onclick={() => handleAcceptFileSystem(transfer.transferId)}
									class="min-h-[36px] px-3 py-1.5 bg-[#ccff00] hover:bg-[#b8e600] text-black font-bold uppercase text-xs transition-micro cursor-pointer"
								>
									Save to Disk (Stream)
								</button>
							{/if}
							{#if !transfer.ramLimitExceeded && (!fsSupported || transfer.fileSize <= RAM_HARD_LIMIT_BYTES)}
								<button
									type="button"
									onclick={() => handleAcceptBlob(transfer.transferId)}
									class="min-h-[36px] px-3 py-1.5 bg-black hover:bg-[#1a1a1a] text-zinc-200 border border-[#262626] hover:border-zinc-400 font-bold uppercase text-xs transition-micro cursor-pointer"
								>
									{fsSupported ? 'Download to RAM' : 'Accept & Download'}
								</button>
							{/if}
							<button
								type="button"
								onclick={() => handleAbortIncoming(transfer.transferId)}
								class="min-h-[36px] px-2.5 py-1.5 bg-black hover:bg-[#1a1a1a] text-zinc-400 border border-[#262626] text-xs uppercase transition-micro cursor-pointer"
							>
								{transfer.ramLimitExceeded ? 'Dismiss' : 'Decline'}
							</button>
						</div>
					{:else if transfer.status === 'receiving'}
						<!-- Receiving Progress Bar -->
						<div class="space-y-1 pt-1">
							<div class="flex justify-between text-[11px] text-zinc-400 font-mono">
								<span>{formatFileSize(transfer.bytesReceived)} / {formatFileSize(transfer.fileSize)}</span>
								<span>{Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)}%</span>
							</div>
							<div class="w-full bg-black border border-[#262626] h-1.5 overflow-hidden">
								<div
									class="bg-[#ccff00] h-full transition-all duration-200"
									style="width: {Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)}%"
								></div>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Completed Files List -->
	{#if $completedFiles.length > 0}
		<div class="space-y-2 pt-2 border-t border-[#262626]">
			<h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
				COMPLETED FILES ({$completedFiles.length})
			</h3>
			<ul class="space-y-1.5 text-xs">
				{#each $completedFiles as file (file.transferId)}
					<li class="p-2.5 bg-black border border-[#262626] flex items-center justify-between">
						<div class="flex items-center space-x-2 truncate">
							<span class="text-[#ccff00] font-bold">✓</span>
							<span class="font-medium truncate text-zinc-200" title={file.fileName}>{file.fileName}</span>
							<span class="text-zinc-500 text-[11px] font-mono">({formatFileSize(file.fileSize)})</span>
							{#if file.storageMode === 'filesystem'}
								<span class="text-[10px] text-[#ccff00] bg-black px-1.5 py-0.5 border border-[#262626] uppercase">
									SAVED TO DISK
								</span>
							{/if}
						</div>

						{#if file.downloadUrl || file.blob}
							<a
								href={file.downloadUrl || (file.blob ? URL.createObjectURL(file.blob) : '#')}
								download={file.fileName}
								class="px-2.5 py-1 bg-black hover:bg-[#1a1a1a] text-[#ccff00] border border-[#262626] hover:border-[#ccff00] font-bold uppercase text-[11px] transition-micro shrink-0"
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
