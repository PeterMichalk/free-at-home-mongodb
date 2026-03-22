import { AddOn } from '@busch-jaeger/free-at-home';
import { MongoClient, Collection } from 'mongodb';
import WebSocket from 'ws';

let mongoClient: MongoClient | null = null;
let collection: Collection | null = null;
let ws: WebSocket | null = null;
let shouldReconnect = true;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 10;

function normalizeCosmosUri(uri: string): string {
  if (!uri.includes('cosmos.azure.com')) return uri;
  try {
    const isSrv = uri.startsWith('mongodb+srv://');
    const httpUri = uri.replace(isSrv ? 'mongodb+srv://' : 'mongodb://', isSrv ? 'https://' : 'http://');
    const url = new URL(httpUri);
    if (!url.searchParams.has('ssl')) url.searchParams.set('ssl', 'true');
    if (!url.searchParams.has('retryWrites')) url.searchParams.set('retryWrites', 'false');
    if (!url.searchParams.has('replicaSet')) url.searchParams.set('replicaSet', 'globaldb');
    return url.toString().replace(isSrv ? 'https://' : 'http://', isSrv ? 'mongodb+srv://' : 'mongodb://');
  } catch {
    return uri;
  }
}

async function connectMongo(uri: string, dbName: string, colName: string): Promise<void> {
  await mongoClient?.close().catch(() => {});

  const normalizedUri = normalizeCosmosUri(uri);
  const isCosmosDB = normalizedUri.includes('cosmos.azure.com');

  mongoClient = new MongoClient(normalizedUri, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
    ...(isCosmosDB ? { retryWrites: false, tls: true } : {}),
  });

  await mongoClient.connect();

  // Cosmos DB erlaubt kein Ping auf admin DB
  try {
    await mongoClient.db('admin').command({ ping: 1 });
  } catch (e) {
    if (isCosmosDB) await mongoClient.db(dbName).command({ ping: 1 });
    else throw e;
  }

  collection = mongoClient.db(dbName).collection(colName);
  console.log(`MongoDB verbunden: ${dbName}.${colName}`);
}

function connectWebSocket(sysapUri: string, username: string, password: string): void {
  if (ws?.readyState === WebSocket.OPEN) return;

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  ws = new WebSocket(`ws://${sysapUri}/fhapi/v1/api/ws`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  ws.on('open', () => {
    console.log('WebSocket verbunden');
    reconnectAttempts = 0;
  });

  ws.on('message', async (data) => {
    if (!collection) return;
    try {
      await collection.insertOne({ ...JSON.parse(data.toString()), _date: new Date() });
    } catch (e) {
      console.error('Fehler beim Speichern:', e);
    }
  });

  ws.on('error', (e) => console.error('WebSocket Fehler:', e));

  ws.on('close', (code) => {
    console.log(`WebSocket geschlossen (${code})`);
    ws = null;
    if (shouldReconnect && reconnectAttempts < MAX_RECONNECTS) {
      reconnectAttempts++;
      console.log(`Reconnect ${reconnectAttempts}/${MAX_RECONNECTS} in 5s...`);
      setTimeout(() => connectWebSocket(sysapUri, username, password), 5000);
    }
  });
}

const metaData = AddOn.readMetaData();
const addon = new AddOn.AddOn(metaData.id);

addon.on('configurationChanged', async (config: AddOn.Configuration) => {
  const cfg = config.default?.items as any;
  if (!cfg) return;

  const uri = cfg.mongodbUri || process.env.MONGODB_URI;
  const db = cfg.mongodbDb || process.env.MONGODB_DB || 'freeathome';
  const col = cfg.mongodbCol || process.env.MONGODB_COL || 'device_changes';
  const sysap = cfg.sysapUri || process.env.FREEHOME_SYSAPP;
  const user = cfg.username || process.env.FREEHOME_USERNAME;
  const pass = cfg.password || process.env.FREEHOME_PASSWORD;

  if (!uri) { console.warn('MongoDB URI fehlt'); return; }
  if (!sysap || !user || !pass) { console.warn('free@home Konfiguration fehlt (SysAP, Username, Password)'); return; }

  try {
    await connectMongo(uri, db, col);
    connectWebSocket(sysap, user, pass);
  } catch (e: any) {
    console.error('Fehler beim Verbinden:', e.message || e);
  }
});

addon.connectToConfiguration();
console.log('free@home MongoDB Addon gestartet');

async function shutdown() {
  shouldReconnect = false;
  ws?.close();
  await mongoClient?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
