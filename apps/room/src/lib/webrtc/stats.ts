import type { ConnectionType } from './types.ts';

/**
 * Inspects RTCPeerConnection statistics to identify the active ICE candidate pair
 * and detect whether the active path traverses a TURN relay server or a direct P2P link.
 *
 * Evaluation heuristic according to W3C WebRTC Stats:
 * 1. Search for RTCTransportStats to identify `selectedCandidatePairId`.
 * 2. Fall back to searching RTCIceCandidatePairStats for selected = true, or
 *    nominated = true with state = 'succeeded'.
 * 3. Inspect the candidateType of both local and remote candidates:
 *    - If either candidateType is 'relay' (or 'relayed'), the path is classified as 'relayed'.
 *    - If candidates are resolved and neither is a relay (e.g. 'host', 'srflx', 'prflx'),
 *      the path is classified as 'direct'.
 *    - If no candidate pair has been selected or succeeded yet, returns 'unknown'.
 *
 * @param pc - The active RTCPeerConnection instance.
 * @returns Promise resolving to 'direct', 'relayed', or 'unknown'.
 */
export async function inspectCandidatePair(pc: RTCPeerConnection): Promise<ConnectionType> {
	if (!pc || typeof pc.getStats !== 'function') {
		return 'unknown';
	}

	try {
		const stats = await pc.getStats();
		let activePair: any = null;

		// 1. Inspect transport stats for modern standard selectedCandidatePairId
		for (const report of stats.values()) {
			if (report.type === 'transport' && report.selectedCandidatePairId) {
				activePair = stats.get(report.selectedCandidatePairId);
				if (activePair) break;
			}
		}

		// 2. Candidate pair with selected === true or nominated === true and state === 'succeeded'
		if (!activePair) {
			for (const report of stats.values()) {
				if (report.type === 'candidate-pair') {
					if (report.selected === true) {
						activePair = report;
						break;
					}
					if (report.nominated === true && report.state === 'succeeded') {
						activePair = report;
						break;
					}
				}
			}
		}

		// 3. Fallback to any succeeded pair if nominated flag is omitted by the engine
		if (!activePair) {
			for (const report of stats.values()) {
				if (report.type === 'candidate-pair' && report.state === 'succeeded') {
					activePair = report;
					break;
				}
			}
		}

		if (!activePair || !activePair.localCandidateId || !activePair.remoteCandidateId) {
			return 'unknown';
		}

		const localCandidate = stats.get(activePair.localCandidateId);
		const remoteCandidate = stats.get(activePair.remoteCandidateId);

		const localType = (localCandidate?.candidateType || '').toLowerCase();
		const remoteType = (remoteCandidate?.candidateType || '').toLowerCase();

		if (localType === 'relay' || localType === 'relayed' || remoteType === 'relay' || remoteType === 'relayed') {
			return 'relayed';
		}

		if (localType || remoteType) {
			return 'direct';
		}

		return 'unknown';
	} catch {
		return 'unknown';
	}
}

export interface RelayedUsageStats {
	isRelayed: boolean;
	totalBytes: number;
}

/**
 * Inspects RTCPeerConnection statistics to evaluate whether the active candidate pair
 * is relayed through a TURN server, and aggregates total payload bytes (sent + received).
 *
 * @param pc - The active RTCPeerConnection instance.
 * @returns Promise resolving to { isRelayed: boolean, totalBytes: number }.
 */
export async function inspectRelayedUsage(pc: RTCPeerConnection): Promise<RelayedUsageStats> {
	if (!pc || typeof pc.getStats !== 'function') {
		return { isRelayed: false, totalBytes: 0 };
	}

	try {
		const stats = await pc.getStats();
		let activePair: any = null;

		// 1. Inspect transport stats for modern standard selectedCandidatePairId
		for (const report of stats.values()) {
			if (report.type === 'transport' && report.selectedCandidatePairId) {
				activePair = stats.get(report.selectedCandidatePairId);
				if (activePair) break;
			}
		}

		// 2. Candidate pair with selected === true or nominated === true and state === 'succeeded'
		if (!activePair) {
			for (const report of stats.values()) {
				if (report.type === 'candidate-pair') {
					if (report.selected === true) {
						activePair = report;
						break;
					}
					if (report.nominated === true && report.state === 'succeeded') {
						activePair = report;
						break;
					}
				}
			}
		}

		// 3. Fallback to any succeeded pair if nominated flag is omitted
		if (!activePair) {
			for (const report of stats.values()) {
				if (report.type === 'candidate-pair' && report.state === 'succeeded') {
					activePair = report;
					break;
				}
			}
		}

		if (!activePair || !activePair.localCandidateId || !activePair.remoteCandidateId) {
			return { isRelayed: false, totalBytes: 0 };
		}

		const localCandidate = stats.get(activePair.localCandidateId);
		const remoteCandidate = stats.get(activePair.remoteCandidateId);

		const localType = (localCandidate?.candidateType || '').toLowerCase();
		const remoteType = (remoteCandidate?.candidateType || '').toLowerCase();

		const isRelayed =
			localType === 'relay' ||
			localType === 'relayed' ||
			remoteType === 'relay' ||
			remoteType === 'relayed';

		if (!isRelayed) {
			return { isRelayed: false, totalBytes: 0 };
		}

		const bytesSent = typeof activePair.bytesSent === 'number' ? activePair.bytesSent : 0;
		const bytesReceived =
			typeof activePair.bytesReceived === 'number' ? activePair.bytesReceived : 0;

		return {
			isRelayed: true,
			totalBytes: bytesSent + bytesReceived
		};
	} catch {
		return { isRelayed: false, totalBytes: 0 };
	}
}

