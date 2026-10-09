/* Same-origin session adapter. No credentials or tokens are passed to the game. */
window.platformApi = async (path, body) => {
  const res = await fetch("/api" + path, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(15000),
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (res.status === 401) {
    window.visionEngine?.stopCamera();
    parent.dispatchEvent(new parent.Event("session-expired"));
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Could not save your game.");
  return data;
};
window.app = {
  switchView: () => {
    parent.location.href = "/dashboard";
  },
  openModal: (id) => document.getElementById(id)?.classList.add("active"),
  closeModal: (id) => document.getElementById(id)?.classList.remove("active"),
  showToast(message, type = "info") {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = message;
    document.getElementById("toast-container").appendChild(el);
    setTimeout(() => el.remove(), 6000);
  },
  leaveTeam: () => {
    parent.location.href = "/dashboard";
  },
};
addEventListener("DOMContentLoaded", async () => {
  const camera = document.querySelector(
    ".gesture-center-panel .camera-feed-card",
  );
  if (camera) document.querySelector(".gesture-right-panel").prepend(camera);
  try {
    const { user } = await window.platformApi("/auth/me");
    const team =
      user.role === "ADMIN"
        ? { name: "Administrator test arena", code: "TEST ONLY" }
        : (await window.platformApi("/teams/me")).team;
    if (!team)
      throw new Error(
        "Create or join a team from your dashboard before playing.",
      );
    document
      .querySelectorAll(".view-section")
      .forEach((el) => el.classList.remove("active"));
    document.getElementById("view-game-arena").classList.add("active");
    await window.gameEngine.loadConfig();
    window.gameEngine.setParticipantData(
      {
        name: user.name,
        rollNumber: user.rollNo || "ADMIN TEST",
        teamCode: team.code,
      },
      team,
    );
    const state = await window.platformApi("/games/memory/state");
    state.stages.forEach(
      (s) => (window.gameEngine.stageScores[s.stage] = s.score),
    );
    window.gameEngine.totalScore = state.score;
    if (state.status === "COMPLETED") {
      state.stages.forEach(
        (s) => (window.gameEngine.stageScores[s.stage] = s.score),
      );
      window.gameEngine.totalScore = state.score;
      window.gameEngine.showFinalResults();
      return;
    }
    const engine = window.gameEngine;
    engine.sessionId = state.sessionId;
    const disconnect = window.ArenaRealtime.connect(
      "memory",
      (data) => {
        if (
          engine.sessionId &&
          (data.status === "NOT_STARTED" ||
            String(data.sessionId) !== String(engine.sessionId))
        ) {
          window.visionEngine?.stopCamera();
          clearInterval(engine.inputTimer);
          clearTimeout(engine.memorizeTimer);
          engine.isStepLocked = true;
          window.app.showToast(
            "Your attempt was reset. Return to games and reopen Memory.",
            "error",
          );
          disconnect();
          return;
        }
        const guess = data.active?.guesses?.[engine.currentInputIndex];
        if (guess && !engine.isStepLocked)
          void engine.handleDigitLocked(
            guess.digit,
            guess.correct,
            guess.timedOut,
          );
      },
      (error) => {
        if (error.status === 403 || error.status === 401) {
          window.visionEngine?.stopCamera();
          clearInterval(engine.inputTimer);
          clearTimeout(engine.memorizeTimer);
          engine.isStepLocked = true;
        }
        window.app.showToast(error.message, "error");
      },
    );
    addEventListener("pagehide", disconnect, { once: true });
    if (state.active?.started) {
      engine.currentStage = state.active.stage;
      engine.activeSequence = state.active.sequence;
      engine.guessResults = state.active.guesses || [];
      engine.userSequence = engine.guessResults.map((g) => g.digit);
      const resume = () => void engine.openOpenCVOutputBox();
      const remaining = Math.max(0, state.active.answerFrom - Date.now());
      if (remaining) {
        window.app.showToast(
          "Restored memorization progress. Answering opens when the saved timer ends.",
        );
        engine.memorizeTimer = setTimeout(resume, remaining);
      } else resume();
      return;
    }
    if (state.status === "NOT_STARTED")
      await window.platformApi("/games/memory/start", {});
    await window.gameEngine.startStage(state.stage + 1);
  } catch (error) {
    window.visionEngine?.stopCamera();
    document
      .querySelectorAll(".view-section")
      .forEach((view) => view.classList.remove("active"));
    window.app.showToast(error.message, "error");
    const el = document.createElement("div");
    el.style.cssText =
      "margin:16px;padding:20px;background:#142238;color:white;border-radius:12px";
    const text = document.createElement("p");
    text.textContent = error.message;
    const link = document.createElement("a");
    link.href = "/dashboard";
    link.target = "_parent";
    link.textContent = "Return to dashboard";
    el.append(text, link);
    document.body.prepend(el);
  } finally {
    document.body.classList.remove("platform-loading");
    document.getElementById("platform-loading-message")?.remove();
  }
});
addEventListener("pagehide", () => window.visionEngine?.stopCamera());
