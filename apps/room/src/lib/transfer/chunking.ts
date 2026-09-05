import type { ParsedFileChunk } from './types.ts';

/**
 * Standard chunk size in bytes for binary file slicing (16KB).
 * Strictly adheres to Phase 10 specification and WebRTC DataChannel packet boundaries.
 */
export const CHUNK_SIZE = 16 * 1024; // 16384 bytes

/**
 * Magic identifier for binary file chunks: ASCII "FCK" followed by version byte 0x01.
 */
export const CHUNK_MAGIC = new Uint8Array([0x46, 0x43, 0x4b, 0x01]);

/**
 * Length in bytes of the fixed binary packet header:
 * - 4 bytes: Magic (FCK\x01)
 * - 36 bytes: Transfer ID string (UUID)
 * - 4 bytes: Chunk Index (Uint32, Big Endian)
 * - 4 bytes: Total Chunks (Uint32, Big Endian)
 */
export const CHUNK_HEADER_LENGTH = 48;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Computes the total number of 16KB chunks required for a given file size.
 */
export function calculateTotalChunks(fileSize: number, chunkSize: number = CHUNK_SIZE): number {
	if (fileSize <= 0) return 1;
	return Math.ceil(fileSize / chunkSize);
}

/**
 * Extracts a specific 16KB chunk slice from a File or Blob instance.
 * Reads solely the requested slice from the source without loading the entire file into RAM.
 */
export async function sliceFile(
	file: Blob | File,
	chunkIndex: number,
	chunkSize: number = CHUNK_SIZE
): Promise<Uint8Array> {
	const start = chunkIndex * chunkSize;
	const end = Math.min(start + chunkSize, file.size);
	const sliceBlob = file.slice(start, end);
	const buffer = await sliceBlob.arrayBuffer();
	return new Uint8Array(buffer);
}

/**
 * Packs a binary chunk with framing metadata into a contiguous Uint8Array ready for encryption.
 *
 * Framing layout:
 * [ 4-byte Magic 'FCK\x01' ]
 * [ 36-byte Transfer ID (ASCII) ]
 * [ 4-byte uint32 chunkIndex (BE) ]
 * [ 4-byte uint32 totalChunks (BE) ]
 * [ Raw Chunk Payload (up to 16KB) ]
 */
export function createFileChunkPacket(
	transferId: string,
	chunkIndex: number,
	totalChunks: number,
	chunkBytes: Uint8Array
): Uint8Array {
	const packet = new Uint8Array(CHUNK_HEADER_LENGTH + chunkBytes.byteLength);

	// 1. Set 4-byte magic
	packet.set(CHUNK_MAGIC, 0);

	// 2. Encode 36-byte transfer ID (padded or truncated to 36 bytes)
	const idPadded = transferId.padEnd(36, ' ').slice(0, 36);
	const idBytes = textEncoder.encode(idPadded);
	packet.set(idBytes, 4);

	// 3. Write chunkIndex and totalChunks as 32-bit big-endian unsigned integers
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	view.setUint32(40, chunkIndex, false);
	view.setUint32(44, totalChunks, false);

	// 4. Copy raw payload bytes
	packet.set(chunkBytes, CHUNK_HEADER_LENGTH);

	return packet;
}

/**
 * Quickly checks if an incoming byte buffer begins with the 4-byte binary chunk magic.
 */
export function isFileChunkPacket(data: Uint8Array | ArrayBuffer): boolean {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (bytes.byteLength < CHUNK_HEADER_LENGTH) return false;

	return (
		bytes[0] === CHUNK_MAGIC[0] &&
		bytes[1] === CHUNK_MAGIC[1] &&
		bytes[2] === CHUNK_MAGIC[2] &&
		bytes[3] === CHUNK_MAGIC[3]
	);
}

/**
 * Parses and extracts framing metadata and payload from a raw decrypted chunk packet.
 * Returns null if the packet fails magic validation or length boundary requirements.
 */
export function parseFileChunkPacket(data: Uint8Array | ArrayBuffer): ParsedFileChunk | null {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	if (!isFileChunkPacket(bytes)) return null;

	try {
		const transferIdRaw = textDecoder.decode(bytes.subarray(4, 40));
		const transferId = transferIdRaw.trim();

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const chunkIndex = view.getUint32(40, false);
		const totalChunks = view.getUint32(44, false);

		const chunkData = bytes.subarray(CHUNK_HEADER_LENGTH);

		return {
			transferId,
			chunkIndex,
			totalChunks,
			data: chunkData
		};
	} catch {
		return null;
	}
}

/**
 * Human-readable format utility for byte lengths.
 */
export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const val = bytes / Math.pow(1024, i);
	return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
