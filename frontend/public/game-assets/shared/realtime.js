window.ArenaRealtime = {
  connect(game, onState, onAccess = () => {}) {
    const source = new EventSource(
      `/api/games/${encodeURIComponent(game)}/events`,
    );
    let renewing = false,
      closed = false;
    const target = window.parent || window;
    const close = () => {
      closed = true;
      source.close();
      target.removeEventListener("auth-changing", close);
    };
    target.addEventListener("auth-changing", close);

    source.addEventListener("renew", () => {
      renewing = true;
    });
    source.addEventListener("state", (event) => {
      if (closed) return;
      renewing = false;
      try {
        onState(JSON.parse(event.data));
      } catch {
        onAccess({
          status: 503,
          message: "Unable to read the team update. Reopen the arena.",
        });
      }
    });
    source.addEventListener("access", (event) => {
      if (closed) return;
      const error = JSON.parse(event.data);
      if (error.status === 401) {
        close();
        target.dispatchEvent(new target.Event("session-expired"));
      }
      onAccess(error);
    });
    source.onerror = () =>
      !closed &&
      !renewing &&
      onAccess({
        status: 503,
        message: "Team connection interrupted. Reconnecting…",
      });
    return close;
  },
};
