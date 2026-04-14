import { MongoClient, Db, Collection } from 'mongodb';

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 10;
  private readonly baseReconnectDelay: number = 5000;
  private readonly maxReconnectDelay: number = 300000;

  private isNetworkError(error: any): boolean {
    const name: string = error?.name ?? '';
    return (
      name === 'MongoNetworkError' ||
      name === 'MongoNetworkTimeoutError' ||
      name === 'MongoServerSelectionError' ||
      name === 'PoolClearedOnNetworkError' ||
      name === 'MongoTopologyClosedError'
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;

    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, attempt - 1),
      this.maxReconnectDelay
    );

    console.log(`MongoDB-Reconnect (Versuch ${attempt}/${this.maxReconnectAttempts}) in ${delay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.client) {
        try { await this.client.close(); } catch (_) {}
        this.client = null;
      }
      try {
        await this.connect(this.connectionString);
      } catch (error) {
        console.error('MongoDB-Reconnect fehlgeschlagen:', error);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        } else {
          console.error('Maximale Anzahl von MongoDB-Reconnect-Versuchen erreicht');
        }
      }
    }, delay);
  }

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
      this.reconnectAttempts = 0;
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
      if (this.isNetworkError(error)) {
        this.isConnected = false;
        if (this.pendingDatapoints.length < this.maxPendingEvents) {
          this.pendingDatapoints.push(document);
          console.warn(`Datapoint-Event gepuffert nach Netzwerkfehler (${this.pendingDatapoints.length}/${this.maxPendingEvents})`);
        } else {
          console.warn('Datapoint-Puffer voll, Event wird verworfen');
        }
        this.scheduleReconnect();
      }
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
      if (this.isNetworkError(error)) {
        this.isConnected = false;
        if (this.pendingDevices.length < this.maxPendingEvents) {
          this.pendingDevices.push(document);
          console.warn(`Device-Config-Event gepuffert nach Netzwerkfehler (${this.pendingDevices.length}/${this.maxPendingEvents})`);
        } else {
          console.warn('Device-Config-Puffer voll, Event wird verworfen');
        }
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Trennt die MongoDB Verbindung
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
