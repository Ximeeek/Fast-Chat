use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::Deref;
use std::str::FromStr;
use uuid::Uuid;

/// Strongly-typed immutable room identifier generated as a random UUID v4.
/// Remains constant throughout the room's entire lifecycle across any code rotations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoomId(pub Uuid);

impl RoomId {
    /// Generates a new random `RoomId` using UUID v4.
    pub fn generate() -> Self {
        Self(Uuid::new_v4())
    }

    /// Returns a reference to the underlying `Uuid`.
    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Deref for RoomId {
    type Target = Uuid;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<Uuid> for RoomId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for RoomId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for RoomId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s).map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_room_id_generate_and_uniqueness() {
        let id1 = RoomId::generate();
        let id2 = RoomId::generate();
        assert_ne!(id1, id2);
        assert_eq!(id1.as_uuid().get_version(), Some(uuid::Version::Random));
    }

    #[test]
    fn test_room_id_display_and_parse() {
        let id = RoomId::generate();
        let s = id.to_string();
        let parsed: RoomId = s.parse().expect("Failed to parse RoomId");
        assert_eq!(id, parsed);
    }

    #[test]
    fn test_room_id_deref() {
        let id = RoomId::generate();
        assert_eq!(*id, id.0);
    }
}
