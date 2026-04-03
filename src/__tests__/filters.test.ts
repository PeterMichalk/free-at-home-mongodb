import {
  FilterConfig,
  parseFilterConfig,
  parseDatapointKey,
  filterDatapoints,
  filterDevices,
} from '../filters';
import type { Device } from '@busch-jaeger/free-at-home/lib/fhapi/models/Device';

// ─── parseFilterConfig ────────────────────────────────────────────────────────

describe('parseFilterConfig', () => {
  it('returns empty Sets when called with no arguments', () => {
    const result = parseFilterConfig();
    expect(result.deviceSerials.size).toBe(0);
    expect(result.channelFunctions.size).toBe(0);
  });

  it('returns empty Sets for empty strings', () => {
    const result = parseFilterConfig('', '');
    expect(result.deviceSerials.size).toBe(0);
    expect(result.channelFunctions.size).toBe(0);
  });

  it('returns empty Sets for whitespace-only strings', () => {
    const result = parseFilterConfig('   ', '  ');
    expect(result.deviceSerials.size).toBe(0);
    expect(result.channelFunctions.size).toBe(0);
  });

  it('parses a single serial value', () => {
    const result = parseFilterConfig('ABB12345');
    expect(result.deviceSerials).toEqual(new Set(['ABB12345']));
  });

  it('parses multiple comma-separated serials', () => {
    const result = parseFilterConfig('ABB12345,ABB67890,ABB11111');
    expect(result.deviceSerials).toEqual(new Set(['ABB12345', 'ABB67890', 'ABB11111']));
  });

  it('trims whitespace around each serial', () => {
    const result = parseFilterConfig('  ABB12345 , ABB67890  ');
    expect(result.deviceSerials).toEqual(new Set(['ABB12345', 'ABB67890']));
  });

  it('filters out empty entries produced by trailing/leading commas', () => {
    const result = parseFilterConfig(',ABB12345,,ABB67890,');
    expect(result.deviceSerials).toEqual(new Set(['ABB12345', 'ABB67890']));
  });

  it('parses functionIDs independently from serials', () => {
    const result = parseFilterConfig(undefined, '7,12,48');
    expect(result.deviceSerials.size).toBe(0);
    expect(result.channelFunctions).toEqual(new Set(['7', '12', '48']));
  });

  it('parses both serials and functionIDs together', () => {
    const result = parseFilterConfig('ABB12345', '7,48');
    expect(result.deviceSerials).toEqual(new Set(['ABB12345']));
    expect(result.channelFunctions).toEqual(new Set(['7', '48']));
  });
});

// ─── parseDatapointKey ────────────────────────────────────────────────────────

describe('parseDatapointKey', () => {
  it('parses a valid key "ABB12345/ch0000/odp0000"', () => {
    const result = parseDatapointKey('ABB12345/ch0000/odp0000');
    expect(result).toEqual({ serial: 'ABB12345', channelId: 'ch0000' });
  });

  it('returns null for a key with no slashes', () => {
    expect(parseDatapointKey('ABB12345')).toBeNull();
  });

  it('returns null for a key with only 2 parts', () => {
    expect(parseDatapointKey('ABB12345/ch0000')).toBeNull();
  });

  it('returns null for a key with more than 3 parts', () => {
    expect(parseDatapointKey('ABB12345/ch0000/odp0000/extra')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseDatapointKey('')).toBeNull();
  });
});

// ─── filterDatapoints ─────────────────────────────────────────────────────────

describe('filterDatapoints', () => {
  const noFilter: FilterConfig = {
    deviceSerials: new Set(),
    channelFunctions: new Set(),
  };

  const datapoints: Record<string, string> = {
    'ABB001/ch0000/odp0000': '1',
    'ABB001/ch0001/odp0000': '0',
    'ABB002/ch0000/odp0000': '42',
  };

  const emptyMap = new Map<string, Map<string, string>>();

  it('returns the same reference when both filters are empty', () => {
    const result = filterDatapoints(datapoints, noFilter, emptyMap);
    expect(result).toBe(datapoints);
  });

  it('returns all datapoints when no filter is set', () => {
    const result = filterDatapoints(datapoints, noFilter, emptyMap);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('keeps datapoints for a matching serial', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['ABB001']), channelFunctions: new Set() };
    const result = filterDatapoints(datapoints, filter, emptyMap);
    expect(Object.keys(result)).toEqual([
      'ABB001/ch0000/odp0000',
      'ABB001/ch0001/odp0000',
    ]);
  });

  it('removes datapoints for a non-matching serial', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['ABB999']), channelFunctions: new Set() };
    const result = filterDatapoints(datapoints, filter, emptyMap);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('keeps datapoints for a channel whose functionID matches', () => {
    const funcMap = new Map<string, Map<string, string>>([
      ['ABB001', new Map([['ch0000', '7'], ['ch0001', '12']])],
    ]);
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['7']) };
    const result = filterDatapoints(datapoints, filter, funcMap);
    expect(Object.keys(result)).toEqual(['ABB001/ch0000/odp0000']);
  });

  it('removes a datapoint whose channel is not in the functionID map', () => {
    const funcMap = new Map<string, Map<string, string>>([
      ['ABB001', new Map([['ch0000', '7']])],
    ]);
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['7']) };
    const result = filterDatapoints(datapoints, filter, funcMap);
    // ABB001/ch0001 is not in funcMap → excluded; ABB002 not in funcMap → excluded
    expect(Object.keys(result)).toEqual(['ABB001/ch0000/odp0000']);
  });

  it('removes a datapoint when the functionID does not match', () => {
    const funcMap = new Map<string, Map<string, string>>([
      ['ABB001', new Map([['ch0000', '99']])],
    ]);
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['7']) };
    const result = filterDatapoints(datapoints, filter, funcMap);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('applies both serial AND functionID filters simultaneously', () => {
    const funcMap = new Map<string, Map<string, string>>([
      ['ABB001', new Map([['ch0000', '7'], ['ch0001', '7']])],
      ['ABB002', new Map([['ch0000', '7']])],
    ]);
    const filter: FilterConfig = {
      deviceSerials: new Set(['ABB001']),
      channelFunctions: new Set(['7']),
    };
    const result = filterDatapoints(datapoints, filter, funcMap);
    // Only ABB001 keys with functionID '7'
    expect(Object.keys(result)).toEqual([
      'ABB001/ch0000/odp0000',
      'ABB001/ch0001/odp0000',
    ]);
  });

  it('skips keys with an invalid format (not exactly 3 parts)', () => {
    const malformed: Record<string, string> = {
      'INVALID': '1',
      'ABB001/ch0000': '2',
      'ABB001/ch0000/odp0000/extra': '3',
    };
    const filter: FilterConfig = { deviceSerials: new Set(['ABB001']), channelFunctions: new Set() };
    const result = filterDatapoints(malformed, filter, emptyMap);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns an empty object when all datapoints are filtered out', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['NOMATCH']), channelFunctions: new Set() };
    const result = filterDatapoints(datapoints, filter, emptyMap);
    expect(result).toEqual({});
  });
});

// ─── filterDevices ────────────────────────────────────────────────────────────

describe('filterDevices', () => {
  const noFilter: FilterConfig = {
    deviceSerials: new Set(),
    channelFunctions: new Set(),
  };

  const devices: Record<string, Device> = {
    ABB001: {
      displayName: 'Licht Wohnzimmer',
      channels: {
        ch0000: { functionID: '7', displayName: 'Channel 1' },
        ch0001: { functionID: '12', displayName: 'Channel 2' },
      },
    },
    ABB002: {
      displayName: 'Thermostat',
      channels: {
        ch0000: { functionID: '48', displayName: 'Temp' },
      },
    },
  };

  it('returns the same reference when both filters are empty', () => {
    const result = filterDevices(devices, noFilter);
    expect(result).toBe(devices);
  });

  it('keeps a device that matches the serial filter', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['ABB001']), channelFunctions: new Set() };
    const result = filterDevices(devices, filter);
    expect(Object.keys(result)).toEqual(['ABB001']);
    expect(result['ABB001']).toBe(devices['ABB001']);
  });

  it('removes a device that does not match the serial filter', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['ABB999']), channelFunctions: new Set() };
    const result = filterDevices(devices, filter);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('keeps only channels matching the functionID filter', () => {
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['7']) };
    const result = filterDevices(devices, filter);
    expect(Object.keys(result)).toContain('ABB001');
    expect(Object.keys(result['ABB001'].channels!)).toEqual(['ch0000']);
    // ABB002 has functionID '48' → excluded
    expect(Object.keys(result)).not.toContain('ABB002');
  });

  it('excludes a device entirely when none of its channels match the functionID filter', () => {
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['99']) };
    const result = filterDevices(devices, filter);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('excludes a device with no channels when functionID filter is active', () => {
    const devicesNoChannels: Record<string, Device> = {
      ABB003: { displayName: 'No channels' },
    };
    const filter: FilterConfig = { deviceSerials: new Set(), channelFunctions: new Set(['7']) };
    const result = filterDevices(devicesNoChannels, filter);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('applies both serial AND functionID filters simultaneously', () => {
    const filter: FilterConfig = {
      deviceSerials: new Set(['ABB001']),
      channelFunctions: new Set(['12']),
    };
    const result = filterDevices(devices, filter);
    expect(Object.keys(result)).toEqual(['ABB001']);
    expect(Object.keys(result['ABB001'].channels!)).toEqual(['ch0001']);
  });

  it('returns an empty object when all devices are filtered out', () => {
    const filter: FilterConfig = { deviceSerials: new Set(['NOMATCH']), channelFunctions: new Set() };
    const result = filterDevices(devices, filter);
    expect(result).toEqual({});
  });
});
