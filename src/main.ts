import { AddOn } from '@busch-jaeger/free-at-home';
import type { WebsocketMessage } from '@busch-jaeger/free-at-home/lib/fhapi/models/WebsocketMessage';
import type { Device } from '@busch-jaeger/free-at-home/lib/fhapi/models/Device';
import { MongoClient, Db, Collection } from 'mongodb';
import WebSocket from 'ws';

// Interfaces
interface AddOnConfiguration {
  mongodbUri?: string;
  mongodbDb?: string;
  mongodbColDatapoints?: string;
  mongodbColDevices?: string;
  sysapUri?: string;
  username?: string;
  password?: string;
  filterDeviceSerials?: string;
  filterChannelFunctions?: string;
}

// Filter-Konfiguration
export interface FilterConfig {
  deviceSerials: Set<string>;    // leer = kein Filter
  channelFunctions: Set<string>; // leer = kein Filter
}

export function parseFilterConfig(rawSerials?: string, rawFunctions?: string): FilterConfig {
  const parseSet = (raw: string | undefined): Set<string> => {
    if (!raw || raw.trim() === '') return new Set();
    return new Set(raw.split(',').map(s => s.trim()).filter(s => s.length > 0));
  };
  return {
    deviceSerials: parseSet(rawSerials),
    channelFunctions: parseSet(rawFunctions),
  };
}

export function parseDatapointKey(key: string): { serial: string; channelId: string } | null {
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  return { serial: parts[0], channelId: parts[1] };
}

export function filterDatapoints(
  datapoints: Record<string, string>,
  filter: FilterConfig,
  deviceFunctionMap: Map<string, Map<string, string>>
): Record<string, string> {
  if (filter.deviceSerials.size === 0 && filter.channelFunctions.size === 0) {
    return datapoints;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(datapoints)) {
    const parsed = parseDatapointKey(key);
    if (!parsed) continue;
    const { serial, channelId } = parsed;
    if (filter.deviceSerials.size > 0 && !filter.deviceSerials.has(serial)) continue;
    if (filter.channelFunctions.size > 0) {
      const funcId = deviceFunctionMap.get(serial)?.get(channelId);
      if (!funcId || !filter.channelFunctions.has(funcId)) continue;
    }
    result[key] = value;
  }
  return result;
}

export function filterDevices(
  devices: Record<string, Device>,
  filter: FilterConfig
): Record<string, Device> {
  if (filter.deviceSerials.size === 0 && filter.channelFunctions.size === 0) {
    return devices;
  }
  const result: Record<string, Device> = {};
  for (const [serial, device] of Object.entries(devices)) {
    if (filter.deviceSerials.size > 0 && !filter.deviceSerials.has(serial)) continue;
    if (filter.channelFunctions.size > 0) {
      // functionID-Filter aktiv: Gerät ohne Channels kann keinen Channel matchen → ausschließen
      if (!device.channels) continue;
      const filteredChannels: Record<string, import('@busch-jaeger/free-at-home/lib/fhapi/models/Channel').Channel> = {};
      for (const [chanId, channel] of Object.entries(device.channels)) {
        if (channel.functionID && filter.channelFunctions.has(channel.functionID)) {
          filteredChannels[chanId] = channel;
        }
      }
      if (Object.keys(filteredChannels).length === 0) continue;
      result[serial] = { ...device, channels: filteredChannels };
    } else {
      result[serial] = device;
    }
  }
  return result;
}

// MongoDB Manager
export class MongoDBManager {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connectionString: string = '';
  private databaseName: string = 'freeathome';
  private isConnected: boolean = false;
  private readonly maxPendingEvents: number = 1000;
  private collectionDatapoints: Collection | null = null;
  private collectionDevices: Collection | null = null;
  private collectionNameDatapoints: string = 'datapoints';
  private collectionNameDevices: string = 'device_config';
  private pendingDatapoints: any[] = [];
  private pendingDevices: any[] = [];

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
  async connect(connectionString: string, databaseName?: string, collectionNameDatapoints?: string, collectionNameDevices?: string): Promise<void> {
    if (this.isConnected && this.connectionString === connectionString) {
      console.log('MongoDB bereits verbunden');
      return;
    }

    this.connectionString = connectionString;
    if (databaseName) this.databaseName = databaseName;

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
        // Kein tls:true setzen – ssl=true im Connection String reicht; doppelte TLS-Optionen
        // können beim MongoDB-Driver v4 zu HandshakeError führen
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

      if (collectionNameDatapoints) this.collectionNameDatapoints = collectionNameDatapoints;
      if (collectionNameDevices)    this.collectionNameDevices    = collectionNameDevices;
      this.collectionDatapoints = this.db.collection(this.collectionNameDatapoints);
      this.collectionDevices    = this.db.collection(this.collectionNameDevices);

      this.isConnected = true;
      console.log(`MongoDB erfolgreich verbunden: ${this.databaseName} (${this.collectionNameDatapoints}, ${this.collectionNameDevices})`);

      if (this.pendingDatapoints.length > 0) {
        console.log(`Schreibe ${this.pendingDatapoints.length} gepufferte Datapoints nach...`);
        try {
          await this.collectionDatapoints.insertMany(this.pendingDatapoints, { ordered: false });
          console.log(`${this.pendingDatapoints.length} Datapoints erfolgreich nachgeschrieben`);
          this.pendingDatapoints = [];
        } catch (error) {
          console.error('Fehler beim Nachschreiben gepufferter Datapoints:', error);
        }
      }
      if (this.pendingDevices.length > 0) {
        console.log(`Schreibe ${this.pendingDevices.length} gepufferte Device-Config-Events nach...`);
        try {
          await this.collectionDevices.insertMany(this.pendingDevices, { ordered: false });
          console.log(`${this.pendingDevices.length} Device-Config-Events erfolgreich nachgeschrieben`);
          this.pendingDevices = [];
        } catch (error) {
          console.error('Fehler beim Nachschreiben gepufferter Device-Config-Events:', error);
        }
      }
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
   * Speichert einen Datapoint-Event in der Datapoints-Collection
   */
  async saveDatapointEvent(event: any): Promise<void> {
    const document = { ...event, _date: new Date() };
    if (!this.isConnected || !this.collectionDatapoints) {
      if (this.pendingDatapoints.length < this.maxPendingEvents) {
        this.pendingDatapoints.push(document);
        console.warn(`MongoDB nicht verbunden. Datapoint-Event gepuffert (${this.pendingDatapoints.length}/${this.maxPendingEvents})`);
      } else {
        console.warn('Datapoint-Puffer voll, Event wird verworfen');
      }
      return;
    }
    try {
      await this.collectionDatapoints.insertOne(document);
    } catch (error) {
      console.error('Fehler beim Speichern des Datapoint-Events:', error);
    }
  }

  /**
   * Speichert einen Device-Config-Event in der Device-Collection
   */
  async saveDeviceConfigEvent(event: any): Promise<void> {
    const document = { ...event, _date: new Date() };
    if (!this.isConnected || !this.collectionDevices) {
      if (this.pendingDevices.length < this.maxPendingEvents) {
        this.pendingDevices.push(document);
        console.warn(`MongoDB nicht verbunden. Device-Config-Event gepuffert (${this.pendingDevices.length}/${this.maxPendingEvents})`);
      } else {
        console.warn('Device-Config-Puffer voll, Event wird verworfen');
      }
      return;
    }
    try {
      await this.collectionDevices.insertOne(document);
    } catch (error) {
      console.error('Fehler beim Speichern des Device-Config-Events:', error);
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
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private sysapUri: string = '';
  private username: string = '';
  private password: string = '';
  private mongodbManager: MongoDBManager;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 10;
  private readonly baseReconnectDelay: number = 5000;  // 5 Sekunden Basis
  private readonly maxReconnectDelay: number = 60000;  // max 60 Sekunden
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private filterConfig: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set() };
  private deviceFunctionMap: Map<string, Map<string, string>> = new Map();

  constructor(mongodbManager: MongoDBManager) {
    this.mongodbManager = mongodbManager;
  }

  setFilterConfig(config: FilterConfig): void {
    this.filterConfig = config;
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

        // Automatische Wiederverbindung mit Exponential Backoff
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(
            this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.maxReconnectDelay
          );
          console.log(`Versuche Reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
          setTimeout(() => {
            this.connectWebSocket();
          }, delay);
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
   * Verarbeitet eingehende Websocket-Nachrichten und leitet sie gefiltert in die richtigen Collections
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message: WebsocketMessage = JSON.parse(data.toString());

      for (const sysapKey of Object.keys(message)) {
        const payload = message[sysapKey];

        // Device-Config-Änderungen → device_config Collection
        if (payload.devices && Object.keys(payload.devices).length > 0) {
          this.updateDeviceFunctionMap(payload.devices);
          const filtered = filterDevices(payload.devices, this.filterConfig);
          if (Object.keys(filtered).length > 0) {
            await this.mongodbManager.saveDeviceConfigEvent({ sysap: sysapKey, devices: filtered });
          }
        }

        // Datapoint-Änderungen → datapoints Collection
        if (payload.datapoints && Object.keys(payload.datapoints).length > 0) {
          const filtered = filterDatapoints(payload.datapoints, this.filterConfig, this.deviceFunctionMap);
          if (Object.keys(filtered).length > 0) {
            await this.mongodbManager.saveDatapointEvent({ sysap: sysapKey, datapoints: filtered });
          }
        }
      }
    } catch (error) {
      console.error('Fehler beim Verarbeiten der Websocket-Nachricht:', error);
    }
  }

  /**
   * Aktualisiert die interne functionID-Map aus einem devices-Payload
   */
  private updateDeviceFunctionMap(devices: Record<string, Device>): void {
    for (const [serial, device] of Object.entries(devices)) {
      if (!device.channels) continue;
      if (!this.deviceFunctionMap.has(serial)) {
        this.deviceFunctionMap.set(serial, new Map());
      }
      const channelMap = this.deviceFunctionMap.get(serial)!;
      for (const [chanId, channel] of Object.entries(device.channels)) {
        if (channel.functionID) {
          channelMap.set(chanId, channel.functionID);
        }
      }
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

// Nur ausführen wenn direkt gestartet (nicht wenn als Modul importiert, z.B. in Tests)
if (require.main === module) {
  main().catch((error) => {
    console.error("Kritischer Fehler beim Starten des Addons:", error);
    process.exit(1);
  });
}
