// Global Edge runtime typings for WebSocketPair so TypeScript is happy in strict mode.
// This matches the runtime shape used in Edge handlers and avoids build-time errors.

interface EdgeWebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare var WebSocketPair: {
  prototype: EdgeWebSocketPair;
  new (): EdgeWebSocketPair;
};

interface EdgeGlobalThis {
  WebSocketPair: {
    prototype: EdgeWebSocketPair;
    new (): EdgeWebSocketPair;
  };
}

declare var globalThis: EdgeGlobalThis & typeof globalThis;

// Edge runtime extends WebSocket with accept()
interface WebSocket {
  accept?: () => void;
}


