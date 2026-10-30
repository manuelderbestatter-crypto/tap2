# NEXUS Trade – Baustatus

Stand: 2026-10-30 · Version nexus 0.1 · 57 Selbsttests (Modul 18)

Alles Papier-Handel gegen echte Live-Kurse. `LIVE_TRADING = false`. Keine Zugangsdaten, kein Server. Abschnitte, die nicht gebaut sind, bleiben ehrlich als Spezifikation (Register im Code, `mods.js`).

## 1 · Intelligence

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 01 Market Intelligence | 11/12 | News & Macro Context |
| 06 Data Intelligence | 8/8 | – (neu: Evidence Hub, Source Registry) |
| 20 Autonomous Research & Intelligence Orchestration | 15/15 | – |
| 28 Market Regime & Macro Intelligence | 8/8 | – |

## 2 · Discovery & Development

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 02 Algorithm Lab | 5/5 | – |
| 22 Autonomous Strategy Discovery & Development | 15/15 | – |
| 18 Testing, Quality Engineering & Simulation Infrastructure | 12/15 | End-to-End Tests, Backtesting Infrastructure, Market Replay Simulation |
| 29 Autonomous Strategy Lifecycle Management | 9/9 | – |

## 3 · Decision & Allocation

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 21 Autonomous Decision Intelligence & Strategic Control | 15/15 | – |
| 23 Autonomous Portfolio Intelligence & Capital Allocation | 15/15 | – |
| 08 Portfolio & Risk Management | 7/8 | Correlations |

## 4 · Execution & Operations

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 03 Autonomous Trader | 6/6 | – |
| 25 Autonomous Market Execution & Order Lifecycle | 7/7 | – |
| 26 Position & Account Reconciliation | 7/7 | – |
| 27 Autonomous Treasury & Capital Operations | 7/8 | Transfers |
| 09 Strategy Deployment & Release Management | 9/9 | – |
| 10 Autonomous Operations & Incident Center | 12/12 | – |
| 16 API, Integration & Connector Management | 10/16 | Internal APIs, Webhooks, Retry Policies, Schema Registry, API Versioning, Environments |
| 17 Deployment, Infrastructure & Cloud Management | 5/15 | Docker & Container Registry, Kubernetes / Orchestration, Compute & GPU Resources, CI/CD, Infrastructure as Code, Environment Provisioning, Autoscaling, Service Discovery, Secrets Integration, Release Rollback |

## 5 · Learning & Control

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 04 Learning Lab | 5/6 | Walk-Forward |
| 05 Journal & Decision Trace | 5/5 | – |
| 07 System Architecture & Orchestration | 8/8 | – |
| 11 Security, Secrets & Access Governance | 8/12 | Identity & Roles, Credential Rotation, Access Reviews, Session & Token Controls |
| 12 Configuration, Policy & Feature Flags | 9/12 | Flag Targeting, Rollout Rules, Approvals |
| 13 Monitoring, Observability & Performance Intelligence | 13/13 | – |
| 14 Backup, Disaster Recovery & Business Continuity | 12/13 | Regional Recovery |
| 15 Compliance, Governance & Audit Management | 12/13 | Change Approval |
| 19 Documentation, Knowledge Base & System Intelligence | 13/15 | Knowledge Graph, Agent Knowledge Access |
| 30 Model Risk & Intelligence Governance | 9/9 | – |

## 6 · Supervision

| Modul | gebaut | offen (Spezifikation) |
|---|---|---|
| 31 Autonomous System Supervisor | 10/10 | – |

**Gesamt: 285 von 319 Abschnitten gebaut.**

## Bekannte, bewusste Lücken

- Kein Server: kein Hintergrundbetrieb, keine Push-Nachrichten, keine echten Konten, kein WORM-/Schlüsselspeicher.
- Keine Makro-/News-/On-Chain-Daten (Modul 28 zeigt „nicht verfügbar“ statt Platzhalter).
- Kein Abgleich mit einem echten Börsenkonto (Modul 26 prüft die Buchhaltung des Papier-Kontos und sagt das).
- Infrastruktur-Abschnitte (Docker, Kubernetes, GPU, Autoscaling, CI/CD, Multi-Region) betreffen eine Server-Plattform.
- Backtesting-Infrastruktur, Marktwiedergabe (Replay), Ende-zu-Ende-Tests, Webhooks, Schema-Registry, Genehmigungs-Workflows und Konto-/Rollen-Verwaltung sind nicht gebaut.
- Hyperliquid: kein Trade-Backfill, keine Liquidationen.

## Schutzregeln im Code

- Risiko-Engine hat Vetorecht über jede Order (inkl. Kill-Switch, Pause, Limits, Treasury-Reserve, ungeklärte Konto-Differenz).
- Algorithmen, Entdeckung, Research und Supervisor können weder Limits ändern noch den Kill-Switch aufheben noch Strategien befördern (Modul 11/31, per Selbsttest geprüft).
- Jede Beförderung ist eine manuelle Entscheidung; automatische Beförderung/Modellfreigabe ist deaktiviert.
- Ereignisprotokoll ist hash-verkettet (Manipulationserkennung, keine Kryptografie).

## Daten-Hub (Modul 06)

Freie, öffentliche Quellen (Binance Spot/Perp, Fear & Greed, Coin Metrics, DefiLlama; über den eigenen Server: FRED-Makro, CNN). Jedes Merkmal wird gegen die Kursentwicklung danach geprüft (Evidenz-Check, vorab festgelegter Horizont, Mehrfachtest-Korrektur); ohne Beleg beeinflusst es keine Entscheidung. Nicht angebunden (ehrlich): bezahlte On-Chain-Varianten, Fondsflüsse, CVD je Fremdbörse, ETF-Flüsse, Nachrichten.

## Order-Flow-Pipeline (Server-Recorder) und Setups – Stand 30.10.2026
- **Data Plane (Server, `server/rec.js`)**: öffentliche WebSocket-Ströme Binance Spot/Perp, Bybit Spot/Perp, OKX Spot/Swap, Coinbase Spot, Hyperliquid Perp (BTC, ETH, SOL). Je Minute: Taker-Kauf/-Verkauf, nach Print-Größe (< 10 Tsd, < 100 Tsd, ≥ 100 Tsd), OHLC, echte Liquidationen (Binance, Bybit, OKX) + Einzel-Ereignisse mit Preis. Funding/OI aller 4 Perp-Börsen alle 15 min. Minuten 2 Tage, danach Stunden (bleibt). Lücken bleiben Lücken. `/api/rec`.
- **Feature Store (Client, `hubx.js`, `hubf.js`)**: Ungleichgewicht je Börse, Coinbase-Aufschlag, Wal- gegen Kleinanleger-Fluss, Liquidationen + Zonen (7 Tage), Funding OI-gewichtet, OI-Änderung, Absorption (Binance-Kerzen, 1000 h), STH-Kostenbasis/SOPR/NUPL (BGeometrics über Server, 8 h Cache, Format ungeprüft). Evidenz-Check mit Mehrfachtest-Korrektur für 18 Prüfungen (z 3,0).
- **Decision Engine (`nx_setup.js`)**: 4 Setups als Hypothesen – Absorption-Umkehr, Squeeze, Fragile Bewegung, STH-Rückeroberung (nur BTC, Swing 72 h). Varianten = Stufen: locker (Auslöser) · standard (+ Orderflow) · streng (+ Regime/On-Chain + Risiko Funding/OI). Vorwärtstest mit eigener Haltedauer.
- **Lagebild** (Command Center, Daten-Hub, Trader-Cockpit): gemessene Lage mit Evidenz-Chip, Status jedes Setups je Stufe inkl. Blockaden, „Was am wahrscheinlichsten funktioniert“ nur aus belegten Kandidaten.
- **Offen**: Orderbuch-Heatmap-Aufnahme, Footprint je Preisstufe, Deribit-GEX, Rückfüllung (data.binance.vision), ETF-Flüsse (Schlüssel nötig), Vorhersage-Liquidations-Heatmap (Modell).
