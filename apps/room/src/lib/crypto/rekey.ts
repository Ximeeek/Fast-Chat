import type {
	RekeyDerivationOptions,
	RekeyManagerOptions,
	RekeyStatus,
	RekeyTimer
} from './types.ts';
import { parseSalt } from './kdf.ts';

/**
 * Derives a new symmetric key (K1) after a room REKEY event using native Web Crypto HKDF-SHA256.
 *
 * The previous key (K0) serves as the primary Input Keying Material (IKM), and the user password
 * (optionally combined with the server's fresh rekey salt) acts as the salt.
 * This guarantees forward secrecy relative to non-participants who lack the rekey password:
 * even if an attacker observed historical traffic encrypted under K0, they cannot derive K1
 * without knowing the password.
 *
 * Target algorithm is AES-GCM with 256-bit key length.
 *
 * @param k0 - The active room key (CryptoKey, Uint8Array, or ArrayBuffer).
 * @param password - User-provided room password.
 * @param salt - Optional fresh per-room rekey salt from the REKEY signaling broadcast.
 * @param options - Optional derivation options (info, extractable, usages).
 * @returns Promise resolving to the newly derived 256-bit AES-GCM CryptoKey (K1).
 */
export async function deriveRekeyedKey(
	k0: CryptoKey | Uint8Array | ArrayBuffer,
	password: string,
	salt?: string | Uint8Array,
	options: RekeyDerivationOptions = {}
): Promise<CryptoKey> {
	if (typeof password !== 'string') {
		throw new TypeError('Password must be a string');
	}

	let rawK0Bytes: Uint8Array;
	if (k0 instanceof Uint8Array) {
		rawK0Bytes = k0;
	} else if (k0 instanceof ArrayBuffer) {
		rawK0Bytes = new Uint8Array(k0);
	} else if (k0 && typeof k0 === 'object' && 'type' in k0 && 'algorithm' in k0) {
		const rawBuffer = await crypto.subtle.exportKey('raw', k0);
		rawK0Bytes = new Uint8Array(rawBuffer);
	} else {
		throw new TypeError('k0 must be a CryptoKey, Uint8Array, or ArrayBuffer');
	}

	if (rawK0Bytes.byteLength === 0) {
		throw new Error('k0 key material cannot be empty');
	}

	// Prepare salt for HKDF:
	// If a rekey salt is supplied by the signaling server, combine salt + password bytes.
	// Otherwise, password bytes alone form the salt.
	const pwBytes = new TextEncoder().encode(password);
	let saltBytes: Uint8Array;

	if (salt !== undefined && salt !== null && (typeof salt === 'string' ? salt.trim().length > 0 : salt.byteLength > 0)) {
		const parsedSalt = parseSalt(salt);
		saltBytes = new Uint8Array(parsedSalt.length + pwBytes.length);
		saltBytes.set(parsedSalt, 0);
		saltBytes.set(pwBytes, parsedSalt.length);
	} else {
		saltBytes = pwBytes;
	}

	const infoBytes =
		typeof options.info === 'string'
			? new TextEncoder().encode(options.info)
			: options.info instanceof Uint8Array
				? options.info
				: new TextEncoder().encode('fastchat-v1-rekey');

	const extractable = options.extractable ?? true;
	const usages: KeyUsage[] = options.usages ?? ['encrypt', 'decrypt'];

	// Import K0 raw bytes as HKDF base key material
	const baseKey = await crypto.subtle.importKey(
		'raw',
		rawK0Bytes as unknown as BufferSource,
		{ name: 'HKDF' },
		false,
		['deriveKey', 'deriveBits']
	);

	// Derive K1 using HKDF-SHA256
	return crypto.subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: saltBytes as unknown as BufferSource,
			info: infoBytes as unknown as BufferSource
		},
		baseKey,
		{
			name: 'AES-GCM',
			length: 256
		},
		extractable,
		usages
	);
}

const defaultTimer: RekeyTimer = {
	setTimeout: (cb, ms) => setTimeout(cb, ms),
	clearTimeout: (id) => clearTimeout(id)
};

/**
 * Manages the client-side REKEY lifecycle window.
 *
 * When a REKEY event is received from the signaling server, the room begins
 * a grace window (default: ~15 seconds). The local client must provide the valid
 * password to derive K1. If the countdown expires without a password submission,
 * the manager triggers the onTimeout callback, signaling the WebRTC layer to
 * terminate peer connections.
 */
export class RekeyManager {
	private activeKey: CryptoKey | null = null;
	private pendingBaseKey: CryptoKey | null = null;
	private pendingSalt: string | Uint8Array | null = null;
	private timerId: any = null;
	private status: RekeyStatus = 'idle';
	private deadline: number | null = null;
	private readonly timeoutMs: number;
	private readonly timer: RekeyTimer;
	private readonly onTimeoutCallbacks: Set<() => void> = new Set();
	private readonly onSuccessCallbacks: Set<(newKey: CryptoKey) => void> = new Set();
	private readonly statusSubscribers: Set<(status: RekeyStatus) => void> = new Set();

	constructor(options: RekeyManagerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 15000;
		this.timer = options.timer ?? defaultTimer;

		if (options.onTimeout) {
			this.onTimeoutCallbacks.add(options.onTimeout);
		}
		if (options.onSuccess) {
			this.onSuccessCallbacks.add(options.onSuccess);
		}
	}

	/**
	 * Sets the initial room key (K0) when entering a room.
	 */
	public setActiveKey(key: CryptoKey): void {
		this.activeKey = key;
	}

	/**
	 * Gets the currently active encryption key (K0 or K1 after rekey).
	 */
	public getActiveKey(): CryptoKey | null {
		return this.activeKey;
	}

	/**
	 * Gets the current rekey lifecycle state.
	 */
	public getStatus(): RekeyStatus {
		return this.status;
	}

	/**
	 * Checks if a rekey process is currently awaiting password input.
	 */
	public isPending(): boolean {
		return this.status === 'pending';
	}

	/**
	 * Calculates the remaining time in milliseconds before the rekey window closes.
	 */
	public getRemainingTimeMs(): number {
		if (this.status !== 'pending' || !this.deadline) return 0;
		const remaining = this.deadline - Date.now();
		return remaining > 0 ? remaining : 0;
	}

	/**
	 * Initiates the REKEY countdown window upon receiving a REKEY event from the server.
	 *
	 * @param baseKey - Optional base key to derive from. Defaults to activeKey.
	 * @param salt - Optional fresh salt broadcast in the REKEY message.
	 */
	public startRekey(baseKey?: CryptoKey, salt?: string | Uint8Array): void {
		const keyToUse = baseKey || this.activeKey;
		if (!keyToUse) {
			throw new Error('Cannot start rekey without an active base key');
		}

		this.clearTimer();
		this.pendingBaseKey = keyToUse;
		this.pendingSalt = salt ?? null;
		this.status = 'pending';
		this.deadline = Date.now() + this.timeoutMs;
		this.notifyStatus();

		this.timerId = this.timer.setTimeout(() => {
			this.handleTimeout();
		}, this.timeoutMs);
	}

	/**
	 * Submits the user password to compute K1 and finalize the rekey process.
	 *
	 * @param password - The room password entered by the user.
	 * @returns The newly derived K1 CryptoKey.
	 */
	public async submitPassword(password: string): Promise<CryptoKey> {
		if (this.status !== 'pending' || !this.pendingBaseKey) {
			throw new Error('No pending rekey in progress');
		}

		if (typeof password !== 'string' || password.length === 0) {
			throw new Error('Password cannot be empty');
		}

		const newKey = await deriveRekeyedKey(
			this.pendingBaseKey,
			password,
			this.pendingSalt ?? undefined
		);

		this.clearTimer();
		this.activeKey = newKey;
		this.pendingBaseKey = null;
		this.pendingSalt = null;
		this.status = 'success';
		this.notifyStatus();

		for (const cb of this.onSuccessCallbacks) {
			try {
				cb(newKey);
			} catch (err) {
				// Prevent subscriber exceptions from disrupting core flow
			}
		}

		return newKey;
	}

	/**
	 * Cancels any in-progress rekey operation.
	 */
	public cancel(): void {
		if (this.status === 'pending') {
			this.clearTimer();
			this.pendingBaseKey = null;
			this.pendingSalt = null;
			this.status = 'cancelled';
			this.notifyStatus();
		}
	}

	/**
	 * Registers a callback to be invoked if the rekey timeout expires.
	 *
	 * @param callback - Timeout handler function.
	 * @returns Unsubscribe cleanup function.
	 */
	public onTimeout(callback: () => void): () => void {
		this.onTimeoutCallbacks.add(callback);
		return () => {
			this.onTimeoutCallbacks.delete(callback);
		};
	}

	/**
	 * Registers a callback to be invoked upon successful rekey derivation.
	 *
	 * @param callback - Success handler function.
	 * @returns Unsubscribe cleanup function.
	 */
	public onSuccess(callback: (newKey: CryptoKey) => void): () => void {
		this.onSuccessCallbacks.add(callback);
		return () => {
			this.onSuccessCallbacks.delete(callback);
		};
	}

	/**
	 * Subscribes to rekey status transitions.
	 *
	 * @param callback - Status change listener.
	 * @returns Unsubscribe cleanup function.
	 */
	public subscribe(callback: (status: RekeyStatus) => void): () => void {
		this.statusSubscribers.add(callback);
		callback(this.status);
		return () => {
			this.statusSubscribers.delete(callback);
		};
	}

	/**
	 * Disposes running timers and releases references.
	 */
	public dispose(): void {
		this.clearTimer();
		this.activeKey = null;
		this.pendingBaseKey = null;
		this.pendingSalt = null;
		this.status = 'idle';
		this.onTimeoutCallbacks.clear();
		this.onSuccessCallbacks.clear();
		this.statusSubscribers.clear();
	}

	private handleTimeout(): void {
		this.clearTimer();
		this.pendingBaseKey = null;
		this.pendingSalt = null;
		this.status = 'timed_out';
		this.notifyStatus();

		for (const cb of this.onTimeoutCallbacks) {
			try {
				cb();
			} catch (err) {
				// Prevent subscriber exceptions from disrupting core flow
			}
		}
	}

	private clearTimer(): void {
		if (this.timerId !== null) {
			this.timer.clearTimeout(this.timerId);
			this.timerId = null;
		}
		this.deadline = null;
	}

	private notifyStatus(): void {
		for (const sub of this.statusSubscribers) {
			try {
				sub(this.status);
			} catch (err) {
				// Isolate subscriber errors
			}
		}
	}
}
