use dashmap::DashMap;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::Deref;
use std::str::FromStr;
use thiserror::Error;

/// Error type for room code validation and generation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RoomCodeError {
    #[error("Invalid room code format: expected '0000-0000-0000' (12 digits grouped by dashes)")]
    InvalidFormat,
    #[error("Failed to generate unique room code after maximum attempts")]
    UniqueGenerationExhausted,
}

/// Strongly-typed room code in format `0000-0000-0000` (12 digits grouped into 3 parts of 4).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoomCode(String);

impl RoomCode {
    /// Validates and constructs a new `RoomCode`.
    pub fn new(code: impl Into<String>) -> Result<Self, RoomCodeError> {
        let s = code.into();
        if Self::is_valid(&s) {
            Ok(Self(s))
        } else {
            Err(RoomCodeError::InvalidFormat)
        }
    }

    /// Validates whether a string matches the required `0000-0000-0000` format.
    pub fn is_valid(code: &str) -> bool {
        if code.len() != 14 {
            return false;
        }
        let bytes = code.as_bytes();
        bytes[4] == b'-'
            && bytes[9] == b'-'
            && bytes[0..4].iter().all(u8::is_ascii_digit)
            && bytes[5..9].iter().all(u8::is_ascii_digit)
            && bytes[10..14].iter().all(u8::is_ascii_digit)
    }

    /// Generates a random `RoomCode` using the provided RNG.
    pub fn generate_random<R: Rng + ?Sized>(rng: &mut R) -> Self {
        let part1 = rng.gen_range(0..10_000);
        let part2 = rng.gen_range(0..10_000);
        let part3 = rng.gen_range(0..10_000);
        Self(format!("{part1:04}-{part2:04}-{part3:04}"))
    }

    /// Generates a unique `RoomCode` that does not currently exist as a key in `DashMap`.
    pub fn generate_unique<V>(rooms: &DashMap<RoomCode, V>) -> Result<Self, RoomCodeError> {
        let mut rng = rand::thread_rng();
        const MAX_ATTEMPTS: usize = 1000;

        for _ in 0..MAX_ATTEMPTS {
            let candidate = Self::generate_random(&mut rng);
            if !rooms.contains_key(&candidate) {
                return Ok(candidate);
            }
        }

        Err(RoomCodeError::UniqueGenerationExhausted)
    }

    /// Returns the inner string reference.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Deref for RoomCode {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl fmt::Display for RoomCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for RoomCode {
    type Err = RoomCodeError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl TryFrom<&str> for RoomCode {
    type Error = RoomCodeError;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        Self::new(s)
    }
}

impl TryFrom<String> for RoomCode {
    type Error = RoomCodeError;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        Self::new(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_room_codes() {
        let valid = "1234-5678-9012";
        let code = RoomCode::new(valid);
        assert!(code.is_ok());
        assert_eq!(code.unwrap().as_str(), valid);

        let zero_code = "0000-0000-0000";
        assert!(RoomCode::new(zero_code).is_ok());
    }

    #[test]
    fn test_invalid_room_codes() {
        let cases = [
            "",
            "123456789012",
            "1234-5678-901",
            "1234-5678-90123",
            "1234_5678_9012",
            "123a-5678-9012",
            "1234-5678-901b",
            "12-3456-789012",
        ];

        for invalid in cases {
            assert_eq!(
                RoomCode::new(invalid),
                Err(RoomCodeError::InvalidFormat),
                "Expected {invalid} to be invalid"
            );
        }
    }

    #[test]
    fn test_generate_random_format() {
        let mut rng = rand::thread_rng();
        for _ in 0..100 {
            let code = RoomCode::generate_random(&mut rng);
            assert!(RoomCode::is_valid(&code));
        }
    }

    #[test]
    fn test_generate_unique() {
        let map = DashMap::new();
        let code1 = RoomCode::generate_unique(&map).expect("Should generate unique code");
        map.insert(code1.clone(), ());

        let code2 = RoomCode::generate_unique(&map).expect("Should generate unique code");
        assert_ne!(code1, code2);
    }
}
