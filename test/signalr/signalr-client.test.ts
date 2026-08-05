import { afterEach, describe, expect, it, vi } from 'vitest';

const signalRMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class FakeHubConnection {
    state = 'Disconnected';
    connectionId: string | null = 'connection-1';
    readonly handlers = new Map<string, Set<Handler>>();
    reconnectingHandler: Handler | null = null;
    reconnectedHandler: Handler | null = null;
    closeHandler: Handler | null = null;
    readonly start = vi.fn(async () => {
      this.state = 'Connected';
    });
    readonly stop = vi.fn(async () => {
      this.state = 'Disconnected';
    });
    readonly invoke = vi.fn(async () => 'invoked-result');

    on(eventName: string, handler: Handler): void {
      const handlers = this.handlers.get(eventName) ?? new Set<Handler>();
      handlers.add(handler);
      this.handlers.set(eventName, handlers);
    }

    off(eventName: string, handler: Handler): void {
      this.handlers.get(eventName)?.delete(handler);
    }

    onreconnecting(handler: Handler): void {
      this.reconnectingHandler = handler;
    }

    onreconnected(handler: Handler): void {
      this.reconnectedHandler = handler;
    }

    onclose(handler: Handler): void {
      this.closeHandler = handler;
    }

    emit(eventName: string, ...args: unknown[]): void {
      this.handlers.get(eventName)?.forEach((handler) => handler(...args));
    }

    triggerReconnecting(error: Error): void {
      this.state = 'Reconnecting';
      this.reconnectingHandler?.(error);
    }

    triggerReconnected(connectionId: string): void {
      this.state = 'Connected';
      this.connectionId = connectionId;
      this.reconnectedHandler?.(connectionId);
    }

    triggerClose(error?: Error): void {
      this.state = 'Disconnected';
      this.closeHandler?.(error);
    }
  }

  class FakeHubConnectionBuilder {
    static readonly instances: FakeHubConnectionBuilder[] = [];
    readonly connection = new FakeHubConnection();
    readonly withUrl = vi.fn((url: string, options: Record<string, unknown>) => {
      this.url = url;
      this.urlOptions = options;
      return this;
    });
    readonly withAutomaticReconnect = vi.fn((policy: Record<string, unknown>) => {
      this.reconnectPolicy = policy;
      return this;
    });
    readonly configureLogging = vi.fn(() => this);
    readonly build = vi.fn(() => this.connection);
    url = '';
    urlOptions: Record<string, unknown> | undefined;
    reconnectPolicy: Record<string, unknown> | undefined;

    constructor() {
      FakeHubConnectionBuilder.instances.push(this);
    }
  }

  return {
    FakeHubConnection,
    FakeHubConnectionBuilder,
    LogLevel: {
      Information: 'Information',
      Warning: 'Warning',
    },
    reset(): void {
      FakeHubConnectionBuilder.instances.length = 0;
    },
  };
});

vi.mock('@microsoft/signalr', () => ({
  HubConnection: signalRMock.FakeHubConnection,
  HubConnectionBuilder: signalRMock.FakeHubConnectionBuilder,
  LogLevel: signalRMock.LogLevel,
}));

import { SignalRClient } from '../../src/signalr/signalr-client';

afterEach(() => {
  signalRMock.reset();
  vi.useRealTimers();
});

describe('SignalRClient', () => {
  it('builds the configured hub with a token factory and invokes methods', async () => {
    const client = new SignalRClient({
      baseUrl: 'https://app.example.test',
      hubPath: '/hubs/identity',
      reconnectDelay: 750,
      verbose: true,
    });
    const eventHandler = vi.fn();
    const unsubscribe = client.on('IdentityContextChanged', eventHandler);

    await client.connect('access-token-1');

    const builder = signalRMock.FakeHubConnectionBuilder.instances[0];
    expect(builder.url).toBe('https://app.example.test/hubs/identity');
    expect(builder.urlOptions?.accessTokenFactory).toEqual(expect.any(Function));
    expect((builder.urlOptions?.accessTokenFactory as () => string)()).toBe('access-token-1');
    expect(builder.withAutomaticReconnect).toHaveBeenCalledOnce();
    expect(builder.configureLogging).toHaveBeenCalledWith(signalRMock.LogLevel.Information);
    expect(client.connectionState).toBe('Connected');
    expect(client.isConnected).toBe(true);
    expect(client.connectionId).toBe('connection-1');

    builder.connection.emit('IdentityContextChanged', { version: 2 });
    expect(eventHandler).toHaveBeenCalledWith({ version: 2 });

    await expect(client.invoke<string>('RefreshIdentity', 'user-1')).resolves.toBe('invoked-result');
    expect(builder.connection.invoke).toHaveBeenCalledWith('RefreshIdentity', 'user-1');

    unsubscribe();
    builder.connection.emit('IdentityContextChanged', { version: 3 });
    expect(eventHandler).toHaveBeenCalledTimes(1);

    await client.disconnect();
    expect(builder.connection.stop).toHaveBeenCalledOnce();
    expect(client.connectionState).toBe('Disconnected');
    expect(client.isConnected).toBe(false);
  });

  it('preserves the exponential reconnect policy and lifecycle callbacks', async () => {
    vi.useFakeTimers();
    const client = new SignalRClient({
      baseUrl: 'https://app.example.test',
      hubPath: '/hubs/identity',
      reconnectDelay: 1000,
      maxReconnectAttempts: 2,
    });

    await client.connect('access-token-1');
    const firstBuilder = signalRMock.FakeHubConnectionBuilder.instances[0];
    const retryDelay = firstBuilder.reconnectPolicy?.nextRetryDelayInMilliseconds as (context: {
      previousRetryCount: number;
    }) => number;

    expect(retryDelay({ previousRetryCount: 0 })).toBe(1000);
    expect(retryDelay({ previousRetryCount: 1 })).toBe(2000);
    expect(retryDelay({ previousRetryCount: 5 })).toBe(16000);

    firstBuilder.connection.triggerReconnecting(new Error('transport interrupted'));
    expect(client.connectionState).toBe('Reconnecting');

    firstBuilder.connection.triggerReconnected('connection-2');
    expect(client.connectionState).toBe('Connected');
    expect(client.connectionId).toBe('connection-2');

    firstBuilder.connection.triggerClose(new Error('transport closed'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(signalRMock.FakeHubConnectionBuilder.instances).toHaveLength(2);
    const secondBuilder = signalRMock.FakeHubConnectionBuilder.instances[1];
    expect((secondBuilder.urlOptions?.accessTokenFactory as () => string)()).toBe('access-token-1');
    await client.disconnect();
  });

  it('rejects invocation while disconnected and requires a server-side base URL', async () => {
    const client = new SignalRClient({ hubPath: '/hubs/identity', maxReconnectAttempts: 0 });

    await expect(client.invoke('RefreshIdentity')).rejects.toThrow('SignalR not connected');
    await expect(client.connect('access-token-1')).resolves.toBeUndefined();
    expect(signalRMock.FakeHubConnectionBuilder.instances).toHaveLength(0);
  });
});
