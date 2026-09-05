# FastChat Room

> Anonimowy, efemeryczny pokój czatu P2P z transferem plików — zero logowania, zero serwerowego kosztu, zero śladu.

## Struktura projektu (Monorepo)

Projekt jest zorganizowany jako monorepo składające się z trzech niezależnych podprojektów:

- **`apps/landing`** — Strona główna / landing page projektu (planowana implementacja: Astro, Faza 12). Odpowiada za prezentację rozwiązania i szybkie generowanie linku do nowego pokoju.
- **`apps/room`** — Główna aplikacja kliencka pokoju czatu (planowana implementacja: SvelteKit, Fazy 6–11). Odpowiada za interfejs czatu, negocjację połączeń P2P WebRTC (DataChannel), efemeryczny czat tekstowy oraz bezpośredni transfer plików w przeglądarce.
- **`services/signaling`** — Serwer sygnalizacyjny WebRTC (planowana implementacja: Rust + axum, Fazy 2–5). Odpowiada za wymianę danych sygnalizacyjnych (SDP offer/answer oraz kandydatów ICE) przez WebSocket przed zestawieniem bezpośredniego połączenia P2P.

## Status

**Status: w budowie**
Aktualnie zrealizowano Fazę 1 (inicjalizacja repozytorium oraz struktury monorepo).
