import { AddOn } from '@busch-jaeger/free-at-home';
import { MongoClient, Db, Collection } from 'mongodb';
import WebSocket from 'ws';

// Interfaces
interface AddOnConfiguration {
  mongodbUri?: string;
  mongodbDb?: string;
  mongodbCol?: string;
  sysapUri?: string;
  username?: string;
  password?: string;
}

// MongoDB Manager
class MongoDBManager {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection | null = null;
  private connectionString: string = '';
  private databaseName: string = 'freeathome';
  private collectionName: string = 'device_changes';
  private isConnected: boolean = false;

  /**
   * Normalisiert den Connection String für Azure Cosmos DB
   */
  private normalizeConnectionString(connectionString: string): string {
    // Prüfe ob es Azure Cosmos DB ist
    const isCosmosDB = connectionString.includes('cosmos.azure.com') || 
                       connectionString.includes('mongo.cosmos.azure.com');
    
    if (!isCosmosDB) {
      return connectionString;
    }

    try {
      // Parse den Connection String
      let url: URL;
      
      if (connectionString.startsWith('mongodb+srv://')) {
        // Für mongodb+srv müssen wir es zu https konvertieren zum Parsen
        url = new URL(connectionString.replace('mongodb+srv://', 'https://'));
      } else if (connectionString.startsWith('mongodb://')) {
        url = new URL(connectionString.replace('mongodb://', 'http://'));
      } else {
        return connectionString; // Unbekanntes Format
      }

      // Füge notwendige Parameter für Azure Cosmos DB hinzu
      if (!url.searchParams.has('ssl')) {
        url.searchParams.set('ssl', 'true');
      }
      
      if (!url.searchParams.has('retryWrites')) {
        url.searchParams.set('retryWrites', 'false');
      }
      
      if (!url.searchParams.has('replicaSet')) {
        url.searchParams.set('replicaSet', 'globaldb');
      }

      // Konvertiere zurück
      if (connectionString.startsWith('mongodb+srv://')) {
        return url.toString().replace('https://', 'mongodb+srv://');
      } else {
        return url.toString().replace('http://', 'mongodb://');
      }
    } catch (error) {
      // Falls Parsing fehlschlägt, gebe den originalen String zurück
      console.warn('Konnte Connection String nicht normalisieren, verwende Original:', error);
      return connectionString;
    }
  }

  /**
   * Verbindet sich mit MongoDB
   */
  async connect(connectionString: string, databaseName?: string, collectionName?: string): Promise<void> {
    if (this.isConnected && this.connectionString === connectionString) {
      console.log('MongoDB bereits verbunden');
      return;
    }

    this.connectionString = connectionString;
    if (databaseName) this.databaseName = databaseName;
    if (collectionName) this.collectionName = collectionName;

    try {
      console.log('Verbinde mit MongoDB...');
      
      // Normalisiere Connection String für Azure Cosmos DB
      const normalizedConnectionString = this.normalizeConnectionString(connectionString);
      const isCosmosDB = normalizedConnectionString.includes('cosmos.azure.com') || 
                         normalizedConnectionString.includes('mongo.cosmos.azure.com');
      
      if (normalizedConnectionString !== connectionString) {
        console.log('Connection String für Azure Cosmos DB normalisiert');
      }
      
      // MongoDB Client Optionen - speziell für Azure Cosmos DB optimiert
      const clientOptions: any = {
        serverSelectionTimeoutMS: 30000, // 30 Sekunden Timeout
        connectTimeoutMS: 30000,
        socketTimeoutMS: 30000,
        retryReads: true,
        maxPoolSize: 10,
        minPoolSize: 1,
      };
      
      // Azure Cosmos DB spezifische Optionen
      if (isCosmosDB) {
        clientOptions.retryWrites = false; // Cosmos DB unterstützt kein retryWrites
        clientOptions.tls = true; // Erzwinge TLS/SSL
        clientOptions.tlsAllowInvalidCertificates = false;
        console.log('Azure Cosmos DB erkannt - verwende spezielle Optionen');
      }
      
      this.client = new MongoClient(normalizedConnectionString, clientOptions);
      
      // Verbinde mit Timeout
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout nach 30 Sekunden')), 30000)
        )
      ]);
      
      // Teste die Verbindung mit einem Ping
      try {
        await this.client.db('admin').command({ ping: 1 });
        console.log('MongoDB Ping erfolgreich');
      } catch (pingError) {
        // Für Cosmos DB kann admin DB nicht verfügbar sein, versuche stattdessen die Ziel-DB
        if (isCosmosDB) {
          await this.client.db(this.databaseName).command({ ping: 1 });
          console.log('MongoDB Ping erfolgreich (über Ziel-DB)');
        } else {
          throw pingError;
        }
      }
      
      this.db = this.client.db(this.databaseName);
      this.collection = this.db.collection(this.collectionName);
      
      this.isConnected = true;
      console.log(`MongoDB erfolgreich verbunden: ${this.databaseName}.${this.collectionName}`);
    } catch (error: any) {
      this.isConnected = false;
      const errorMessage = error.message || error.toString();
      console.error('Fehler beim Verbinden mit MongoDB:', errorMessage);
      
      // Detailliertere Fehlerinformationen für Debugging
      if (error.name) {
        console.error('Fehlertyp:', error.name);
      }
      if (error.code) {
        console.error('Fehlercode:', error.code);
      }
      if (error.cause) {
        console.error('Ursache:', error.cause);
      }
      
      throw error;
    }
  }

  /**
   * Speichert ein Event in MongoDB
   */
  async saveEvent(event: any): Promise<void> {
    if (!this.isConnected || !this.collection) {
      console.warn('MongoDB nicht verbunden, Event wird nicht gespeichert');
      return;
    }

    try {
      // Füge Timestamp hinzu
      const document = {
        ...event,
        _date: new Date()
      };
      await this.collection.insertOne(document);
    } catch (error) {
      console.error('Fehler beim Speichern des Events in MongoDB:', error);
    }
  }

  /**
   * Trennt die MongoDB Verbindung
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
        this.isConnected = false;
        console.log('MongoDB Verbindung getrennt');
      } catch (error) {
        console.error('Fehler beim Trennen der MongoDB Verbindung:', error);
      }
    }
  }

  /**
   * Prüft ob die Verbindung aktiv ist
   */
  get connected(): boolean {
    return this.isConnected;
  }
}

// Websocket Manager
class WebSocketManager {
  private ws: WebSocket | null = null;
  private sysapUri: string = '';
  private username: string = '';
  private password: string = '';
  private mongodbManager: MongoDBManager;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000; // 5 Sekunden
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;

  constructor(mongodbManager: MongoDBManager) {
    this.mongodbManager = mongodbManager;
  }

  /**
   * Verbindet sich mit dem free@home Websocket
   */
  async connect(sysapUri: string, username: string, password: string): Promise<void> {
    this.sysapUri = sysapUri;
    this.username = username;
    this.password = password;
    this.shouldReconnect = true;
    await this.connectWebSocket();
  }

  /**
   * Stellt die Websocket-Verbindung her
   */
  private async connectWebSocket(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    try {
      // Erstelle Basic Auth Header
      const authString = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      const wsUrl = `ws://${this.sysapUri}/fhapi/v1/api/ws`;

      console.log(`Verbinde mit Websocket: ${wsUrl.replace(/\/\/.*@/, '//***:***@')}`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Basic ${authString}`
        }
      }) as WebSocket;

      this.ws.on('open', () => {
        console.log('Websocket erfolgreich verbunden');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        await this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        console.error('Websocket Fehler:', error);
        this.isConnecting = false;
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`Websocket geschlossen: Code ${code}, Reason: ${reason.toString()}`);
        this.isConnecting = false;
        this.ws = null;

        // Automatische Wiederverbindung
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Versuche Reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms...`);
          setTimeout(() => {
            this.connectWebSocket();
          }, this.reconnectDelay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('Maximale Anzahl von Reconnect-Versuchen erreicht');
        }
      });

    } catch (error) {
      console.error('Fehler beim Verbinden mit Websocket:', error);
      this.isConnecting = false;
      throw error;
    }
  }

  /**
   * Verarbeitet eingehende Websocket-Nachrichten
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const messageString = data.toString();
      const message = JSON.parse(messageString);

      // Speichere die komplette Nachricht in MongoDB
      await this.mongodbManager.saveEvent(message);

    } catch (error) {
      console.error('Fehler beim Verarbeiten der Websocket-Nachricht:', error);
    }
  }

  /**
   * Trennt die Websocket-Verbindung
   */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Prüft ob die Verbindung aktiv ist
   */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

// Hauptklasse für das Addon
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
    const mongodbCol = defaultConfig.mongodbCol || process.env.MONGODB_COL || 'device_changes';

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
      await this.mongodbManager.connect(mongodbUri, mongodbDb, mongodbCol);

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

// Hauptfunktion
async function main(): Promise<void> {
  console.log("free@home MongoDB Addon gestartet");
  
  const addon = new FreeAtHomeMongoDBAddon();
  await addon.tryLoadInitialConfiguration();
  
  console.log("free@home MongoDB Addon initialisiert");
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Beende Addon...');
    await addon.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Beende Addon...');
    await addon.dispose();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Kritischer Fehler beim Starten des Addons:", error);
  process.exit(1);
});
