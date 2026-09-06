/**
 * Permissions representing discrete administrative actions within a signaling room.
 *
 * Mirrored from the signaling server domain model.
 */
export const Permission = {
	KickPeer: 'KickPeer',
	MutePeer: 'MutePeer',
	SetRoomPassword: 'SetRoomPassword',
	TransferOwnership: 'TransferOwnership',
	LockRoom: 'LockRoom',
	ManageChatVisibility: 'ManageChatVisibility',
	ManageFileVisibility: 'ManageFileVisibility'
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Roles assigned to peers participating in a signaling room.
 */
export const Role = {
	Owner: 'Owner',
	Participant: 'Participant'
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * UI-side permission mapping per role.
 *
 * ============================================================================
 * CRITICAL SECURITY & ARCHITECTURE NOTICE:
 * This table and the accompanying `hasPermission` helper exist EXCLUSIVELY for
 * client-side UX (controlling visibility, states, and disabling UI buttons).
 *
 * THIS IS NEVER A SECURITY BOUNDARY.
 * Real security and authorization are enforced authoritatively on the signaling
 * server for every single dispatched message. Client-side checks are purely
 * cosmetic and ergonomic.
 * ============================================================================
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
	[Role.Owner]: [
		Permission.KickPeer,
		Permission.MutePeer,
		Permission.SetRoomPassword,
		Permission.TransferOwnership,
		Permission.LockRoom,
		Permission.ManageChatVisibility,
		Permission.ManageFileVisibility
	],
	[Role.Participant]: []
};

/**
 * Checks whether a given role holds the requested permission for UI display purposes.
 *
 * UX-ONLY: Never rely on this helper for security boundaries.
 *
 * @param role The peer's current role (e.g. 'Owner' or 'Participant').
 * @param permission The permission to check.
 * @returns boolean Whether the UI control should be active/visible.
 */
export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
	if (!role || !(role in ROLE_PERMISSIONS)) {
		return false;
	}
	return ROLE_PERMISSIONS[role].includes(permission);
}
