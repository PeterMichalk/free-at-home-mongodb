export interface AddOnConfiguration {
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

export interface FilterConfig {
  deviceSerials: Set<string>;    // leer = kein Filter
  channelFunctions: Set<string>; // leer = kein Filter
}
