import { zip, type AsyncZippable } from 'fflate';
import type { CompletedFileRecord } from './types.ts';

export interface ArchiveEntry {
	name: string;
	data?: Uint8Array;
	blob?: Blob;
}

/**
 * Creates a standard .zip archive entirely on the client side using fflate.
 * Eliminates server roundtrips and zero-knowledge compromises.
 *
 * @param files - Array of files with file name and raw data or Blob.
 * @returns Promise resolving to the compressed application/zip Blob.
 */
export async function createZipArchive(files: ArchiveEntry[]): Promise<Blob> {
	if (files.length === 0) {
		throw new Error('Cannot create ZIP archive: file list is empty');
	}

	const zippable: AsyncZippable = {};
	const seenNames = new Set<string>();

	for (const file of files) {
		let rawBytes: Uint8Array;
		if (file.data) {
			rawBytes = file.data;
		} else if (file.blob) {
			const arrayBuf = await file.blob.arrayBuffer();
			rawBytes = new Uint8Array(arrayBuf);
		} else {
			continue;
		}

		// Prevent name collisions in zip table
		let entryName = file.name || 'unnamed-file';
		let counter = 1;
		while (seenNames.has(entryName)) {
			const extIdx = file.name.lastIndexOf('.');
			if (extIdx !== -1) {
				const base = file.name.slice(0, extIdx);
				const ext = file.name.slice(extIdx);
				entryName = `${base} (${counter})${ext}`;
			} else {
				entryName = `${file.name} (${counter})`;
			}
			counter++;
		}
		seenNames.add(entryName);

		zippable[entryName] = rawBytes;
	}

	return new Promise((resolve, reject) => {
		zip(zippable, { level: 6 }, (err, data) => {
			if (err) {
				reject(err);
			} else {
				resolve(new Blob([data as unknown as BlobPart], { type: 'application/zip' }));
			}
		});
	});
}

/**
 * Triggers an immediate browser download using a temporary DOM anchor.
 */
export function triggerFileDownload(fileName: string, urlOrBlob: string | Blob): void {
	if (typeof document === 'undefined' || typeof window === 'undefined') {
		return;
	}

	const isBlob = urlOrBlob instanceof Blob;
	const downloadUrl = isBlob ? URL.createObjectURL(urlOrBlob) : urlOrBlob;

	const anchor = document.createElement('a');
	anchor.href = downloadUrl;
	anchor.download = fileName;
	anchor.style.display = 'none';

	document.body.appendChild(anchor);
	anchor.click();

	// Clean up after small delay
	setTimeout(() => {
		document.body.removeChild(anchor);
		if (isBlob) {
			try {
				URL.revokeObjectURL(downloadUrl);
			} catch {}
		}
	}, 250);
}

/**
 * Downloads a single file or bundles multiple completed files into a .zip archive.
 * Zero roundtrips to signaling server.
 */
export async function downloadFiles(
	records: CompletedFileRecord[],
	customArchiveName?: string
): Promise<void> {
	if (records.length === 0) return;

	// Single file download
	if (records.length === 1) {
		const rec = records[0];
		if (rec.blob) {
			triggerFileDownload(rec.fileName, rec.blob);
		} else if (rec.downloadUrl) {
			triggerFileDownload(rec.fileName, rec.downloadUrl);
		}
		return;
	}

	// Multi-file download: bundle into client-side ZIP
	const entries: ArchiveEntry[] = [];
	for (const rec of records) {
		if (rec.blob) {
			entries.push({ name: rec.fileName, blob: rec.blob });
		}
	}

	if (entries.length === 0) return;

	const zipBlob = await createZipArchive(entries);
	const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
	const zipName = customArchiveName || `fastchat-files-${timestamp}.zip`;

	triggerFileDownload(zipName, zipBlob);
}
