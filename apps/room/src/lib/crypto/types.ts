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
