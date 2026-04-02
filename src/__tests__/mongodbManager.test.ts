import { MongoDBManager } from '../mongodbManager';

// ─── MongoDB mock ─────────────────────────────────────────────────────────────

const mockInsertOne  = jest.fn().mockResolvedValue({ insertedId: 'id1' });
const mockInsertMany = jest.fn().mockResolvedValue({ insertedCount: 1 });
const mockCollection = jest.fn().mockReturnValue({ insertOne: mockInsertOne, insertMany: mockInsertMany });
const mockCommand    = jest.fn().mockResolvedValue({ ok: 1 });
const mockDb         = jest.fn().mockReturnValue({ collection: mockCollection, command: mockCommand });
const mockClose      = jest.fn().mockResolvedValue(undefined);
const mockConnect    = jest.fn().mockResolvedValue(undefined);

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    db: mockDb,
    close: mockClose,
  })),
}));

import { MongoClient } from 'mongodb';

const REGULAR_URI = 'mongodb://localhost:27017/testdb';
const COSMOS_SRV  = 'mongodb+srv://user:pass@cluster.mongo.cosmos.azure.com/db';
const COSMOS_STD  = 'mongodb://user:pass@cluster.cosmos.azure.com:10255/db';

// ─── helpers ──────────────────────────────────────────────────────────────────

function getMgr() {
  return new MongoDBManager();
}

// ─── normalizeConnectionString (private) ──────────────────────────────────────

describe('MongoDBManager.normalizeConnectionString', () => {
  let mgr: MongoDBManager;
  beforeEach(() => { mgr = getMgr(); });

  const normalize = (cs: string) =>
    (mgr as any).normalizeConnectionString(cs) as string;

  it('returns a non-Cosmos DB string unchanged', () => {
    expect(normalize(REGULAR_URI)).toBe(REGULAR_URI);
  });

  it('adds ssl, retryWrites and replicaSet to a cosmos.azure.com mongodb:// string', () => {
    const result = normalize(COSMOS_STD);
    expect(result).toContain('ssl=true');
    expect(result).toContain('retryWrites=false');
    expect(result).toContain('replicaSet=globaldb');
    expect(result.startsWith('mongodb://')).toBe(true);
  });

  it('adds ssl, retryWrites and replicaSet to a mongo.cosmos.azure.com mongodb+srv:// string', () => {
    const result = normalize(COSMOS_SRV);
    expect(result).toContain('ssl=true');
    expect(result).toContain('retryWrites=false');
    expect(result).toContain('replicaSet=globaldb');
    expect(result.startsWith('mongodb+srv://')).toBe(true);
  });

  it('does not duplicate ssl param if already present in the URI', () => {
    const uriWithSsl = COSMOS_STD + '?ssl=true';
    const result = normalize(uriWithSsl);
    const sslCount = (result.match(/ssl=/g) || []).length;
    expect(sslCount).toBe(1);
  });

  it('returns the original string if URL parsing fails (unknown protocol)', () => {
    const badUri = 'notmongodb://cluster.cosmos.azure.com/db';
    expect(normalize(badUri)).toBe(badUri);
  });
});

// ─── connect() ───────────────────────────────────────────────────────────────

describe('MongoDBManager.connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset MongoClient mock to default success behaviour
    (MongoClient as jest.MockedClass<typeof MongoClient>).mockImplementation(() => ({
      connect: mockConnect,
      db: mockDb,
      close: mockClose,
    }) as any);
    mockConnect.mockResolvedValue(undefined);
    mockCommand.mockResolvedValue({ ok: 1 });
    mockInsertMany.mockResolvedValue({ insertedCount: 1 });
  });

  it('creates a MongoClient and connects successfully', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    expect(MongoClient).toHaveBeenCalledWith(REGULAR_URI, expect.any(Object));
    expect(mockConnect).toHaveBeenCalled();
  });

  it('sets isConnected to true after a successful connect', async () => {
    const mgr = getMgr();
    expect(mgr.connected).toBe(false);
    await mgr.connect(REGULAR_URI);
    expect(mgr.connected).toBe(true);
  });

  it('returns early (skips reconnect) if already connected with the same URI', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    const callCount = (MongoClient as jest.MockedClass<typeof MongoClient>).mock.calls.length;
    await mgr.connect(REGULAR_URI); // second call – should be a no-op
    expect((MongoClient as jest.MockedClass<typeof MongoClient>).mock.calls.length).toBe(callCount);
  });

  it('uses custom databaseName', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI, 'mydb');
    expect(mockDb).toHaveBeenCalledWith('mydb');
  });

  it('uses custom datapoints and devices collection names when provided', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI, 'mydb', 'dps', 'devs');
    expect(mockCollection).toHaveBeenCalledWith('dps');
    expect(mockCollection).toHaveBeenCalledWith('devs');
  });

  it('falls back to default collection names when not provided', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    expect(mockCollection).toHaveBeenCalledWith('datapoints');
    expect(mockCollection).toHaveBeenCalledWith('device_config');
  });

  it('sets retryWrites=false for cosmos.azure.com URI', async () => {
    const mgr = getMgr();
    await mgr.connect(COSMOS_STD);
    const opts = (MongoClient as jest.MockedClass<typeof MongoClient>).mock.calls[0][1] as any;
    expect(opts.retryWrites).toBe(false);
    // tls wird NICHT als Client-Option gesetzt – ssl=true im Connection String reicht
    expect(opts.tls).toBeUndefined();
  });

  it('does NOT set Cosmos DB specific options for a regular MongoDB URI', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    const opts = (MongoClient as jest.MockedClass<typeof MongoClient>).mock.calls[0][1] as any;
    expect(opts.retryWrites).toBeUndefined();
    expect(opts.tls).toBeUndefined();
  });

  it('throws and sets isConnected to false on connection failure', async () => {
    mockConnect.mockRejectedValueOnce(new Error('network error'));
    const mgr = getMgr();
    await expect(mgr.connect(REGULAR_URI)).rejects.toThrow('network error');
    expect(mgr.connected).toBe(false);
  });

  it('rethrows ping failure for non-Cosmos DB', async () => {
    mockCommand.mockRejectedValueOnce(new Error('ping failed'));
    const mgr = getMgr();
    await expect(mgr.connect(REGULAR_URI)).rejects.toThrow('ping failed');
  });

  it('falls back to target DB ping for Cosmos DB if admin ping fails', async () => {
    // First call (admin ping) fails, second call (target DB ping) succeeds
    mockCommand
      .mockRejectedValueOnce(new Error('admin not available'))
      .mockResolvedValueOnce({ ok: 1 });
    const mgr = getMgr();
    await expect(mgr.connect(COSMOS_SRV)).resolves.not.toThrow();
    expect(mgr.connected).toBe(true);
  });

  it('flushes pendingDatapoints via insertMany after connect', async () => {
    const mgr = getMgr();
    await mgr.saveDatapointEvent({ dp: '1' });
    await mgr.connect(REGULAR_URI);
    expect(mockInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ dp: '1' })]),
      { ordered: false },
    );
  });

  it('flushes pendingDevices via insertMany after connect', async () => {
    const mgr = getMgr();
    await mgr.saveDeviceConfigEvent({ dev: 'X' });
    await mgr.connect(REGULAR_URI);
    expect(mockInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ dev: 'X' })]),
      { ordered: false },
    );
  });

  it('clears pending arrays after a successful flush', async () => {
    const mgr = getMgr();
    await mgr.saveDatapointEvent({ dp: '1' });
    await mgr.saveDeviceConfigEvent({ dev: 'X' });
    await mgr.connect(REGULAR_URI);
    expect((mgr as any).pendingDatapoints).toHaveLength(0);
    expect((mgr as any).pendingDevices).toHaveLength(0);
  });
});

// ─── saveDatapointEvent() ────────────────────────────────────────────────────

describe('MongoDBManager.saveDatapointEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCommand.mockResolvedValue({ ok: 1 });
  });

  it('inserts to the datapoints collection when connected', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    jest.clearAllMocks(); // clear flush calls
    await mgr.saveDatapointEvent({ dp: 'ABB/ch0/odp0' });
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({ dp: 'ABB/ch0/odp0', _date: expect.any(Date) }),
    );
  });

  it('buffers in pendingDatapoints when disconnected', async () => {
    const mgr = getMgr();
    await mgr.saveDatapointEvent({ dp: 'X' });
    expect((mgr as any).pendingDatapoints).toHaveLength(1);
  });

  it('discards and warns when the datapoints buffer is full', async () => {
    const mgr = getMgr();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 1000; i++) {
      (mgr as any).pendingDatapoints.push({ i });
    }
    await mgr.saveDatapointEvent({ dp: 'overflow' });
    expect((mgr as any).pendingDatapoints).toHaveLength(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voll'));
    warnSpy.mockRestore();
  });
});

// ─── saveDeviceConfigEvent() ─────────────────────────────────────────────────

describe('MongoDBManager.saveDeviceConfigEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCommand.mockResolvedValue({ ok: 1 });
  });

  it('inserts to the devices collection when connected', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    jest.clearAllMocks();
    await mgr.saveDeviceConfigEvent({ dev: 'ABB001' });
    expect(mockInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({ dev: 'ABB001', _date: expect.any(Date) }),
    );
  });

  it('buffers in pendingDevices when disconnected', async () => {
    const mgr = getMgr();
    await mgr.saveDeviceConfigEvent({ dev: 'X' });
    expect((mgr as any).pendingDevices).toHaveLength(1);
  });

  it('discards and warns when the devices buffer is full', async () => {
    const mgr = getMgr();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 1000; i++) {
      (mgr as any).pendingDevices.push({ i });
    }
    await mgr.saveDeviceConfigEvent({ dev: 'overflow' });
    expect((mgr as any).pendingDevices).toHaveLength(1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('voll'));
    warnSpy.mockRestore();
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe('MongoDBManager.disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCommand.mockResolvedValue({ ok: 1 });
  });

  it('calls client.close()', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    await mgr.disconnect();
    expect(mockClose).toHaveBeenCalled();
  });

  it('sets isConnected to false after disconnect', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    expect(mgr.connected).toBe(true);
    await mgr.disconnect();
    expect(mgr.connected).toBe(false);
  });

  it('does nothing if client is null (never connected)', async () => {
    const mgr = getMgr();
    await expect(mgr.disconnect()).resolves.not.toThrow();
    expect(mockClose).not.toHaveBeenCalled();
  });
});

// ─── connected getter ─────────────────────────────────────────────────────────

describe('MongoDBManager.connected', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockCommand.mockResolvedValue({ ok: 1 });
  });

  it('returns false initially', () => {
    expect(getMgr().connected).toBe(false);
  });

  it('returns true after a successful connect', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    expect(mgr.connected).toBe(true);
  });

  it('returns false after disconnect', async () => {
    const mgr = getMgr();
    await mgr.connect(REGULAR_URI);
    await mgr.disconnect();
    expect(mgr.connected).toBe(false);
  });
});
