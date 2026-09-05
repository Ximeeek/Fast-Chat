use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::request::Parts,
};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};

type HmacSha256 = Hmac<Sha256>;

/// 128-bit truncated HMAC-SHA256 rate-limiting key.
/// Key is derived strictly in memory from an ephemeral daily pepper and client IP.
/// It cannot be reversed to discover the original IP address.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RateKey(pub [u8; 16]);

impl RateKey {
    /// Returns the raw 16-byte slice representation of the rate key.
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    /// Formats the truncated key as a 32-character hexadecimal string.
    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

impl fmt::Debug for RateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RateKey({})", self.to_hex())
    }
}

impl fmt::Display for RateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

/// Derives a truncated 128-bit HMAC-SHA256 key from a 32-byte pepper secret and client IP.
pub fn derive_rate_key(pepper: &[u8; 32], ip: &IpAddr) -> RateKey {
    let mut mac = HmacSha256::new_from_slice(pepper).expect("HMAC accepts 32-byte keys");
    mac.update(ip.to_string().as_bytes());
    let result = mac.finalize().into_bytes();
    let mut truncated = [0u8; 16];
    truncated.copy_from_slice(&result[..16]);
    RateKey(truncated)
}

/// Ephemeral in-memory secret manager rotating every 24 hours.
/// Never written to persistent storage. When rotated, all previous
/// rate-limit records become cryptographically orphaned and decouple from client IPs.
#[derive(Clone, Debug)]
pub struct PepperManager {
    current_pepper: Arc<RwLock<[u8; 32]>>,
}

impl Default for PepperManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PepperManager {
    /// Instantiates a new PepperManager with a cryptographically secure random 32-byte pepper.
    pub fn new() -> Self {
        let mut initial = [0u8; 32];
        rand::thread_rng().fill(&mut initial);
        Self {
            current_pepper: Arc::new(RwLock::new(initial)),
        }
    }

    /// Instantiates a PepperManager with a fixed pepper for deterministic testing.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self {
            current_pepper: Arc::new(RwLock::new(bytes)),
        }
    }

    /// Rotates the ephemeral pepper by overwriting the in-memory buffer with fresh random bytes.
    pub fn rotate(&self) -> [u8; 32] {
        let mut next = [0u8; 32];
        rand::thread_rng().fill(&mut next);
        let mut guard = self.current_pepper.write().expect("lock not poisoned");
        *guard = next;
        next
    }

    /// Derives the 128-bit RateKey for a given IP address using the current daily pepper.
    pub fn derive_key(&self, ip: &IpAddr) -> RateKey {
        let guard = self.current_pepper.read().expect("lock not poisoned");
        derive_rate_key(&guard, ip)
    }
}

/// Axum extractor for resolving the client IP address from proxy headers or socket connection info.
/// Guaranteed to never fail (falls back to local loopback 127.0.0.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

impl<S> FromRequestParts<S> for ClientIp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // 1. Check X-Forwarded-For header (first hop in list)
        if let Some(forwarded) = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
        {
            if let Some(first_ip) = forwarded.split(',').next() {
                if let Ok(ip) = first_ip.trim().parse::<IpAddr>() {
                    return Ok(ClientIp(ip));
                }
            }
        }

        // 2. Check X-Real-IP header
        if let Some(real_ip) = parts
            .headers
            .get("x-real-ip")
            .and_then(|h| h.to_str().ok())
        {
            if let Ok(ip) = real_ip.trim().parse::<IpAddr>() {
                return Ok(ClientIp(ip));
            }
        }

        // 3. Fallback to socket ConnectInfo if present in extensions
        if let Some(ConnectInfo(addr)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            return Ok(ClientIp(addr.ip()));
        }

        // 4. Default fallback to loopback for headless unit/integration test requests
        Ok(ClientIp(IpAddr::from([127, 0, 0, 1])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn test_rate_key_hmac_deterministic_with_same_pepper() {
        let pepper = [42u8; 32];
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100));

        let key1 = derive_rate_key(&pepper, &ip);
        let key2 = derive_rate_key(&pepper, &ip);

        assert_eq!(key1, key2);
        assert_eq!(key1.as_bytes().len(), 16);
        assert_eq!(key1.to_hex().len(), 32);
    }

    #[test]
    fn test_pepper_rotation_invalidates_old_rate_key_for_same_ip() {
        let manager = PepperManager::new();
        let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));

        let key_before = manager.derive_key(&ip);
        manager.rotate();
        let key_after = manager.derive_key(&ip);

        // After rotation, identical client IP maps to a completely different rate key
        assert_ne!(key_before, key_after);
    }

    #[test]
    fn test_distinct_ips_yield_distinct_rate_keys() {
        let manager = PepperManager::new();
        let ip1 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1));
        let ip2 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2));

        let key1 = manager.derive_key(&ip1);
        let key2 = manager.derive_key(&ip2);

        assert_ne!(key1, key2);
    }

    #[test]
    fn test_ipv6_derivation_and_hex_format() {
        let manager = PepperManager::new();
        let ip = "2001:db8:85a3::8a2e:370:7334".parse::<IpAddr>().unwrap();

        let key = manager.derive_key(&ip);
        let hex = key.to_hex();
        assert_eq!(hex.len(), 32);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(format!("{key}"), hex);
        assert_eq!(format!("{key:?}"), format!("RateKey({hex})"));
    }

    #[tokio::test]
    async fn test_client_ip_extractor_priorities() {
        use axum::http::Request;

        // 1. X-Forwarded-For takes precedence (uses first IP)
        let req1 = Request::builder()
            .header("x-forwarded-for", "198.51.100.1, 10.0.0.1")
            .header("x-real-ip", "203.0.113.1")
            .body(())
            .unwrap();
        let (mut parts1, _) = req1.into_parts();
        let client_ip1 = ClientIp::from_request_parts(&mut parts1, &()).await.unwrap();
        assert_eq!(client_ip1.0, "198.51.100.1".parse::<IpAddr>().unwrap());

        // 2. X-Real-IP is used when X-Forwarded-For is absent
        let req2 = Request::builder()
            .header("x-real-ip", "203.0.113.50")
            .body(())
            .unwrap();
        let (mut parts2, _) = req2.into_parts();
        let client_ip2 = ClientIp::from_request_parts(&mut parts2, &()).await.unwrap();
        assert_eq!(client_ip2.0, "203.0.113.50".parse::<IpAddr>().unwrap());

        // 3. ConnectInfo is used when headers are absent
        let mut req3 = Request::builder().body(()).unwrap();
        let socket_addr: SocketAddr = "192.0.2.15:12345".parse().unwrap();
        req3.extensions_mut().insert(ConnectInfo(socket_addr));
        let (mut parts3, _) = req3.into_parts();
        let client_ip3 = ClientIp::from_request_parts(&mut parts3, &()).await.unwrap();
        assert_eq!(client_ip3.0, "192.0.2.15".parse::<IpAddr>().unwrap());

        // 4. Default fallback to 127.0.0.1
        let req4 = Request::builder().body(()).unwrap();
        let (mut parts4, _) = req4.into_parts();
        let client_ip4 = ClientIp::from_request_parts(&mut parts4, &()).await.unwrap();
        assert_eq!(client_ip4.0, "127.0.0.1".parse::<IpAddr>().unwrap());
    }
}
