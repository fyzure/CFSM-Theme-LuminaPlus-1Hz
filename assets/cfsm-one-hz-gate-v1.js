(() => {
  const NativeWebSocket = window.WebSocket;
  const descriptor = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage');
  if (!descriptor?.get || !descriptor?.set || descriptor.configurable === false) return;

  const UI_INTERVAL_MS = 1000;
  const states = new WeakMap();

  const isRealtimeSocket = (socket) => {
    try {
      const url = new URL(socket.url, window.location.href);
      return url.pathname === '/api/ws';
    } catch {
      return false;
    }
  };

  const mergeBatchMessage = (state, message) => {
    if (!message || message.type !== 'batchUpdate' || !Array.isArray(message.updates)) return false;

    const messageTs = Number(message.ts);
    if (Number.isFinite(messageTs) && messageTs > 0) {
      state.messageTs = Math.max(state.messageTs, messageTs);
    }

    for (const update of message.updates) {
      if (!update || update.serverId == null || !Array.isArray(update.samples)) continue;
      const serverId = String(update.serverId);
      let bucket = state.updates.get(serverId);
      if (!bucket) {
        bucket = {
          ...update,
          serverId: update.serverId,
          samples: []
        };
        state.updates.set(serverId, bucket);
      } else {
        Object.assign(bucket, update);
        bucket.samples = bucket.samples || [];
      }

      for (const sample of update.samples) {
        if (!sample || typeof sample !== 'object') continue;
        bucket.samples.push(sample);
      }
    }

    return true;
  };

  const flush = (socket, state) => {
    state.timer = null;
    if (state.updates.size === 0 || typeof state.original !== 'function') return;

    const updates = [];
    for (const bucket of state.updates.values()) {
      const samples = Array.isArray(bucket.samples) ? bucket.samples : [];
      samples.sort((a, b) => {
        const aTs = Number(a?.ts ?? a?.timestamp ?? 0) || 0;
        const bTs = Number(b?.ts ?? b?.timestamp ?? 0) || 0;
        return aTs - bTs;
      });
      updates.push({ ...bucket, samples });
    }

    state.updates.clear();
    const payload = {
      type: 'batchUpdate',
      ts: state.messageTs || Date.now(),
      updates
    };
    state.messageTs = 0;

    const event = new MessageEvent('message', {
      data: JSON.stringify(payload),
      origin: window.location.origin
    });
    state.original.call(socket, event);
  };

  const scheduleFlush = (socket, state) => {
    if (state.timer != null) return;
    const now = Date.now();
    const delay = UI_INTERVAL_MS - (now % UI_INTERVAL_MS);
    state.timer = window.setTimeout(() => flush(socket, state), Math.max(1, delay));
  };

  Object.defineProperty(NativeWebSocket.prototype, 'onmessage', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      return states.get(this)?.original ?? descriptor.get.call(this);
    },
    set(handler) {
      const previous = states.get(this);
      if (previous?.timer != null) window.clearTimeout(previous.timer);

      if (!isRealtimeSocket(this) || typeof handler !== 'function') {
        states.delete(this);
        descriptor.set.call(this, handler);
        return;
      }

      const state = {
        original: handler,
        updates: new Map(),
        messageTs: 0,
        timer: null
      };
      states.set(this, state);

      descriptor.set.call(this, function(event) {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          state.original.call(this, event);
          return;
        }

        if (!mergeBatchMessage(state, message)) {
          state.original.call(this, event);
          return;
        }
        scheduleFlush(this, state);
      });
    }
  });
})();
