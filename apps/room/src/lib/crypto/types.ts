/**
 * Options for deriving the initial room encryption key (K0).
 */
export interface KeyDerivationOptions {
	/**
	 * Optional context and application-specific info string or raw bytes for HKDF expand.
	 * Defaults to 'fastchat-v1-room-key'.
	 */
	info?: string | Uint8Array;

	/**
	 * Indicates whether the derived CryptoKey can be exported via crypto.subtle.exportKey.
	 * Defaults to true to allow K0 to be utilized as keying material during REKEY.
	 */
	extractable?: boolean;

	/**
	 * Key usages permitted for the derived CryptoKey.
	 * Defaults to ['encrypt', 'decrypt'].
	 */
	usages?: KeyUsage[];
}

/**
 * Rekey status lifecycle states.
 */
export type RekeyStatus =
	| 'idle'
	| 'pending'
	| 'success'
	| 'timed_out'
	| 'cancelled';

/**
 * Options for rekey key derivation.
 */
export interface RekeyDerivationOptions {
	/**
	 * Context info string or raw bytes for HKDF expansion.
	 * Defaults to 'fastchat-v1-rekey'.
	 */
	info?: string | Uint8Array;

	/**
	 * Whether the derived CryptoKey can be exported.
	 * Defaults to true.
	 */
	extractable?: boolean;

	/**
	 * Key usages permitted for the derived CryptoKey.
	 * Defaults to ['encrypt', 'decrypt'].
	 */
	usages?: KeyUsage[];
}

/**
 * Custom timer abstraction for injectable time testing.
 */
export interface RekeyTimer {
	setTimeout: (callback: () => void, ms: number) => any;
	clearTimeout: (id: any) => void;
}

/**
 * Configuration options for the RekeyManager grace window.
 */
export interface RekeyManagerOptions {
	/**
	 * Timeout duration in milliseconds waiting for password input.
	 * Defaults to 15,000 ms (~15 seconds).
	 */
	timeoutMs?: number;

	/**
	 * Hook invoked when the timeout window expires without a valid password.
	 * Phase 8 WebRTC mesh connects to this hook to disconnect peers.
	 */
	onTimeout?: () => void;

	/**
	 * Hook invoked upon successful rekey key derivation.
	 */
	onSuccess?: (newKey: CryptoKey) => void;

	/**
	 * Optional custom timer implementation for testing and time manipulation.
	 */
	timer?: RekeyTimer;
}
