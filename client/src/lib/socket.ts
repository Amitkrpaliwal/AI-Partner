import { io, Socket } from 'socket.io-client';
import { useStore } from '@/store';
import { bindWebSocketEvents } from '@/store/middleware/websocket';

class SocketManager {
  private socket: Socket | null = null;
  private static instance: SocketManager;

  private constructor() { }

  public static getInstance(): SocketManager {
    if (!SocketManager.instance) {
      SocketManager.instance = new SocketManager();
    }
    return SocketManager.instance;
  }

  public initialize(): Socket {
    if (this.socket) return this.socket;

    this.socket = io('http://localhost:3000', {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });

    this.setupListeners();

    // Bind store actions
    bindWebSocketEvents(this.socket, useStore.getState);

    return this.socket;
  }

  public getSocket(): Socket {
    if (!this.socket) {
      return this.initialize();
    }
    return this.socket;
  }

  private setupListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('✓ WebSocket connected');
      this.hydrateState();
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('✗ WebSocket disconnected:', reason);
      // Store could track connection state here if we added a slice for it
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`✓ WebSocket reconnected (attempt ${attemptNumber})`);
      this.hydrateState();
    });
  }

  private hydrateState() {
    if (!this.socket) return;

    console.log('Requesting state hydration...');
    // Send current active IDs to potentially resume specific context
    // getState() gives fresh state
    const store = useStore.getState();
    this.socket.emit('client:hydrate', {
      conversationId: store.activeConversationId
    });
  }

  public disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

export const socketManager = SocketManager.getInstance();
export const initializeSocket = () => socketManager.initialize();
export const getSocket = () => socketManager.getSocket();

// Backwards compat - DANGEROUS: accessing this might trigger init
// We change it to a getter to be safe or just alias the function
// If consumption code expects a Socket object, this breaks. 
// But existing code uses `import { socket }` and calls `.emit`. 
// If `socket` is an object, we can't easily proxy it without Proxy.
// However, I updated Sidebar to use `getSocket()`.
// Let's remove the dangerous exports.
// If any other file imports `socket`, it will fail safely at compile time rather than runtime crash.
// But valid compile is better.
// I'll check if I can make `socket` a proxy, but simpler to remove.

