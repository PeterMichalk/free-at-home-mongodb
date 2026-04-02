import { AddOn } from '@busch-jaeger/free-at-home';
import type { AddOnConfiguration } from './types';
import { parseFilterConfig } from './filters';
import { MongoDBManager } from './mongodbManager';
import { WebSocketManager } from './webSocketManager';

class FreeAtHomeMongoDBAddon {
  private mongodbManager: MongoDBManager;
  private websocketManager: WebSocketManager;
  private addOn: AddOn.AddOn;

  constructor() {
    this.mongodbManager = new MongoDBManager();
    this.websocketManager = new WebSocketManager(this.mongodbManager);

    const metaData = AddOn.readMetaData();
    this.addOn = new AddOn.AddOn(metaData.id);

    this.setupConfigurationHandler();
  }

  /**
   * Richtet den Handler für Konfigurationsänderungen ein
   */
  private setupConfigurationHandler(): void {
    this.addOn.on("configurationChanged", async (configuration: AddOn.Configuration) => {
      console.log("Konfiguration geändert");
      await this.handleConfigurationChange(configuration);
    });

    this.addOn.connectToConfiguration();
  }

  /**
   * Behandelt Konfigurationsänderungen
   */
  private async handleConfigurationChange(configuration: AddOn.Configuration): Promise<void> {
    const defaultConfig = configuration.default?.items as AddOnConfiguration | undefined;

    if (!defaultConfig) {
      console.warn("Keine Konfiguration gefunden");
      return;
    }

    // MongoDB Konfiguration
    const mongodbUri = defaultConfig.mongodbUri || process.env.MONGODB_URI;
    const mongodbDb = defaultConfig.mongodbDb || process.env.MONGODB_DB || 'freeathome';
    const mongodbColDatapoints = defaultConfig.mongodbColDatapoints || process.env.MONGODB_COL_DATAPOINTS || 'datapoints';
    const mongodbColDevices    = defaultConfig.mongodbColDevices    || process.env.MONGODB_COL_DEVICES    || 'device_config';

    // Filter-Konfiguration
    const filterConfig = parseFilterConfig(defaultConfig.filterDeviceSerials, defaultConfig.filterChannelFunctions);
    this.websocketManager.setFilterConfig(filterConfig);

    // free@home Websocket Konfiguration
    const sysapUri = defaultConfig.sysapUri || process.env.FREEHOME_SYSAPP;
    const username = defaultConfig.username || process.env.FREEHOME_USERNAME;
    const password = defaultConfig.password || process.env.FREEHOME_PASSWORD;

    if (!mongodbUri) {
      console.warn("MongoDB URI fehlt in der Konfiguration");
      return;
    }

    if (!sysapUri || !username || !password) {
      console.warn("free@home Websocket Konfiguration fehlt (SysAP URI, Username oder Password)");
      console.warn("Hinweis: Diese Werte können auch über Umgebungsvariablen gesetzt werden:");
      console.warn("  - FREEHOME_SYSAPP");
      console.warn("  - FREEHOME_USERNAME");
      console.warn("  - FREEHOME_PASSWORD");
      return;
    }

    try {
      // Verbinde mit MongoDB
      console.log("Versuche MongoDB-Verbindung herzustellen...");
      await this.mongodbManager.connect(mongodbUri, mongodbDb, mongodbColDatapoints, mongodbColDevices);

      // Verbinde mit Websocket (nur wenn MongoDB erfolgreich verbunden ist)
      if (this.mongodbManager.connected) {
        console.log("Versuche Websocket-Verbindung herzustellen...");
        await this.websocketManager.connect(sysapUri, username, password);
        console.log("Addon erfolgreich konfiguriert und verbunden");
      } else {
        console.error("MongoDB-Verbindung fehlgeschlagen, Websocket-Verbindung wird nicht gestartet");
      }
    } catch (error: any) {
      console.error("Fehler beim Verarbeiten der Konfiguration:", error.message || error);

      // Hilfreiche Tipps für häufige Probleme
      if (error.message && error.message.includes('closed')) {
        console.error("Hinweis: Die Verbindung wurde geschlossen. Mögliche Ursachen:");
        console.error("  1. Firewall-Regeln blockieren den Zugriff");
        console.error("  2. Connection String ist falsch formatiert");
        console.error("  3. Für Azure Cosmos DB: Stelle sicher, dass 'ssl=true' und 'retryWrites=false' im Connection String enthalten sind");
      }
      if (error.message && error.message.includes('authentication')) {
        console.error("Hinweis: Authentifizierungsfehler. Überprüfe Username und Password im Connection String");
      }
    }
  }

  /**
   * Versucht eine initiale Konfiguration zu laden
   */
  async tryLoadInitialConfiguration(): Promise<void> {
    setTimeout(async () => {
      // Konfiguration wird über configurationChanged Event geladen
      console.log("Warte auf Konfiguration...");
    }, 2000);
  }

  /**
   * Bereinigt Ressourcen beim Beenden
   */
  async dispose(): Promise<void> {
    this.websocketManager.disconnect();
    await this.mongodbManager.disconnect();
  }
}

export { FreeAtHomeMongoDBAddon };
