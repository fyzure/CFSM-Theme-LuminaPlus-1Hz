(() => {
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== "function") return;

  const isRealtimeSocket = (url) => {
    try {
      return new URL(String(url), window.location.href).pathname === "/api/ws";
    } catch {
      return false;
    }
  };

  class VisibilityAwareWebSocket {
    constructor(url, protocols) {
      this.url = new URL(String(url), window.location.href).href;
      this.protocol = "";
      this.extensions = "";
      this.binaryType = "blob";
      this.bufferedAmount = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;

      this._url = url;
      this._protocols = protocols;
      this._native = null;
      this._listeners = new Map();
      this._closedByClient = false;
      this._paused = document.hidden;
      this._logicalOpen = false;
      this._lastSubscription = null;

      this._onVisibilityChange = () => {
        if (document.hidden) this._pause();
        else this._resume();
      };
      this._onPageHide = () => this._pause();
      this._onPageShow = () => {
        if (!document.hidden) this._resume();
      };

      document.addEventListener("visibilitychange", this._onVisibilityChange);
      window.addEventListener("pagehide", this._onPageHide);
      window.addEventListener("pageshow", this._onPageShow);

      if (!this._paused) this._connect();
    }

    get readyState() {
      if (this._closedByClient) return NativeWebSocket.CLOSED;
      if (this._paused) {
        return this._logicalOpen ? NativeWebSocket.OPEN : NativeWebSocket.CONNECTING;
      }
      if (this._native) return this._native.readyState;
      return this._logicalOpen ? NativeWebSocket.OPEN : NativeWebSocket.CONNECTING;
    }

    addEventListener(type, listener) {
      if (!listener) return;
      let listeners = this._listeners.get(type);
      if (!listeners) {
        listeners = new Set();
        this._listeners.set(type, listeners);
      }
      listeners.add(listener);
    }

    removeEventListener(type, listener) {
      this._listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
      this._emit(event.type, event);
      return true;
    }

    send(data) {
      this._rememberSubscription(data);

      if (this._paused && this._logicalOpen) {
        return;
      }

      if (!this._native || this._native.readyState !== NativeWebSocket.OPEN) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          "InvalidStateError",
        );
      }
      this._native.send(data);
      this.bufferedAmount = this._native.bufferedAmount;
    }

    close(code, reason) {
      if (this._closedByClient) return;
      this._closedByClient = true;
      this._logicalOpen = false;
      this._cleanupLifecycleListeners();

      const socket = this._native;
      this._native = null;
      if (!socket) return;
      try {
        socket.close(code, reason);
      } catch {}
    }

    _connect() {
      if (this._closedByClient || this._paused || this._native) return;

      const wasLogicalOpen = this._logicalOpen;
      let socket;
      try {
        socket =
          this._protocols === undefined
            ? new NativeWebSocket(this._url)
            : new NativeWebSocket(this._url, this._protocols);
      } catch (error) {
        this._emit("error", error);
        return;
      }

      this._native = socket;
      socket.binaryType = this.binaryType;

      socket.onopen = (event) => {
        if (socket !== this._native || this._closedByClient || this._paused) return;
        this.protocol = socket.protocol;
        this.extensions = socket.extensions;
        this.bufferedAmount = socket.bufferedAmount;

        if (wasLogicalOpen) {
          this._replaySubscription();
          return;
        }

        this._logicalOpen = true;
        this._emit("open", event);
      };

      socket.onmessage = (event) => {
        if (socket !== this._native || this._closedByClient || this._paused) return;
        this._emit("message", event);
      };

      socket.onerror = (event) => {
        if (socket !== this._native || this._closedByClient || this._paused) return;
        this._emit("error", event);
      };

      socket.onclose = (event) => {
        if (socket !== this._native) return;
        this._native = null;
        if (this._closedByClient || this._paused) return;

        this._logicalOpen = false;
        this._cleanupLifecycleListeners();
        this._emit("close", event);
      };
    }

    _pause() {
      if (this._closedByClient || this._paused) return;
      this._paused = true;

      const socket = this._native;
      this._native = null;
      if (!socket) return;
      try {
        socket.close(1000, "page hidden");
      } catch {}
    }

    _resume() {
      if (this._closedByClient || !this._paused) return;
      this._paused = false;
      this._connect();
    }

    _rememberSubscription(data) {
      if (typeof data !== "string") return;
      try {
        const message = JSON.parse(data);
        if (message?.type === "subscribe") {
          this._lastSubscription = data;
        }
      } catch {}
    }

    _replaySubscription() {
      if (
        !this._lastSubscription ||
        !this._native ||
        this._native.readyState !== NativeWebSocket.OPEN
      ) {
        return;
      }
      try {
        this._native.send(this._lastSubscription);
      } catch {}
    }

    _emit(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") {
        try {
          handler.call(this, event);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }

      for (const listener of this._listeners.get(type) || []) {
        try {
          if (typeof listener === "function") listener.call(this, event);
          else listener?.handleEvent?.(event);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }

    _cleanupLifecycleListeners() {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      window.removeEventListener("pagehide", this._onPageHide);
      window.removeEventListener("pageshow", this._onPageShow);
    }
  }

  const VisibilityWebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      if (isRealtimeSocket(args[0])) {
        return new VisibilityAwareWebSocket(args[0], args[1]);
      }
      return Reflect.construct(target, args, newTarget === VisibilityWebSocket ? target : newTarget);
    },
  });

  window.WebSocket = VisibilityWebSocket;
})();
