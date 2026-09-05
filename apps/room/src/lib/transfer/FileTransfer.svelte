<script lang="ts">
	import {
		transferStore,
		activeUploads,
		activeDownloads,
		completedFiles,
		hasLargeFileRamWarning
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
	let sendError = $state<string | null>(null);

	const fsSupported = isFileSystemAccessSupported();

	function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (target.files && target.files.length > 0) {
			selectedFiles = Array.from(target.files);
		}
	}

	async function handleSendFiles() {
		if (!fileSender || selectedFiles.length === 0) return;
		sendError = null;

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

<section class="border border-gray-200 rounded-lg overflow-hidden bg-white shadow-sm space-y-4 p-4">
	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between pb-3 border-b border-gray-200 gap-2">
		<div class="flex items-center space-x-2">
			<h2 class="text-xs font-semibold uppercase tracking-wider text-gray-700">File Transfer</h2>
			<span class="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full font-medium">P2P Encrypted</span>
			{#if fsSupported}
				<span class="text-xs px-2 py-0.5 bg-green-100 text-green-800 rounded-full font-medium" title="Streaming directly to disk without RAM buffer">
					Direct Disk Streaming
				</span>
			{:else}
				<span class="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full font-medium" title="In-memory aggregation fallback active">
					RAM Blob Fallback
				</span>
			{/if}
		</div>

		{#if $completedFiles.length > 0}
			<button
				type="button"
				onclick={handleDownloadAll}
				disabled={isZipping}
				class="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-medium rounded transition-colors"
			>
				{#if isZipping}
					Creating ZIP...
				{:else if $completedFiles.length === 1}
					Download file
				{:else}
					Download files ({$completedFiles.length}) as .zip
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
				onchange={handleFileSelect}
				class="text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
			/>
			{#if selectedFiles.length > 0}
				<button
					type="button"
					onclick={handleSendFiles}
					class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
				>
					Send {selectedFiles.length} {selectedFiles.length === 1 ? 'file' : 'files'}
				</button>
			{/if}
		</div>

		{#if sendError}
			<div role="alert" class="p-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded">
				{sendError}
			</div>
		{/if}
	</div>

	<!-- Global High RAM Warning Banner -->
	{#if $hasLargeFileRamWarning}
		<div role="alert" class="p-3 bg-amber-50 border border-amber-300 text-amber-900 rounded text-xs space-y-1">
			<div class="font-bold flex items-center space-x-1">
				<span>⚠️</span>
				<span>High RAM Usage Warning (>500MB)</span>
			</div>
			<p class="text-[11px] text-amber-800 leading-relaxed">
				Your browser does not support the File System Access API. Receiving files over 500MB requires assembling chunks in memory, which may cause high RAM usage.
			</p>
		</div>
	{/if}

	<!-- Outgoing Transfers (Per-Recipient Mesh Progress) -->
	{#if $activeUploads.length > 0}
		<div class="space-y-3 pt-2">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-500">
				Outgoing Transfers
			</h3>

			{#each $activeUploads as transfer (transfer.transferId)}
				<div class="p-3 bg-gray-50 border border-gray-200 rounded space-y-2 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%]" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-gray-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<!-- Per-Recipient Progress Bars -->
					<div class="space-y-2 pt-1">
						{#each Array.from(transfer.recipients.entries()) as [peerId, prog] (peerId)}
							<div class="space-y-1 bg-white p-2 rounded border border-gray-100">
								<div class="flex items-center justify-between text-[11px] text-gray-600">
									<span class="font-mono">Peer: {peerId.slice(0, 8)}...</span>
									<div class="flex items-center space-x-2">
										<span class="capitalize font-medium {prog.status === 'completed' ? 'text-green-600' : prog.status === 'failed' ? 'text-red-600' : 'text-blue-600'}">
											{prog.status}
										</span>
										<span class="font-mono">{prog.percentage}%</span>
										{#if prog.status === 'sending' || prog.status === 'offered'}
											<button
												type="button"
												onclick={() => handleCancelOutgoing(transfer.transferId, peerId)}
												class="text-red-500 hover:text-red-700 ml-1"
												title="Cancel transfer to this peer"
											>
												✕
											</button>
										{/if}
									</div>
								</div>
								<div class="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
									<div
										class="h-1.5 rounded-full transition-all duration-200 {prog.status === 'completed' ? 'bg-green-500' : 'bg-blue-600'}"
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
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-500">
				Incoming Transfers
			</h3>

			{#each $activeDownloads as transfer (transfer.transferId)}
				<div class="p-3 bg-blue-50/50 border border-blue-200 rounded space-y-2 text-xs">
					<div class="flex items-center justify-between font-medium">
						<span class="truncate max-w-[70%]" title={transfer.fileName}>{transfer.fileName}</span>
						<span class="text-gray-500 font-mono">{formatFileSize(transfer.fileSize)}</span>
					</div>

					<div class="text-[11px] text-gray-600 flex items-center justify-between">
						<span>From: <strong class="font-mono text-gray-800">{transfer.sender}</strong></span>
						<span class="capitalize font-semibold text-blue-700">{transfer.status}</span>
					</div>

					<!-- Offered State Acceptance Options -->
					{#if transfer.status === 'offered'}
						{#if transfer.ramLimitExceeded}
							<div role="alert" class="p-2.5 bg-red-50 border border-red-300 text-red-900 rounded text-[11px] space-y-1">
								<div class="font-bold flex items-center space-x-1 text-red-800">
									<span>🛑</span>
									<span>File is too large to accept in this browser</span>
								</div>
								<p class="text-[11px] text-red-700 leading-relaxed">
									File size ({formatFileSize(transfer.fileSize)}) exceeds the {formatFileSize(RAM_HARD_LIMIT_BYTES)} in-memory assembly limit for browsers without File System Access API support. Transfer cannot be accepted.
								</p>
							</div>
						{:else if transfer.ramWarning}
							<div class="p-2 bg-amber-100 border border-amber-300 text-amber-900 rounded text-[11px]">
								⚠️ File is over 500MB ({formatFileSize(transfer.fileSize)}). This browser does not support disk streaming; file will consume RAM.
							</div>
						{/if}

						<div class="flex items-center space-x-2 pt-1">
							{#if fsSupported}
								<button
									type="button"
									onclick={() => handleAcceptFileSystem(transfer.transferId)}
									class="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white font-medium rounded text-xs transition-colors"
								>
									Save to Disk (Stream)
								</button>
							{/if}
							{#if !transfer.ramLimitExceeded && (!fsSupported || transfer.fileSize <= RAM_HARD_LIMIT_BYTES)}
								<button
									type="button"
									onclick={() => handleAcceptBlob(transfer.transferId)}
									class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded text-xs transition-colors"
								>
									{fsSupported ? 'Download to RAM' : 'Accept & Download'}
								</button>
							{/if}
							<button
								type="button"
								onclick={() => handleAbortIncoming(transfer.transferId)}
								class="px-2.5 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded text-xs transition-colors"
							>
								{transfer.ramLimitExceeded ? 'Dismiss' : 'Decline'}
							</button>
						</div>
					{:else if transfer.status === 'receiving'}
						<!-- Receiving Progress Bar -->
						<div class="space-y-1 pt-1">
							<div class="flex justify-between text-[11px] text-gray-600 font-mono">
								<span>{formatFileSize(transfer.bytesReceived)} / {formatFileSize(transfer.fileSize)}</span>
								<span>{Math.round((transfer.bytesReceived / (transfer.fileSize || 1)) * 100)}%</span>
							</div>
							<div class="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
								<div
									class="bg-blue-600 h-1.5 rounded-full transition-all duration-200"
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
		<div class="space-y-2 pt-2 border-t border-gray-100">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-gray-500">
				Completed Files ({$completedFiles.length})
			</h3>
			<ul class="space-y-1.5 text-xs">
				{#each $completedFiles as file (file.transferId)}
					<li class="p-2 bg-gray-50 rounded border border-gray-200 flex items-center justify-between">
						<div class="flex items-center space-x-2 truncate">
							<span class="text-green-600">✓</span>
							<span class="font-medium truncate" title={file.fileName}>{file.fileName}</span>
							<span class="text-gray-400 text-[11px] font-mono">({formatFileSize(file.fileSize)})</span>
							{#if file.storageMode === 'filesystem'}
								<span class="text-[10px] text-green-700 bg-green-50 px-1.5 py-0.5 rounded border border-green-200">
									Saved to Disk
								</span>
							{/if}
						</div>

						{#if file.downloadUrl || file.blob}
							<a
								href={file.downloadUrl || (file.blob ? URL.createObjectURL(file.blob) : '#')}
								download={file.fileName}
								class="px-2 py-1 bg-white hover:bg-gray-100 text-blue-600 rounded border border-gray-300 font-medium text-xs transition-colors shrink-0"
							>
								Download
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</section>
