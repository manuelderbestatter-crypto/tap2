# Eigener Tape-Server – Einrichtung (nur mit dem Handy)

**Was es ist:** Ein kleiner gemieteter Server, der nur dir gehört. Die Engine läuft dort rund um die Uhr (Preise, Regime, Risiko, Papier-Trades, Forward-Test) und schickt Alarme aufs Handy. Öffnest du die App, übernimmt dein Handy die Steuerung; schließt du sie, macht der Server mit dem letzten Stand weiter. Es steuert immer nur einer. Alles bleibt Papier-Handel gegen echte Live-Preise, es gibt keine Börsen-Schlüssel auf dem Server.

## Einmalig einrichten

1. **Deploy-Schlüssel in GitHub eintragen** (damit der Server dein privates Repo lesen darf, nur lesen):
   GitHub → Repo `tap2` → Settings → Deploy keys → Add deploy key → Titel „Tape-Server“ → öffentlichen Schlüssel einfügen (steht in der Nachricht) → **„Allow write access“ NICHT anhaken** → Add key.
2. **ntfy-App installieren** (Android/iPhone, kostenlos) → „+“ → Thema eintragen (steht in der Nachricht), Server `ntfy.sh`. Darüber kommen Einrichtungs-Meldung und Alarme.
3. **Server mieten** (z. B. Hetzner Cloud, Preis vor dem Buchen prüfen):
   - Standort in Deutschland oder Finnland (Binance sperrt US-Standorte).
   - Betriebssystem **Ubuntu 24.04**.
   - Typ: mindestens **2 vCPU und 4 GB RAM** (der Headless-Browser braucht Platz).
   - **Keinen SSH-Schlüssel** angeben, Passwort-Login ist ohnehin abgeschaltet.
   - Im Feld **„Cloud-Config“ / „User data“** den kompletten Inhalt der ausgefüllten Datei `tape-cloud-init.yaml` einfügen.
4. **Warten (ca. 10–15 Minuten).** Dann kommt in ntfy „Tape-Server bereit“ mit der Adresse. Kommt „Einrichtung FEHLER“, steht der Grund in der Meldung.
5. **Adresse öffnen**, mit dem Passwort anmelden, im Browser-Menü „Zum Startbildschirm hinzufügen“.
6. **Alte Daten mitnehmen** (Konto, Journal, Einstellungen): In der alten App (GitHub-Pages-Adresse) Mehr → „Daten sichern“ → Sicherung herunterladen. In der neuen App dort „Sicherung einspielen“ wählen. Das lädt den Stand auch auf den Server.
7. **Erst danach** das Repo auf privat stellen: GitHub → Repo → Settings → Danger Zone → Change visibility → Private. Die alte Pages-Adresse geht dann nicht mehr (gewollt).

## Im Alltag

- **Updates:** Der Server prüft alle 5 Minuten, ob es im Repo eine neue Version gibt, und installiert sie selbst. Der Stand bleibt erhalten.
- **Status:** In der App unter Modul 17 → Deployment Pipelines → „Eigener Server“ → „Server-Status laden“.
- **Sicherungen:** Der Server legt alle 6 Stunden eine Kopie an (40 bleiben). Zusätzlich kannst du unter „Eigener Server“ den Stand herunterladen. Eine Kopie bei dir auf dem Handy ist der echte Schutz, falls der Server ausfällt.
- **Zwei Geräte:** Öffnest du die App auf einem zweiten Gerät, fragt das erste „Hier übernehmen?“.
- **Passwort vergessen / ändern:** Server im Hetzner-Konto neu aufsetzen (Daten vorher herunterladen).

## Ehrlich dazu

- Die Engine auf dem Server ist **derselbe Code wie in der App**, er läuft in einem unsichtbaren Browser. Das ist bewusst die einfachste Lösung, braucht aber Arbeitsspeicher; der Wächter startet die Engine neu, wenn sie hängt, und meldet es per Push.
- Fällt der gesamte Server aus, bekommst du **keine** Meldung, weil niemand mehr senden kann. Wer das absichern will, trägt bei `HC_URL` einen kostenlosen Überwachungs-Link (z. B. healthchecks.io) ein.
- Die Zertifikate holt der Server automatisch über eine kostenlose Adresse der Form `1-2-3-4.sslip.io`. Klappt das nicht, kommt „Einrichtung FEHLER“; dann eine eigene Adresse (z. B. von DuckDNS) im Feld `DOMAIN` eintragen.
- Der ntfy-Kanal ist öffentlich erreichbar, geschützt nur durch den langen Zufallsnamen. In Alarmen stehen Positionen und Ergebnisse. Wer das nicht will, nutzt Telegram (`TG_TOKEN`, `TG_CHAT`) oder einen eigenen ntfy-Server.
- Nicht auf einem echten Server getestet: Docker-Bau, Zertifikatsabruf und die Cloud-Init-Datei. Die Server-Logik (Login, Übergabe, Engine, Alarm, Sicherung) ist mit einem Simulator geprüft.
