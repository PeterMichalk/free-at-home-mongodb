# free@home MongoDB Logger

Ein free@home Addon zur Speicherung aller Änderungen im Smarthome System in einer Azure MongoDB Datenbank. Das Addon überwacht alle Geräte, Channels und Datapoints via Websocket und speichert alle Änderungen in Echtzeit.

## Features

- 🔄 **Vollständige Überwachung** - Überwacht alle Geräte, Channels und Datapoints im System
- 📡 **Websocket-basiert** - Empfängt alle Änderungen in Echtzeit über Websocket
- 💾 **Azure MongoDB Integration** - Speichert alle Events direkt in Azure MongoDB
- 📊 **Detaillierte Events** - Erfasst Device-Serial, Channel-ID, Datapoint-ID, Werte und Timestamps
- 🔌 **Automatische Reconnection** - Automatische Wiederverbindung bei Verbindungsfehlern
- ⚡ **Echtzeit-Logging** - Alle Änderungen werden sofort erfasst und gespeichert

## Voraussetzungen

- ABB free@home System Access Point (SysAP)
- Azure MongoDB Instanz (MongoDB Atlas oder Azure Cosmos DB für MongoDB)
- Node.js 18.x (für Entwicklung)
- MongoDB Connection String

## Installation

### 1. Azure MongoDB einrichten

1. Erstelle eine Azure MongoDB Instanz (MongoDB Atlas oder Azure Cosmos DB)
2. Notiere dir den Connection String
3. Stelle sicher, dass die Firewall-Regeln den Zugriff erlauben

### 2. Addon installieren

1. Lade das Addon-Archiv herunter oder baue es selbst:
   ```bash
   npm install
   npm run buildProd
   npm run pack
   ```

2. Installiere das Addon in deinem free@home System über die Addon-Verwaltung

## Konfiguration

### Konfiguration in free@home

Nach der Installation musst du das Addon in den free@home Einstellungen konfigurieren:

1. **MongoDB Connection String**: Der vollständige Connection String zu deiner Azure MongoDB
   - Beispiel für MongoDB Atlas: `mongodb+srv://username:password@cluster.mongodb.net/`
   - Beispiel für Azure Cosmos DB: `mongodb://username:password@cluster.mongo.cosmos.azure.com:10255/`

2. **MongoDB Database Name** (optional): Name der Datenbank
   - Standard: `freeathome`

3. **MongoDB Collection Name** (optional): Name der Collection
   - Standard: `device_changes`

### MongoDB Connection String Format

Der Connection String sollte folgendes Format haben:
```
mongodb+srv://<username>:<password>@<cluster>/<database>?retryWrites=true&w=majority
```

oder für Azure Cosmos DB:
```
mongodb://<username>:<password>@<cluster>.mongo.cosmos.azure.com:10255/<database>?ssl=true&replicaSet=globaldb
```

## Verwendung

### Automatische Überwachung

Nach der Konfiguration startet das Addon automatisch die Überwachung aller Geräte im System:

- Alle vorhandenen Geräte werden sofort überwacht
- Neue Geräte werden automatisch erkannt und überwacht
- Alle Datapoint-Änderungen werden in Echtzeit erfasst

### Gespeicherte Daten

Jedes Event wird als Dokument in MongoDB gespeichert mit folgender Struktur:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "deviceSerial": "ABB123456789",
  "deviceName": "Wohnzimmer Licht",
  "channelId": "1",
  "channelName": "Channel 1",
  "datapointId": "123",
  "datapointName": "Switch",
  "newValue": "1",
  "deviceType": "switchingActuator",
  "channelType": "switchingActuator"
}
```

### Event-Typen

Das Addon erfasst drei Arten von Änderungen:

1. **Input Datapoint Changes**: Änderungen von außen (z.B. von der App)
2. **Output Datapoint Changes**: Änderungen vom Gerät selbst
3. **Parameter Changes**: Änderungen an Geräteparametern

### MongoDB Indizes

Das Addon erstellt automatisch Indizes für bessere Performance:

- Index auf `timestamp` (absteigend) für Zeit-basierte Abfragen
- Index auf `deviceSerial`, `channelId`, `datapointId` für Geräte-spezifische Abfragen

## Entwicklung

### Projekt-Struktur

```
free-at-home-mongodb/
├── src/
│   └── main.ts          # Hauptanwendungslogik
├── build/               # Kompilierte JavaScript-Dateien
├── fhstore/            # free@home Store-Dateien
├── free-at-home-metadata.json  # Addon-Metadaten
├── package.json        # NPM-Abhängigkeiten
└── tsconfig.json       # TypeScript-Konfiguration
```

### Verfügbare Scripts

```bash
# Entwicklung
npm run build           # TypeScript kompilieren
npm start              # Addon starten (für Tests)

# Produktion
npm run buildProd      # Produktions-Build ohne Source Maps
npm run pack           # Addon-Archiv erstellen

# Validierung
npm run validate       # Addon-Metadaten validieren

# Monitoring
npm run journal        # Addon-Logs anzeigen
npm run monitorstate   # Application State überwachen
npm run monitorconfig  # Konfiguration überwachen
```

### Lokale Entwicklung

1. Klone das Repository
2. Installiere Abhängigkeiten:
   ```bash
   npm install
   ```
3. Konfiguriere die `.vscode/launch.json` für Debugging
4. Baue das Projekt:
   ```bash
   npm run build
   ```
5. Teste lokal oder deploye auf deinen SysAP

## Datenanalyse

### Beispiel-Abfragen

**Alle Änderungen eines Geräts:**
```javascript
db.device_changes.find({ deviceSerial: "ABB123456789" })
  .sort({ timestamp: -1 })
```

**Änderungen in einem Zeitraum:**
```javascript
db.device_changes.find({
  timestamp: {
    $gte: ISODate("2024-01-01T00:00:00Z"),
    $lte: ISODate("2024-01-31T23:59:59Z")
  }
})
```

**Häufigste Änderungen:**
```javascript
db.device_changes.aggregate([
  { $group: { _id: "$deviceSerial", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 10 }
])
```

## Fehlerbehebung

### MongoDB Verbindung fehlgeschlagen

- Überprüfe den Connection String
- Stelle sicher, dass die Firewall-Regeln den Zugriff erlauben
- Prüfe die Netzwerkverbindung zum MongoDB Server

### Keine Events werden gespeichert

- Überprüfe die Logs mit `npm run journal`
- Stelle sicher, dass Geräte im System vorhanden sind
- Prüfe die MongoDB Verbindung

### Addon startet nicht

- Validiere die Metadaten: `npm run validate`
- Prüfe die Logs auf Fehlermeldungen
- Stelle sicher, dass alle Abhängigkeiten installiert sind

## Lizenz

MIT License - Siehe `fhstore/mit-en.txt` für Details.
