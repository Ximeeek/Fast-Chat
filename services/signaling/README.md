# services/signaling

Podprojekt dla serwera sygnalizacyjnego WebRTC projektu **FastChat Room**.

- **Technologia:** Rust + axum (planowana inicjalizacja w Fazach 2–5)
- **Przeznaczenie:** Minimalny, wysoce wydajny serwer WebSocket pośredniczący wyłącznie w wymianie SDP offer/answer oraz kandydatów ICE pomiędzy peerami przed nawiązaniem bezpośredniego połączenia P2P.
