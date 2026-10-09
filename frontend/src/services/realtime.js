export const subscribeArena = (game, state, access) =>
  window.ArenaRealtime.connect(game, state, access);
