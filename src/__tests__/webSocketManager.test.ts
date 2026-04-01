import { WebSocketManager, FilterConfig } from '../main';
import type { MongoDBManager } from '../main';

// ─── WebSocket mock ───────────────────────────────────────────────────────────

// Capture event handlers registered by the code under test
let capturedHandlers: Record<string, Function> = {};
const mockWsOn    = jest.fn((event: string, handler: Function) => { capturedHandlers[event] = handler; });
const mockWsClose = jest.fn();
let mockReadyState = 1; // WebSocket.OPEN = 1

jest.mock('ws', () => {
  const MockWS: any = jest.fn().mockImplementation(() => ({
    on: mockWsOn,
    close: mockWsClose,
    get readyState() { return mockReadyState; },
  }));
  MockWS.OPEN = 1;
  return { default: MockWS, __esModule: true };
});

import WebSocket from 'ws';

// ─── MongoDBManager mock ──────────────────────────────────────────────────────

function makeMockMgr(): jest.Mocked<Pick<MongoDBManager, 'saveDatapointEvent' | 'saveDeviceConfigEvent'>> {
  return {
    saveDatapointEvent:  jest.fn().mockResolvedValue(undefined),
    saveDeviceConfigEvent: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeManager() {
  const mockMgr = makeMockMgr();
  const wsm = new WebSocketManager(mockMgr as unknown as MongoDBManager);
  return { wsm, mockMgr };
}

async function connectAndCapture(wsm: WebSocketManager) {
  await wsm.connect('192.168.1.100', 'user', 'pass');
}

function emitMessage(data: object) {
  capturedHandlers['message']?.({ toString: () => JSON.stringify(data) });
}

// ─── connect() ───────────────────────────────────────────────────────────────

describe('WebSocketManager.connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  it('constructs the correct WebSocket URL', async () => {
    const { wsm } = makeManager();
    await wsm.connect('192.168.1.100', 'user', 'pass');
    expect(WebSocket).toHaveBeenCalledWith(
      'ws://192.168.1.100/fhapi/v1/api/ws',
      expect.any(Object),
    );
  });

  it('sends a correct Basic Auth header (base64 encoded username:password)', async () => {
    const { wsm } = makeManager();
    await wsm.connect('192.168.1.100', 'myuser', 'mypass');
    const options = (WebSocket as jest.MockedClass<typeof WebSocket>).mock.calls[0][1] as any;
    const expected = 'Basic ' + Buffer.from('myuser:mypass').toString('base64');
    expect(options.headers?.Authorization).toBe(expected);
  });

  it('registers open, message, error, and close event handlers', async () => {
    const { wsm } = makeManager();
    await wsm.connect('192.168.1.100', 'u', 'p');
    expect(capturedHandlers['open']).toBeDefined();
    expect(capturedHandlers['message']).toBeDefined();
    expect(capturedHandlers['error']).toBeDefined();
    expect(capturedHandlers['close']).toBeDefined();
  });
});

// ─── setFilterConfig() ───────────────────────────────────────────────────────

describe('WebSocketManager.setFilterConfig', () => {
  it('updates the internal filterConfig', () => {
    const { wsm } = makeManager();
    const newFilter: FilterConfig = {
      deviceSerials: new Set(['ABB001']),
      channelFunctions: new Set(['7']),
    };
    wsm.setFilterConfig(newFilter);
    expect((wsm as any).filterConfig).toBe(newFilter);
  });
});

// ─── handleMessage() ─────────────────────────────────────────────────────────

describe('WebSocketManager.handleMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  const SYSAP = 'sysap-uuid-1234';

  it('calls saveDeviceConfigEvent for a message with only a devices payload', async () => {
    const { wsm, mockMgr } = makeManager();
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: {},
        devices: { ABB001: { displayName: 'Light', channels: { ch0000: { functionID: '7' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve(); // flush microtasks

    expect(mockMgr.saveDeviceConfigEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sysap: SYSAP, devices: expect.objectContaining({ ABB001: expect.any(Object) }) }),
    );
    expect(mockMgr.saveDatapointEvent).not.toHaveBeenCalled();
  });

  it('calls saveDatapointEvent for a message with only a datapoints payload', async () => {
    const { wsm, mockMgr } = makeManager();
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: { 'ABB001/ch0000/odp0000': '1' },
        devices: {},
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    expect(mockMgr.saveDatapointEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sysap: SYSAP, datapoints: { 'ABB001/ch0000/odp0000': '1' } }),
    );
    expect(mockMgr.saveDeviceConfigEvent).not.toHaveBeenCalled();
  });

  it('calls both save methods when a message contains devices AND datapoints', async () => {
    const { wsm, mockMgr } = makeManager();
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: { 'ABB001/ch0000/odp0000': '1' },
        devices: { ABB001: { channels: { ch0000: { functionID: '7' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    expect(mockMgr.saveDeviceConfigEvent).toHaveBeenCalled();
    expect(mockMgr.saveDatapointEvent).toHaveBeenCalled();
  });

  it('does NOT call save methods when datapoints are filtered out by serial', async () => {
    const { wsm, mockMgr } = makeManager();
    wsm.setFilterConfig({ deviceSerials: new Set(['ABB999']), channelFunctions: new Set() });
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: { 'ABB001/ch0000/odp0000': '1' },
        devices: {},
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    expect(mockMgr.saveDatapointEvent).not.toHaveBeenCalled();
  });

  it('does NOT call save methods when devices are filtered out by serial', async () => {
    const { wsm, mockMgr } = makeManager();
    wsm.setFilterConfig({ deviceSerials: new Set(['ABB999']), channelFunctions: new Set() });
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: {},
        devices: { ABB001: { channels: { ch0000: { functionID: '7' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    expect(mockMgr.saveDeviceConfigEvent).not.toHaveBeenCalled();
  });

  it('handles invalid JSON gracefully without throwing', async () => {
    const { wsm, mockMgr } = makeManager();
    await connectAndCapture(wsm);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    capturedHandlers['message']?.({ toString: () => '{invalid json}' });
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    expect(mockMgr.saveDatapointEvent).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('processes multiple sysap keys within a single message', async () => {
    const { wsm, mockMgr } = makeManager();
    await connectAndCapture(wsm);

    const msg = {
      'sysap-1': {
        datapoints: { 'ABB001/ch0000/odp0000': '1' },
        devices: {},
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
      'sysap-2': {
        datapoints: { 'ABB002/ch0000/odp0000': '0' },
        devices: {},
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    expect(mockMgr.saveDatapointEvent).toHaveBeenCalledTimes(2);
  });
});

// ─── updateDeviceFunctionMap() ────────────────────────────────────────────────

describe('WebSocketManager.updateDeviceFunctionMap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  const SYSAP = 'sysap-uuid';

  it('builds a functionID map from a devices payload', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);

    const msg = {
      [SYSAP]: {
        datapoints: {},
        devices: {
          ABB001: { channels: { ch0000: { functionID: '7' }, ch0001: { functionID: '12' } } },
        },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    };
    emitMessage(msg);
    await Promise.resolve();

    const map: Map<string, Map<string, string>> = (wsm as any).deviceFunctionMap;
    expect(map.get('ABB001')?.get('ch0000')).toBe('7');
    expect(map.get('ABB001')?.get('ch0001')).toBe('12');
  });

  it('uses the functionID map for datapoint filtering in a subsequent message', async () => {
    const { wsm, mockMgr } = makeManager();
    wsm.setFilterConfig({ deviceSerials: new Set(), channelFunctions: new Set(['7']) });
    await connectAndCapture(wsm);

    // First message: teach the map
    emitMessage({
      [SYSAP]: {
        datapoints: {},
        devices: { ABB001: { channels: { ch0000: { functionID: '7' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    });
    await Promise.resolve();
    jest.clearAllMocks();

    // Second message: datapoints only – should pass because ch0000 has functionID '7'
    emitMessage({
      [SYSAP]: {
        datapoints: { 'ABB001/ch0000/odp0000': '1' },
        devices: {},
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    });
    await Promise.resolve();

    expect(mockMgr.saveDatapointEvent).toHaveBeenCalled();
  });

  it('updates existing map entries when a new devices payload arrives', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);

    emitMessage({
      [SYSAP]: {
        datapoints: {},
        devices: { ABB001: { channels: { ch0000: { functionID: '7' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    });
    await Promise.resolve();

    // Update: ch0000 now has a different functionID
    emitMessage({
      [SYSAP]: {
        datapoints: {},
        devices: { ABB001: { channels: { ch0000: { functionID: '48' } } } },
        devicesAdded: [], devicesRemoved: [], scenesTriggered: {},
      },
    });
    await Promise.resolve();

    const map: Map<string, Map<string, string>> = (wsm as any).deviceFunctionMap;
    expect(map.get('ABB001')?.get('ch0000')).toBe('48');
  });
});

// ─── WebSocket open handler ───────────────────────────────────────────────────

describe('WebSocketManager WebSocket open handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  it('resets reconnectAttempts to 0 on open', async () => {
    const { wsm } = makeManager();
    (wsm as any).reconnectAttempts = 5;
    await connectAndCapture(wsm);
    capturedHandlers['open']?.();
    expect((wsm as any).reconnectAttempts).toBe(0);
  });

  it('sets isConnecting to false on open', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    (wsm as any).isConnecting = true;
    capturedHandlers['open']?.();
    expect((wsm as any).isConnecting).toBe(false);
  });
});

// ─── Exponential backoff reconnect ───────────────────────────────────────────

describe('WebSocketManager exponential backoff reconnect', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules a reconnect with a 5s delay after the first close', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    capturedHandlers['close']?.(1006, Buffer.from(''));
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  it('doubles the delay on the second reconnect attempt (10s)', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    // First close → attempt 1 → 5s
    capturedHandlers['close']?.(1006, Buffer.from(''));
    jest.runAllTimers();

    // Second close → attempt 2 → 10s
    capturedHandlers['close']?.(1006, Buffer.from(''));
    const lastCallDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(lastCallDelay).toBe(10000);
  });

  it('caps the reconnect delay at 60s', async () => {
    const { wsm } = makeManager();
    // attempt 4 → after increment becomes 5 → delay = 5000 * 2^4 = 80000 → capped to 60000
    (wsm as any).reconnectAttempts = 4;
    await connectAndCapture(wsm);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    capturedHandlers['close']?.(1006, Buffer.from(''));

    const delay = setTimeoutSpy.mock.calls[0]?.[1] as number;
    expect(delay).toBe(60000);
  });

  it('stops reconnecting after maxReconnectAttempts (10)', async () => {
    const { wsm } = makeManager();
    (wsm as any).reconnectAttempts = 10;
    await connectAndCapture(wsm);

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    capturedHandlers['close']?.(1006, Buffer.from(''));

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not reconnect if shouldReconnect is false', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    (wsm as any).shouldReconnect = false;

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    capturedHandlers['close']?.(1006, Buffer.from(''));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe('WebSocketManager.disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
    mockReadyState = 1;
  });

  it('sets shouldReconnect to false', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    wsm.disconnect();
    expect((wsm as any).shouldReconnect).toBe(false);
  });

  it('calls ws.close()', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    wsm.disconnect();
    expect(mockWsClose).toHaveBeenCalled();
  });

  it('sets ws to null', async () => {
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    wsm.disconnect();
    expect((wsm as any).ws).toBeNull();
  });
});

// ─── connected getter ─────────────────────────────────────────────────────────

describe('WebSocketManager.connected', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandlers = {};
  });

  it('returns false when ws is null (never connected)', () => {
    const { wsm } = makeManager();
    expect(wsm.connected).toBe(false);
  });

  it('returns true when ws exists and readyState is OPEN', async () => {
    mockReadyState = 1; // OPEN
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    expect(wsm.connected).toBe(true);
  });

  it('returns false when ws readyState is not OPEN (e.g. CLOSING = 2)', async () => {
    mockReadyState = 2; // CLOSING
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    expect(wsm.connected).toBe(false);
  });

  it('returns false after disconnect()', async () => {
    mockReadyState = 1;
    const { wsm } = makeManager();
    await connectAndCapture(wsm);
    wsm.disconnect();
    expect(wsm.connected).toBe(false);
  });
});
