# NEXUS Trade – Module 25–31 (Spezifikation, vom Nutzer übergeben am 2026-10-30)

Alle Inhalte stammen aus Chat-Prototypen mit synthetischen Demo-Daten. Zahlen darin sind Beispiele, keine Messwerte.

## 25 · Autonomous Market Execution & Order Lifecycle
Order-Routing, Ausführung, Slippage, Partial Fills, Orderzustände, Börsen-Failover.

## 26 · Position & Account Reconciliation
Grundprinzip: Der interne Systemzustand ist niemals automatisch die Wahrheit; maßgeblich sind abgeglichene Börsendaten und nachvollziehbare Transaktionsereignisse.
Abschnitte: Account Cockpit · Positionen · Order-Abgleich · Balances · Discrepancies · Reconciliation Engine · Audit Trail.
Kontrollbereiche: Positionen/Nettomenge, Wallet-/Margin-Balances, offene und abgeschlossene Orders, Fills/Transaktionshistorie, Gebühren/Funding/Realized PnL, Liquidationen/Transfers.
Schutzregel: Neue Orders bei ungeklärter Differenz BLOCKIEREN.

## 27 · Autonomous Treasury & Capital Operations
Portfolio entscheidet, welche Strategien Kapital brauchen; Treasury entscheidet, wo Kapital verfügbar sein muss und wie es sicher dorthin kommt.
Abschnitte: Treasury Cockpit · Capital Allocation · Venue Balances · Margin Intelligence · Liquidity Reserves · Transfers · Treasury Policies · Audit Trail.
Policies: Conservative (hohe Reserve, niedrige Konzentration) · Balanced · Aggressive. Kennzahlen: Gesamtkapital, verfügbar, Reserve, Reserve Ratio, Margin Utilization, Transfer Status.
Allokationsregeln: Strategiekapital nur bei gültiger Freigabe, Mindestreserve je Venue, Konzentrationslimits, Liquiditäts-/Kapazitätsprüfung, Risikobudget vor Kapitalerhöhung.
Grenzen: externe Transfers nicht autorisiert, echte Konten nicht verbunden, Live-Kapitalsteuerung deaktiviert.

## 28 · Market Regime & Macro Intelligence
Klassifiziert Marktbedingungen, erkennt Übergänge, liefert gemeinsame Entscheidungsgrundlage (keine Richtungsprognose).
Abschnitte: Regime Cockpit · Market Structure · Volatility Intelligence · Liquidity Intelligence · Macro Intelligence · Regime Transitions · Strategy Adaptation · Research & Audit.
Kennzahlen: Regime, Confidence, Stability, Trend Strength, Volatility (ATR/Realized), Liquidity (Depth/Spread), Macro Pressure; je Markt (BTC, ETH, SOL, TOTAL3).
Klassen: Bull/Bear Trend · Sideways/Range · Vol Expansion/Compression · Breakout/Breakdown · Accumulation/Distribution · Panic/Capitulation · Recovery/Transition.
Automatische Strategieänderung: nur Vorschläge.

## 29 · Autonomous Strategy Lifecycle Management
Strategien müssen ihre Einsatzberechtigung immer wieder durch aktuelle Evidenz bestätigen.
Abschnitte: Lifecycle Cockpit · Strategy Registry · Live Monitoring · Performance Drift · Strategy Health · Improvement Lab · Promotion & Release · Pause & Retirement · Audit Trail.
Pipeline: Discovery → Research & Hypothesis → Backtesting & Validation → Paper Trading → Canary → Production Monitoring → Improvement/Pause/Retirement.
Status je Strategie: Healthy / Under Review / Degraded / Testing; Lifecycle: Research / Paper / Production. Automatische Promotion deaktiviert.

## 30 · Model Risk & Intelligence Governance
Frage: Woher weiß NEXUS, dass seine eigenen Entscheidungen noch zuverlässig sind?
Abschnitte: Governance Cockpit · Model Registry · Model Validation · Drift Intelligence · Agent Governance · Decision Quality · Risk Policies · Incident Center · Audit Trail.
Überwachung: Modellqualität/statistische Validität, Datenintegrität/Feature Drift, Prognosekalibrierung, Agentenverhalten/Tool-Berechtigungen, Entscheidungskonsistenz, Fehlerhäufigkeit, Reproduzierbarkeit.
Health-Score je Komponente (0–100), Status Healthy/Watch/Degraded. Automatische Modellfreigabe deaktiviert.

## 31 · Autonomous System Supervisor
Kontroll- und Orchestrierungsebene über allen Agenten/Engines; kein Trading-Agent. Sicherheits- und Risikokontrollen bleiben unabhängig und können ihn blockieren.
Abschnitte: Command Center · System Map · Orchestration · Decision Engine · Conflict Resolution · Autonomy Control · System Health · Incident Response · Learning & Evolution · Audit Trail.
Zyklus: Observe → Interpret → Hypothesize → Validate → Decide → Execute → Measure & Learn.
Mission: "Find, validate and exploit durable market opportunities under controlled risk."
Kennzahlen: System Integrity, Active Modules, Agent Processes, Open Decisions, Critical Incidents. Controls: System pausieren, Zyklus auslösen.

## Schlussfolgerung (aus der Vorlage)
31 Module ≠ 31 Anwendungen. Ziel: integrierte Plattform mit gemeinsamen Datenmodellen, Ereignisprotokoll, Berechtigungen, Schnittstellen und zentralem Orchestrierungsmodell. Nächster Schritt ist nicht Modul 32, sondern die Zusammenführung in eine konsistente Gesamtarchitektur.

---
Status der Umsetzung: siehe [nexus-status.md](nexus-status.md).
