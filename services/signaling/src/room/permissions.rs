use serde::{Deserialize, Serialize};

use crate::room::state::RoomState;

/// Type alias representing a unique peer identifier reference within a room.
pub type PeerId = str;

/// Discrete actions within a signaling room that may require specific authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Permission {
    KickPeer,
    MutePeer,
    SetRoomPassword,
    TransferOwnership,
    LockRoom,
    ManageChatVisibility,
    ManageFileVisibility,
}

/// Roles assigned to peers participating in a signaling room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Role {
    Owner,
    Participant,
}

/// Returns the static slice of granted permissions associated with a given role.
///
/// Room owners hold complete administrative authority over the room session.
/// Regular participants hold standard participation rights without administrative privileges.
#[inline]
pub fn role_permissions(role: Role) -> &'static [Permission] {
    match role {
        Role::Owner => &[
            Permission::KickPeer,
            Permission::MutePeer,
            Permission::SetRoomPassword,
            Permission::TransferOwnership,
            Permission::LockRoom,
            Permission::ManageChatVisibility,
            Permission::ManageFileVisibility,
        ],
        Role::Participant => &[],
    }
}

/// Resolves the current role for a peer within the specified room.
///
/// In the current single-owner design, the peer matching the room's designated owner
/// is assigned `Role::Owner`. All other peers (and unknown peers) evaluate to `Role::Participant`.
#[inline]
pub fn get_role(room: &RoomState, peer_id: &PeerId) -> Role {
    if room.owner_peer_id() == Some(peer_id) {
        Role::Owner
    } else {
        Role::Participant
    }
}

/// Evaluates whether a peer holds the requested permission within the specified room.
///
/// This serves as the single source of truth for authorization checks across signaling handlers.
#[inline]
pub fn has_permission(room: &RoomState, peer_id: &PeerId, permission: Permission) -> bool {
    let role = get_role(room, peer_id);
    role_permissions(role).contains(&permission)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::room::code::RoomCode;
    use crate::room::state::PasswordStatus;

    fn make_test_room() -> RoomState {
        let config = Config::default();
        let code = RoomCode::new("1234-5678-9012").unwrap();
        let mut room = RoomState::new(
            code,
            Some("owner-peer".to_string()),
            None,
            PasswordStatus::none(),
            &config,
            1_000_000,
        );
        let _ = room.add_peer("member-peer".to_string(), false, 1_000_001, &config, None);
        room
    }

    #[test]
    fn test_role_permissions_matrix() {
        let owner_perms = role_permissions(Role::Owner);
        assert!(owner_perms.contains(&Permission::KickPeer));
        assert!(owner_perms.contains(&Permission::MutePeer));
        assert!(owner_perms.contains(&Permission::SetRoomPassword));
        assert!(owner_perms.contains(&Permission::TransferOwnership));
        assert!(owner_perms.contains(&Permission::LockRoom));
        assert!(owner_perms.contains(&Permission::ManageChatVisibility));
        assert!(owner_perms.contains(&Permission::ManageFileVisibility));
        assert_eq!(owner_perms.len(), 7);

        let participant_perms = role_permissions(Role::Participant);
        assert!(participant_perms.is_empty());
    }

    #[test]
    fn test_get_role_resolution() {
        let room = make_test_room();
        assert_eq!(get_role(&room, "owner-peer"), Role::Owner);
        assert_eq!(get_role(&room, "member-peer"), Role::Participant);
        assert_eq!(get_role(&room, "unknown-peer"), Role::Participant);
    }

    #[test]
    fn test_has_permission_evaluation() {
        let room = make_test_room();

        // Owner has all defined permissions
        assert!(has_permission(&room, "owner-peer", Permission::SetRoomPassword));
        assert!(has_permission(&room, "owner-peer", Permission::KickPeer));
        assert!(has_permission(&room, "owner-peer", Permission::MutePeer));
        assert!(has_permission(&room, "owner-peer", Permission::TransferOwnership));
        assert!(has_permission(&room, "owner-peer", Permission::LockRoom));
        assert!(has_permission(&room, "owner-peer", Permission::ManageChatVisibility));
        assert!(has_permission(&room, "owner-peer", Permission::ManageFileVisibility));

        // Participant has no administrative permissions
        assert!(!has_permission(&room, "member-peer", Permission::SetRoomPassword));
        assert!(!has_permission(&room, "member-peer", Permission::KickPeer));
        assert!(!has_permission(&room, "member-peer", Permission::MutePeer));
        assert!(!has_permission(&room, "member-peer", Permission::TransferOwnership));
        assert!(!has_permission(&room, "member-peer", Permission::LockRoom));
        assert!(!has_permission(&room, "member-peer", Permission::ManageChatVisibility));
        assert!(!has_permission(&room, "member-peer", Permission::ManageFileVisibility));

        // Unknown peer has no permissions
        assert!(!has_permission(&room, "unknown-peer", Permission::SetRoomPassword));
    }

    /// Demonstrates that extending the permission system with a hypothetical new role
    /// (e.g. Moderator with a subset of permissions like MutePeer and KickPeer)
    /// only requires a table mapping without changing permission evaluation logic at call sites.
    #[test]
    fn test_permission_extensibility_demonstration() {
        #[allow(dead_code)]
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum HypotheticalRole {
            Owner,
            Moderator,
            Participant,
        }

        fn hypothetical_role_permissions(role: HypotheticalRole) -> &'static [Permission] {
            match role {
                HypotheticalRole::Owner => &[
                    Permission::KickPeer,
                    Permission::MutePeer,
                    Permission::SetRoomPassword,
                    Permission::TransferOwnership,
                    Permission::LockRoom,
                    Permission::ManageChatVisibility,
                    Permission::ManageFileVisibility,
                ],
                HypotheticalRole::Moderator => &[
                    Permission::KickPeer,
                    Permission::MutePeer,
                ],
                HypotheticalRole::Participant => &[],
            }
        }

        fn check_hypothetical_permission(role: HypotheticalRole, perm: Permission) -> bool {
            hypothetical_role_permissions(role).contains(&perm)
        }

        // Call-site permission check logic remains identical: check table membership
        assert!(check_hypothetical_permission(HypotheticalRole::Moderator, Permission::KickPeer));
        assert!(check_hypothetical_permission(HypotheticalRole::Moderator, Permission::MutePeer));
        assert!(!check_hypothetical_permission(HypotheticalRole::Moderator, Permission::SetRoomPassword));
        assert!(!check_hypothetical_permission(HypotheticalRole::Moderator, Permission::LockRoom));
    }
}
