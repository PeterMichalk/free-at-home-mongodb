import type { WebsocketMessage } from '@busch-jaeger/free-at-home/lib/fhapi/models/WebsocketMessage';
import type { Device } from '@busch-jaeger/free-at-home/lib/fhapi/models/Device';
import WebSocket from 'ws';
import type { FilterConfig } from './types';
import { filterDatapoints, filterDevices } from './filters';
import type { MongoDBManager } from './mongodbManager';

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
