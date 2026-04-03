import type { Device } from '@busch-jaeger/free-at-home/lib/fhapi/models/Device';
import type { FilterConfig } from './types';

export type { FilterConfig };

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
