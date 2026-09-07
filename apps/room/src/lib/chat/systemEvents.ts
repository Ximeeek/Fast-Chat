import type { SystemEventType } from './types.ts';

/**
 * Visual styling definition for system event pills and iconography.
 */
export interface SystemEventStyle {
	containerClass: string;
	iconClass: string;
	ariaLabel: string;
}

/**
 * Resolves the appropriate system event category from explicit type or message text heuristics.
 *
 * @param content - System message prose text.
 * @param explicitType - Optional predefined event classification.
 * @returns Resolved SystemEventType.
 */
export function getSystemEventType(
	content: string,
	explicitType?: SystemEventType
): SystemEventType {
	if (explicitType) {
		return explicitType;
	}

	const lower = content.toLowerCase();

	// Kicks, evictions, leaves, and departures
	if (
		lower.includes('kicked') ||
		lower.includes('left the room') ||
		lower.includes('left') ||
		lower.includes('closed') ||
		lower.includes('grace period expired') ||
		lower.includes('verification failed')
	) {
		return 'leave';
	}

	// Disconnections: distinguish owner transfer from regular peer disconnect
	if (lower.includes('disconnected')) {
		if (lower.includes('you are now the room owner') || lower.includes('ownership transferred')) {
			return 'owner';
		}
		return 'leave';
	}

	// Unmute must be evaluated prior to general mute
	if (lower.includes('unmute') || lower.includes('lifted')) {
		return 'unmute';
	}
	if (lower.includes('mute')) {
		return 'mute';
	}

	// Unlock evaluated before lock
	if (lower.includes('unlocked')) {
		return 'unlock';
	}
	if (lower.includes('locked')) {
		return 'lock';
	}

	// Room ownership events
	if (lower.includes('owner') || lower.includes('promoted')) {
		return 'owner';
	}

	// Participant joins or session creation
	if (
		lower.includes('joined') ||
		lower.includes('connected') ||
		lower.includes('room created')
	) {
		return 'join';
	}

	// Key rotation, room password or rekey operations
	if (
		lower.includes('password') ||
		lower.includes('encryption key') ||
		lower.includes('rekey')
	) {
		return 'security';
	}

	// Grace period countdowns
	if (lower.includes('countdown') || lower.includes('closing')) {
		return 'closing';
	}

	return 'info';
}

/**
 * Returns balanced, non-aggressive color and style classes for a given system event.
 */
export function getSystemEventStyle(type: SystemEventType): SystemEventStyle {
	switch (type) {
		case 'join':
			return {
				containerClass:
					'bg-emerald-950/30 border-emerald-500/25 text-emerald-200/90 shadow-[0_0_12px_rgba(16,185,129,0.06)]',
				iconClass: 'text-emerald-400',
				ariaLabel: 'Participant joined'
			};
		case 'leave':
			return {
				containerClass:
					'bg-rose-950/25 border-rose-400/20 text-rose-200/90 shadow-[0_0_12px_rgba(244,63,94,0.05)]',
				iconClass: 'text-rose-300/90',
				ariaLabel: 'Participant left'
			};
		case 'mute':
			return {
				containerClass:
					'bg-amber-950/25 border-amber-500/20 text-amber-200/90 shadow-[0_0_12px_rgba(245,158,11,0.05)]',
				iconClass: 'text-amber-300/80',
				ariaLabel: 'Participant muted'
			};
		case 'unmute':
			return {
				containerClass:
					'bg-sky-950/25 border-sky-500/20 text-sky-200/90 shadow-[0_0_12px_rgba(56,189,248,0.05)]',
				iconClass: 'text-sky-300',
				ariaLabel: 'Participant unmuted'
			};
		case 'lock':
			return {
				containerClass:
					'bg-amber-950/25 border-amber-500/20 text-amber-200/90 shadow-[0_0_12px_rgba(245,158,11,0.05)]',
				iconClass: 'text-amber-300/80',
				ariaLabel: 'Room locked'
			};
		case 'unlock':
			return {
				containerClass:
					'bg-teal-950/25 border-teal-500/20 text-teal-200/90 shadow-[0_0_12px_rgba(20,184,166,0.05)]',
				iconClass: 'text-teal-300',
				ariaLabel: 'Room unlocked'
			};
		case 'owner':
			return {
				containerClass:
					'bg-amber-950/25 border-amber-400/25 text-amber-200/90 shadow-[0_0_12px_rgba(251,191,36,0.06)]',
				iconClass: 'text-amber-300',
				ariaLabel: 'Room owner'
			};
		case 'security':
			return {
				containerClass:
					'bg-indigo-950/30 border-indigo-500/25 text-indigo-200/90 shadow-[0_0_12px_rgba(99,102,241,0.06)]',
				iconClass: 'text-indigo-300',
				ariaLabel: 'Security'
			};
		case 'closing':
			return {
				containerClass:
					'bg-orange-950/25 border-orange-500/20 text-orange-200/90 shadow-[0_0_12px_rgba(249,115,22,0.05)]',
				iconClass: 'text-orange-300',
				ariaLabel: 'Room closing'
			};
		case 'info':
		default:
			return {
				containerClass:
					'bg-cyan-950/30 border-cyan-500/20 text-cyan-200/90 shadow-[0_0_12px_rgba(6,182,212,0.05)]',
				iconClass: 'text-cyan-300',
				ariaLabel: 'Notice'
			};
	}
}
