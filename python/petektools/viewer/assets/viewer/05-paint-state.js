  // Pure async paint-completion policy. Kept dependency-free so the same logic
  // is executable in the Node race harness as well as the assembled browser IIFE.
  function paintCompletionState(requestId, expectedRequestId, requestPaintKey, currentPaintKey) {
    if (requestId !== expectedRequestId) return "stale-request";
    if (requestPaintKey !== currentPaintKey) return "stale-paint";
    return "accept";
  }
