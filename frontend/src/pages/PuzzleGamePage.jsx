import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { API_BASE_URL, apiFetch } from "../services/api";
import { subscribeArena } from "../services/realtime";
import {
  Trophy,
  Crown,
  Eye,
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  Loader2,
  ShieldAlert,
  Lightbulb,
  Award,
  RefreshCw,
  RotateCcw,
  Rocket,
  Hourglass,
  WifiOff,
} from "lucide-react";

/* ============================================================================
   HELPERS
   ============================================================================ */

async function request(path, options) {
  const res = await apiFetch(`${API_BASE_URL}${path}`, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || (data && data.success === false)) {
    throw new Error((data && data.message) || `Request failed (${res.status})`);
  }
  return data || {};
}

const formatClock = (secs) => {
  const n = Number(secs);
  if (!Number.isFinite(n)) return "--:--";
  const t = Math.max(0, Math.floor(n));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

const formatTime = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
};

const readAutoSubmit = () => {
  try {
    return localStorage.getItem("r1-auto-submit") !== "off";
  } catch {
    return true;
  }
};

/* ============================================================================
   PAGE
   ============================================================================ */

export function PuzzleGamePage() {
  const navigate = useNavigate();

  const [gameState, setGameState] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [syncLost, setSyncLost] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [board, setBoard] = useState([]);
  const [boardSaving, setBoardSaving] = useState(false);
  const boardSavingRef = useRef(false);
  const [held, setHeld] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [autoSubmit, setAutoSubmit] = useState(readAutoSubmit);
  const [showHint, setShowHint] = useState(false);
  const [shake, setShake] = useState(false);
  const [solvedFlash, setSolvedFlash] = useState(null);

  const mounted = useRef(true);
  const readSerialRef = useRef(0);
  const deadlineRef = useRef(null);
  const totalRef = useRef(0);
  const expiryFetchedRef = useRef(false);
  const fetchingRef = useRef(false);
  const latestStateRef = useRef(null);
  const submittingRef = useRef(false);
  const lastSubmittedRef = useRef("");
  const dragRef = useRef(null);
  const timersRef = useRef([]);

  useEffect(() => {
    mounted.current = true;
    const timers = timersRef.current;
    return () => {
      mounted.current = false;
      timers.forEach(clearTimeout);
    };
  }, []);

  const later = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      if (mounted.current) fn();
    }, ms);
    timersRef.current.push(id);
  }, []);

  /* ----------------------------- derived ----------------------------- */

  const session = gameState?.session;
  const puzzle = gameState?.currentPuzzle;
  const isLeader = Boolean(gameState?.isLeader);
  const hasStarted = Boolean(gameState?.hasStarted);
  const completed = Boolean(gameState?.isCompleted);
  const expired = Boolean(gameState?.isExpired);
  const active = hasStarted && !completed && !expired && Boolean(puzzle);
  const finished = completed || expired;
  const pieces = useMemo(() => puzzle?.pieces || [], [puzzle]);
  const slotCount = pieces.length;
  const puzzleKey = puzzle
    ? String(puzzle.id ?? puzzle._id ?? session?.currentPuzzleIndex ?? "p")
    : "";
  const gridCols =
    Number(puzzle?.gridCols) || Math.round(Math.sqrt(slotCount)) || 3;
  const canPlay =
    isLeader && active && !submitting && !boardSaving && remaining !== 0;
  const hasDeadline = typeof session?.remainingSeconds === "number";

  const pieceById = useMemo(
    () => new Map(pieces.map((p) => [p.pieceId, p])),
    [pieces],
  );
  // Tray order is fixed per puzzle so tiles don't jump around when the state refreshes.
  const pieceOrder = useMemo(
    () => pieces.map((p) => p.pieceId),
    [puzzleKey, slotCount],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const boardView = useMemo(
    () =>
      board.length === slotCount
        ? board
        : Array.from({ length: slotCount }, () => null),
    [board, slotCount],
  );
  const placedIds = useMemo(
    () => new Set(boardView.filter(Boolean).map((p) => p.pieceId)),
    [boardView],
  );
  const tray = useMemo(
    () =>
      pieceOrder
        .filter((id) => !placedIds.has(id))
        .map((id) => pieceById.get(id))
        .filter(Boolean),
    [pieceOrder, placedIds, pieceById],
  );
  const placedCount = placedIds.size;
  const boardFull = slotCount > 0 && placedCount === slotCount;

  /* ----------------------------- data ----------------------------- */

  const applyState = useCallback((data) => {
    const previous = latestStateRef.current;
    if (
      previous?.session?.id === data.session?.id &&
      previous?.session?.revision > data.session?.revision
    )
      return;
    latestStateRef.current = data;
    setGameState(data);
    const pieces = new Map(
      (data.currentPuzzle?.pieces || []).map((p) => [p.pieceId, p]),
    );
    setBoard((data.session?.board || []).map((id) => pieces.get(id) || null));
    const rs = data.session?.remainingSeconds;
    if (typeof rs === "number") {
      const exactDeadline = Date.parse(data.session?.expiresAt);
      deadlineRef.current = Number.isFinite(exactDeadline)
        ? exactDeadline + (data.serverNow ? Date.now() - data.serverNow : 0)
        : Date.now() + rs * 1000;
      totalRef.current = Math.max(
        totalRef.current,
        rs,
        Number(data.session?.durationSeconds) ||
          (Number.isFinite(exactDeadline) &&
          Number.isFinite(Date.parse(data.session?.startTime))
            ? (exactDeadline - Date.parse(data.session.startTime)) / 1000
            : 0),
      );
      if (rs > 0) expiryFetchedRef.current = false;
      setRemaining(
        Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)),
      );
    } else {
      deadlineRef.current = null;
      setRemaining(null);
    }
  }, []);

  const fetchGameState = useCallback(
    async ({ silent = false } = {}) => {
      if (silent && fetchingRef.current) return;
      fetchingRef.current = true;
      const serial = ++readSerialRef.current;
      try {
        const data = await request("/game/r1/sync", { method: "POST" });
        if (!mounted.current || serial !== readSerialRef.current) return;
        applyState(data);
        setLoadError("");
        setSyncLost(false);
        if (!silent) setActionError("");
      } catch (err) {
        if (!mounted.current) return;
        if (silent) setSyncLost(true);
        else setLoadError(err.message || "Could not load your game.");
      } finally {
        fetchingRef.current = false;
        if (mounted.current) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    },
    [applyState],
  );

  useEffect(() => {
    fetchGameState();
  }, [fetchGameState]);

  useEffect(
    () =>
      subscribeArena(
        "puzzle",
        (data) => {
          ++readSerialRef.current;
          applyState(data);
          setSyncLost(false);
          setLoadError("");
          setInitialLoading(false);
        },
        (error) => {
          setSyncLost(true);
          if (error.status === 403) {
            setLoadError(error.message);
            setGameState(null);
          }
        },
      ),
    [applyState],
  );

  // The countdown is computed from a server-based deadline, so it cannot drift or freeze in a background tab.
  useEffect(() => {
    if (!active || !hasDeadline) return undefined;
    const id = setInterval(() => {
      if (deadlineRef.current !== null)
        setRemaining(
          Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)),
        );
    }, 250);
    return () => clearInterval(id);
  }, [active, hasDeadline]);

  // When the clock hits zero, ask the server once what actually happened.
  useEffect(() => {
    if (active && remaining === 0 && !expiryFetchedRef.current) {
      expiryFetchedRef.current = true;
      fetchGameState({ silent: true });
    }
  }, [active, remaining, fetchGameState]);

  // New puzzle → fresh board. Refreshes of the same puzzle never wipe the leader's work.
  useEffect(() => {
    setHeld(null);
    setFeedback(null);
    setShowHint(false);
    lastSubmittedRef.current = "";
  }, [puzzleKey, slotCount]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setHeld(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ----------------------------- actions ----------------------------- */

  const handleStartGame = async () => {
    try {
      setStarting(true);
      setActionError("");
      await request("/game/r1/start", { method: "POST" });
      await fetchGameState({ silent: true });
    } catch (err) {
      if (mounted.current)
        setActionError(err.message || "Failed to start the session.");
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const submitBoard = useCallback(
    async (arrangement) => {
      if (submittingRef.current || !isLeader || !active || remaining === 0)
        return;
      const order = arrangement.map((p) => p?.pieceId);
      if (!order.length || order.some((id) => !id)) return;

      submittingRef.current = true;
      setSubmitting(true);
      setFeedback(null);
      setActionError("");
      lastSubmittedRef.current = order.join("|");
      try {
        const data = await request("/game/r1/submit", {
          method: "POST",
          body: JSON.stringify({ pieceOrder: order, puzzleId: puzzle.id }),
        });
        if (!mounted.current) return;
        if (data.expired) {
          await fetchGameState({ silent: true });
          return;
        }
        const text =
          data.message ||
          (data.isCorrect
            ? "Correct arrangement."
            : "That arrangement is not right yet.");
        setFeedback({ isCorrect: Boolean(data.isCorrect), text });
        if (data.isCorrect) {
          setSolvedFlash({
            points: data.pointsAwarded ?? data.points ?? null,
            text,
          });
          later(() => setSolvedFlash(null), 2600);
        } else {
          setShake(true);
          later(() => setShake(false), 500);
        }
        await fetchGameState({ silent: true });
      } catch (err) {
        if (mounted.current) {
          setActionError(err.message || "Submission failed.");
          lastSubmittedRef.current = "";
        }
      } finally {
        submittingRef.current = false;
        if (mounted.current) setSubmitting(false);
      }
    },
    [isLeader, active, remaining, puzzle?.id, fetchGameState, later],
  );

  const persistBoard = async (next) => {
    if (boardSavingRef.current) return false;
    boardSavingRef.current = true;
    setBoardSaving(true);
    setBoard(next);
    try {
      const current = latestStateRef.current;
      const data = await request("/game/r1/board", {
        method: "POST",
        body: JSON.stringify({
          sessionId: String(current.session.id),
          puzzleId: current.currentPuzzle.id,
          revision: current.session.revision,
          board: next.map((p) => p?.pieceId || null),
        }),
      });
      if (
        String(latestStateRef.current?.session?.id) !==
          String(current.session.id) ||
        latestStateRef.current?.hasStarted === false
      )
        return false;
      applyState(data);
      setActionError("");
      return true;
    } catch (error) {
      setActionError(error.message);
      await fetchGameState({ silent: true });
      return false;
    } finally {
      boardSavingRef.current = false;
      setBoardSaving(false);
    }
  };
  const move = async (source, target) => {
    if (!canPlay) return;
    const next = [...boardView];
    if (target === "tray") {
      if (source.from !== "board") {
        setHeld(null);
        return;
      }
      next[source.index] = null;
    } else if (source.from === "tray") {
      const piece = pieceById.get(source.pieceId);
      if (!piece) {
        setHeld(null);
        return;
      }
      next[target] = piece;
    } else {
      if (source.index === target) {
        setHeld(null);
        return;
      }
      [next[source.index], next[target]] = [next[target], next[source.index]];
    }
    setHeld(null);
    setFeedback(null);
    if (!(await persistBoard(next))) return;
    if (autoSubmit && next.length > 0 && next.every(Boolean)) {
      const key = next.map((p) => p.pieceId).join("|");
      if (key !== lastSubmittedRef.current) submitBoard(next);
    }
  };

  const clickTrayTile = (e, id) => {
    e.stopPropagation();
    if (!canPlay) return;
    setHeld((h) =>
      h?.from === "tray" && h.pieceId === id
        ? null
        : { from: "tray", pieceId: id },
    );
  };

  const clickSlot = (i) => {
    if (!canPlay) return;
    if (held) move(held, i);
    else if (boardView[i]) setHeld({ from: "board", index: i });
  };

  const clickTrayArea = () => {
    if (held?.from === "board") move(held, "tray");
  };

  const clearBoard = () => {
    if (!canPlay) return;
    void persistBoard(Array.from({ length: slotCount }, () => null));
    setHeld(null);
    setFeedback(null);
    lastSubmittedRef.current = "";
  };

  const toggleAutoSubmit = () => {
    const next = !autoSubmit;
    setAutoSubmit(next);
    try {
      localStorage.setItem("r1-auto-submit", next ? "on" : "off");
    } catch {
      /* storage unavailable */
    }
  };

  const startDrag = (e, source) => {
    if (!canPlay) {
      e.preventDefault();
      return;
    }
    dragRef.current = source;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "tile");
  };
  const dropOn = (e, target) => {
    e.preventDefault();
    e.stopPropagation();
    const source = dragRef.current;
    dragRef.current = null;
    if (source) move(source, target);
  };

  const manualRefresh = () => {
    setRefreshing(true);
    fetchGameState();
  };

  /* ----------------------------- render pieces ----------------------------- */

  if (initialLoading) {
    return (
      <AppShell>
        <style>{STYLES}</style>
        <div className="pg pg-center" role="status">
          <Loader2 size={34} className="pg-spin" />
          <p>Loading your Round 1 session…</p>
        </div>
      </AppShell>
    );
  }

  if (!gameState) {
    return (
      <AppShell>
        <style>{STYLES}</style>
        <div className="pg pg-center">
          <ShieldAlert size={34} className="pg-bad" />
          <h2>We couldn't load Round 1</h2>
          <p>
            {loadError || "Something went wrong while contacting the server."}
          </p>
          <button
            className="pg-btn primary"
            onClick={manualRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={15} className={refreshing ? "pg-spin" : ""} /> Try
            again
          </button>
        </div>
      </AppShell>
    );
  }

  const total =
    Number(session?.totalPuzzles) ||
    (Number(session?.currentPuzzleIndex) || 0) + 1;
  const currentIdx = Number(session?.currentPuzzleIndex) || 0;
  const timerTotal = totalRef.current || remaining || 1;
  const timePct =
    remaining === null
      ? 0
      : Math.max(0, Math.min(100, (remaining / timerTotal) * 100));
  const timeTone =
    remaining !== null && remaining <= 20
      ? "danger"
      : remaining !== null && remaining <= 60
        ? "warn"
        : "";
  const attempts = session?.attempts || [];
  const teamName = gameState?.team?.name || "—";

  return (
    <AppShell>
      <style>{STYLES}</style>
      <div className="pg">
        {/* ── Header ── */}
        <header className="pg-head">
          <div>
            <h1>Round 1: Tile assemble</h1>
            <p>
              <span>{teamName}</span>
              {gameState?.team?.code && (
                <span className="pg-code">{gameState.team.code}</span>
              )}
              <span className="pg-dim">IEEE Student Branch, NIT Durgapur</span>
            </p>
          </div>
          <div className="pg-stats">
            <div className="pg-stat">
              <strong>{session?.score || 0}</strong>
              <span>Score</span>
            </div>
            <div className="pg-stat">
              <strong>
                {hasStarted
                  ? `${Math.min(currentIdx + 1, total)}/${total}`
                  : "–"}
              </strong>
              <span>Puzzle</span>
            </div>
            <div className={`pg-stat time ${timeTone}`}>
              <strong>
                {remaining === null
                  ? gameState?.testMode && active
                    ? "∞"
                    : "--:--"
                  : formatClock(remaining)}
              </strong>
              <span>Time left</span>
            </div>
          </div>
        </header>

        {/* ── Role banner ── */}
        <div className={`pg-role ${isLeader ? "leader" : "member"}`}>
          {isLeader ? <Crown size={18} /> : <Eye size={18} />}
          <span>
            {isLeader ? (
              <>
                You're the team leader. You launch the session and submit
                arrangements for <b>{teamName}</b>.
              </>
            ) : (
              <>
                You're watching live. Only{" "}
                <b>{gameState?.team?.leaderName || "the team leader"}</b> can
                start and submit; this page updates by itself.
              </>
            )}
          </span>
          <button
            className="pg-btn ghost sm"
            onClick={manualRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={13} className={refreshing ? "pg-spin" : ""} />{" "}
            Refresh
          </button>
        </div>

        {syncLost && (
          <div className="pg-alert warn" role="status">
            <WifiOff size={16} />
            <span>
              Connection lost. Showing the last known state. Retrying…
            </span>
          </div>
        )}
        {actionError && (
          <div className="pg-alert bad" role="alert">
            <ShieldAlert size={16} />
            <span>{actionError}</span>
            <button onClick={() => setActionError("")}>Dismiss</button>
          </div>
        )}

        {/* ── Not started ── */}
        {!hasStarted && !finished && (
          <section className="pg-card pg-ready">
            <div className="pg-mini" aria-hidden="true">
              {Array.from({ length: 9 }).map((_, i) => (
                <i key={i} style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
            <h2>Ready to launch Round 1?</h2>
            <p className="pg-muted">
              {gameState?.message ||
                "Rebuild each picture by putting its tiles back in the right order."}
            </p>
            <ul className="pg-rules">
              <li>
                Put every tile into its slot, then submit the arrangement.
              </li>
              <li>
                Solving a puzzle unlocks the next one and adds to your team
                score.
              </li>
              <li>
                The clock is shared by the whole team once the leader starts.
              </li>
            </ul>
            {isLeader ? (
              <button
                className="pg-btn primary lg"
                onClick={handleStartGame}
                disabled={starting}
              >
                {starting ? (
                  <>
                    <Loader2 size={16} className="pg-spin" /> Launching…
                  </>
                ) : (
                  <>
                    <Rocket size={16} /> Start team session
                  </>
                )}
              </button>
            ) : (
              <div className="pg-wait">
                <Clock size={16} />
                <span>
                  Waiting for {gameState?.team?.leaderName || "your leader"} to
                  start. You'll move in automatically.
                </span>
              </div>
            )}
          </section>
        )}

        {/* ── Completed ── */}
        {completed && (
          <section className="pg-card pg-end">
            <Trophy size={44} className="pg-gold" />
            <h2>Round 1 complete, {teamName}!</h2>
            <p className="pg-muted">
              Every puzzle is solved.{" "}
              {gameState?.testMode
                ? "Practice complete; competition scores are unchanged."
                : "Your score was checked automatically. Round 2 is now unlocked."}
            </p>
            <div className="pg-stats center">
              <div className="pg-stat">
                <strong>{session?.score || 0}</strong>
                <span>Final score</span>
              </div>
              <div className="pg-stat">
                <strong>{session?.attemptsCount ?? attempts.length}</strong>
                <span>Attempts</span>
              </div>
            </div>
            <button
              className="pg-btn primary lg"
              onClick={() =>
                navigate(
                  gameState?.testMode
                    ? "/admin/games/puzzle"
                    : "/games/detective",
                )
              }
            >
              {gameState?.testMode
                ? "Back to game controls"
                : "Continue to Detective Case"}
            </button>
          </section>
        )}

        {/* ── Expired ── */}
        {expired && !completed && (
          <section className="pg-card pg-end">
            <Hourglass size={44} className="pg-warn" />
            <h2>Time's up</h2>
            <p className="pg-muted">
              Your round 1 session has ended. Your team's score and solved
              puzzles were kept.
            </p>
            <div className="pg-stats center">
              <div className="pg-stat">
                <strong>{session?.score || 0}</strong>
                <span>Final score</span>
              </div>
              <div className="pg-stat">
                <strong>{session?.puzzlesCompleted ?? currentIdx}</strong>
                <span>Solved</span>
              </div>
            </div>
            <button
              className="pg-btn ghost lg"
              onClick={() =>
                navigate(
                  gameState?.testMode
                    ? "/admin/games/puzzle"
                    : "/games/detective",
                )
              }
            >
              {gameState?.testMode
                ? "Back to game controls"
                : "Continue to Detective Case"}
            </button>
          </section>
        )}

        {/* ── Active game ── */}
        {active && (
          <div className="pg-layout">
            <div className="pg-col">
              <section className="pg-card pg-board-card" tabIndex={0} aria-label="Puzzle workspace">
                <div
                  className={`pg-clock ${timeTone}`}
                  role="progressbar"
                  aria-label="Time remaining"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(timePct)}
                >
                  <i style={{ width: `${timePct}%` }} />
                </div>

                <ol className="pg-steps" aria-label="Puzzle progress">
                  {Array.from({ length: total }).map((_, i) => (
                    <li
                      key={i}
                      className={
                        i < currentIdx ? "done" : i === currentIdx ? "now" : ""
                      }
                      aria-current={i === currentIdx ? "step" : undefined}
                    >
                      <span className="sr">
                        {i < currentIdx
                          ? `Puzzle ${i + 1} solved`
                          : i === currentIdx
                            ? `Puzzle ${i + 1} active`
                            : `Puzzle ${i + 1} locked`}
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="pg-puzzle-head">
                  <div>
                    <h2>{puzzle.title}</h2>
                    {puzzle.description && <p>{puzzle.description}</p>}
                  </div>
                  <div className="pg-pills">
                    <span className="pg-pill hi">
                      +{puzzle.points || 100} pts
                    </span>
                    <span className="pg-pill">
                      {placedCount}/{slotCount} placed
                    </span>
                  </div>
                </div>

                <div className={`pg-board-wrap ${shake ? "shake" : ""}`}>
                  <div
                    className="pg-board"
                    style={{
                      gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${Number(puzzle.gridRows) || Math.ceil(slotCount / gridCols)}, minmax(0, 1fr))`,
                    }}
                    role="group"
                    aria-label="Puzzle board"
                  >
                    {boardView.map((tile, i) => {
                      const isHeld = held?.from === "board" && held.index === i;
                      return (
                        <button
                          key={i}
                          type="button"
                          className={`pg-slot ${tile ? "filled" : ""} ${isHeld ? "held" : ""} ${held && !isHeld ? "target" : ""}`}
                          onClick={() => clickSlot(i)}
                          draggable={Boolean(tile) && canPlay}
                          onDragStart={(e) =>
                            startDrag(e, { from: "board", index: i })
                          }
                          onDragOver={(e) => {
                            if (canPlay) e.preventDefault();
                          }}
                          onDrop={(e) => dropOn(e, i)}
                          disabled={!isLeader}
                          aria-label={
                            tile
                              ? `Slot ${i + 1}, tile placed${isHeld ? ", picked up" : ""}`
                              : `Slot ${i + 1}, empty`
                          }
                        >
                          {tile ? (
                            <img src={tile.imageUrl} alt="" draggable={false} />
                          ) : (
                            <span>{i + 1}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {solvedFlash && (
                    <div className="pg-flash" role="status">
                      <CheckCircle2 size={44} />
                      <strong>Solved!</strong>
                      {solvedFlash.points !== null && (
                        <span>+{solvedFlash.points} points</span>
                      )}
                    </div>
                  )}
                  {submitting && (
                    <div className="pg-checking" role="status">
                      <Loader2 size={22} className="pg-spin" /> Checking…
                    </div>
                  )}
                </div>

                <div
                  className={`pg-tray ${held?.from === "board" ? "drop" : ""}`}
                  onClick={clickTrayArea}
                  onDragOver={(e) => {
                    if (canPlay) e.preventDefault();
                  }}
                  onDrop={(e) => dropOn(e, "tray")}
                >
                  <div className="pg-tray-head">
                    <strong>Tile tray</strong>
                    <span>
                      {!isLeader
                        ? "Only the leader can move tiles."
                        : held
                          ? held.from === "tray"
                            ? "Now click a slot to place it."
                            : "Click another slot to swap, or this tray to take it back."
                          : "Click a tile, then a slot. Or drag and drop."}
                    </span>
                  </div>
                  <div className="pg-tray-tiles">
                    {tray.length === 0 ? (
                      <p className="pg-muted">
                        {boardFull
                          ? "All tiles placed. Ready to submit."
                          : "No tiles left in the tray."}
                      </p>
                    ) : (
                      tray.map((t) => (
                        <button
                          key={t.pieceId}
                          type="button"
                          className={`pg-tile ${held?.from === "tray" && held.pieceId === t.pieceId ? "held" : ""}`}
                          onClick={(e) => clickTrayTile(e, t.pieceId)}
                          draggable={canPlay}
                          onDragStart={(e) =>
                            startDrag(e, { from: "tray", pieceId: t.pieceId })
                          }
                          disabled={!isLeader}
                          aria-label="Tile"
                        >
                          <img src={t.imageUrl} alt="" draggable={false} />
                        </button>
                      ))
                    )}
                  </div>
                </div>

                {puzzle.hint && (
                  <div className="pg-hint">
                    {showHint ? (
                      <p>
                        <Lightbulb size={15} /> {puzzle.hint}
                      </p>
                    ) : (
                      <button
                        className="pg-btn ghost sm"
                        onClick={() => setShowHint(true)}
                      >
                        <Lightbulb size={14} /> Show hint
                      </button>
                    )}
                  </div>
                )}

                {feedback && (
                  <div
                    className={`pg-feedback ${feedback.isCorrect ? "ok" : "no"}`}
                    role="status"
                  >
                    {feedback.isCorrect ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <XCircle size={16} />
                    )}
                    <span>{feedback.text}</span>
                  </div>
                )}

                {isLeader && (
                  <div className="pg-controls">
                    <label className="pg-toggle">
                      <input
                        type="checkbox"
                        checked={autoSubmit}
                        onChange={toggleAutoSubmit}
                      />
                      <span>Submit automatically when the board is full</span>
                    </label>
                    <div className="pg-control-btns">
                      <button
                        className="pg-btn ghost"
                        onClick={clearBoard}
                        disabled={!canPlay || placedCount === 0}
                      >
                        <RotateCcw size={14} /> Clear board
                      </button>
                      <button
                        className="pg-btn primary"
                        onClick={() => submitBoard(boardView)}
                        disabled={!canPlay || !boardFull}
                      >
                        {submitting ? (
                          <Loader2 size={15} className="pg-spin" />
                        ) : (
                          <Send size={15} />
                        )}{" "}
                        Submit arrangement
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <aside className="pg-col">
              <section className="pg-card pg-attempts">
                <h3>
                  <Award size={16} /> Attempt history
                </h3>
                <p className="pg-muted sm">Team {teamName}. Newest first.</p>
                {attempts.length === 0 ? (
                  <p className="pg-none">No attempts yet.</p>
                ) : (
                  <ul>
                    {[...attempts].reverse().map((att, idx) => (
                      <li
                        key={att.attemptNumber ?? idx}
                        className={att.isCorrect ? "ok" : "no"}
                      >
                        <div className="pg-att-top">
                          <strong>
                            Attempt {att.attemptNumber ?? attempts.length - idx}
                          </strong>
                          <span
                            className={`pg-tag ${att.isCorrect ? "ok" : "no"}`}
                          >
                            {att.isCorrect
                              ? `Solved +${att.pointsAwarded ?? 0}`
                              : "Incorrect"}
                          </span>
                        </div>
                        {att.submittedAnswer && (
                          <code title={String(att.submittedAnswer)}>
                            {String(att.submittedAnswer)}
                          </code>
                        )}
                        <div className="pg-att-foot">
                          <span>{att.submittedByEmail}</span>
                          <span>{formatTime(att.submittedAt)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default PuzzleGamePage;

/* ============================================================================
   STYLES (scoped to .pg-*)
   ============================================================================ */

const STYLES = `
.pg{--ink:#070d1a;--panel:#0d1627;--panel2:#111c31;--line:#1d2a44;--line2:#2a3b5e;--text:#e6edf8;--mute:#8b9bb8;--dim:#5d6f91;--sky:#38bdf8;--green:#34d399;--amber:#fbbf24;--red:#f87171;
color:var(--text);max-width:1240px;margin:0 auto;padding-bottom:56px;font-variant-numeric:tabular-nums}
.pg *{box-sizing:border-box}.pg h1,.pg h2,.pg h3,.pg p{margin:0}
.pg-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:50vh;text-align:center;color:var(--mute)}
.pg-center h2{color:var(--text);font-size:20px}.pg-bad{color:var(--red)}.pg-gold{color:var(--amber)}.pg-warn{color:var(--amber)}
.pg-spin{animation:pg-spin 1s linear infinite}
.pg-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;margin-bottom:14px}
.pg-head h1{font-size:28px;font-weight:800;letter-spacing:-.02em}
.pg-head p{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:13.5px;color:#cbd5e1;font-weight:600}
.pg-code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--amber);background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);padding:1px 8px;border-radius:999px}
.pg-dim{color:var(--dim);font-weight:500}
.pg-stats{display:flex;gap:10px}.pg-stats.center{justify-content:center;margin:20px 0}
.pg-stat{min-width:98px;padding:10px 16px;border-radius:12px;background:var(--panel);border:1px solid var(--line);text-align:center}
.pg-stat strong{display:block;font-size:22px;font-weight:800;color:var(--sky);letter-spacing:-.01em}
.pg-stat span{font-size:12px;color:var(--mute)}
.pg-stat.time strong{font-family:ui-monospace,Menlo,monospace}
.pg-stat.warn{border-color:rgba(251,191,36,.5)}.pg-stat.warn strong{color:var(--amber)}
.pg-stat.danger{border-color:rgba(248,113,113,.6);animation:pg-pulse 1s ease-in-out infinite}.pg-stat.danger strong{color:var(--red)}
.pg-role{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:12px;margin-bottom:14px;font-size:13px;line-height:1.45;border:1px solid}
.pg-role span{flex:1}.pg-role b{color:#fff}
.pg-role.leader{background:rgba(52,211,153,.07);border-color:rgba(52,211,153,.3);color:#a7f3d0}.pg-role.leader svg{color:var(--green);flex:none}
.pg-role.member{background:rgba(56,189,248,.07);border-color:rgba(56,189,248,.3);color:#bae6fd}.pg-role.member svg{color:var(--sky);flex:none}
.pg-alert{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;margin-bottom:14px;font-size:13px;border:1px solid}
.pg-alert span{flex:1}.pg-alert button{background:none;border:0;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-decoration:underline}
.pg-alert.bad{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.35);color:#fecaca}
.pg-alert.warn{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.35);color:#fde68a}
.pg-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
.pg-muted{color:var(--mute);line-height:1.55}.pg-muted.sm{font-size:12px}
.pg-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:13.5px;font-weight:700;padding:10px 18px;border-radius:11px;border:1px solid transparent;cursor:pointer;transition:background .15s,border-color .15s,transform .05s;white-space:nowrap}
.pg-btn:active:not(:disabled){transform:translateY(1px)}.pg-btn:disabled{opacity:.45;cursor:not-allowed}
.pg-btn.sm{padding:6px 11px;font-size:12px;border-radius:9px}.pg-btn.lg{padding:13px 30px;font-size:15px}
.pg-btn.primary{background:#0ea5e9;color:#02131f}.pg-btn.primary:hover:not(:disabled){background:#38bdf8}
.pg-btn.ghost{background:transparent;color:var(--text);border-color:var(--line2)}.pg-btn.ghost:hover:not(:disabled){background:var(--panel2);border-color:var(--sky)}
.pg :focus-visible{outline:2px solid var(--sky);outline-offset:2px}
.pg-ready,.pg-end{text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;padding:40px 24px}
.pg-ready h2,.pg-end h2{font-size:24px;font-weight:800;letter-spacing:-.01em}
.pg-ready .pg-muted,.pg-end .pg-muted{max-width:520px}
.pg-mini{display:grid;grid-template-columns:repeat(3,26px);gap:5px;margin-bottom:6px}
.pg-mini i{width:26px;height:26px;border-radius:6px;background:var(--line2);animation:pg-tile 1.6s ease-out both}
.pg-mini i:nth-child(5){background:var(--sky)}.pg-mini i:nth-child(3),.pg-mini i:nth-child(7){background:#1e4a73}
.pg-rules{list-style:none;margin:6px 0 10px;padding:0;display:flex;flex-direction:column;gap:6px;text-align:left;font-size:13px;color:var(--mute)}
.pg-rules li:before{content:"";display:inline-block;width:6px;height:6px;border-radius:2px;background:var(--sky);margin-right:10px;vertical-align:middle}
.pg-wait{display:inline-flex;align-items:center;gap:10px;padding:12px 18px;border-radius:12px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);color:#fde68a;font-size:13px}
.pg-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
.pg-col{display:flex;flex-direction:column;gap:18px;min-width:0}
.pg-board-card{display:flex;flex-direction:column;gap:18px;position:relative;overflow:hidden}
.pg-clock{position:absolute;left:0;right:0;top:0;height:4px;background:var(--line)}
.pg-clock i{display:block;height:100%;background:var(--sky);transition:width .5s linear}
.pg-clock.warn i{background:var(--amber)}.pg-clock.danger i{background:var(--red)}
.pg-steps{list-style:none;margin:6px 0 0;padding:0;display:flex;gap:5px}
.pg-steps li{flex:1;height:8px;border-radius:4px;background:var(--line);min-width:6px}
.pg-steps li.done{background:#0369a1}.pg-steps li.now{background:var(--sky);box-shadow:0 0 0 2px rgba(56,189,248,.25)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.pg-puzzle-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
.pg-puzzle-head h2{font-size:20px;font-weight:800;letter-spacing:-.01em}.pg-puzzle-head p{font-size:13px;color:var(--mute);margin-top:4px;line-height:1.5}
.pg-pills{display:flex;gap:8px;flex-wrap:wrap}
.pg-pill{font-size:12px;font-weight:600;padding:4px 11px;border-radius:999px;background:var(--panel2);border:1px solid var(--line2);color:var(--mute)}
.pg-pill.hi{color:var(--sky);border-color:rgba(56,189,248,.4);background:rgba(56,189,248,.08)}
.pg-board-wrap{position:relative;width:100%;max-width:520px;margin:0 auto}
.pg-board-wrap.shake{animation:pg-shake .45s}
.pg-board{display:grid;gap:6px;padding:12px;border-radius:16px;background:var(--ink);border:1px solid var(--line2)}
.pg-slot{position:relative;aspect-ratio:1;padding:0;border-radius:9px;border:1.5px dashed var(--line2);background:rgba(29,42,68,.35);color:var(--dim);font:inherit;font-size:13px;font-weight:700;cursor:pointer;overflow:hidden;transition:border-color .12s,box-shadow .12s,transform .12s}
.pg-slot:disabled{cursor:default}
.pg-slot.filled{border:1.5px solid #0369a1;background:var(--panel2);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.pg-slot.target:not(:disabled):hover{border-color:var(--sky);box-shadow:0 0 0 3px rgba(56,189,248,.22)}
.pg-slot.held{border-color:var(--amber);box-shadow:0 0 0 3px rgba(251,191,36,.35);transform:scale(.96)}
.pg-slot img,.pg-tile img{display:block;width:100%;height:100%;object-fit:cover;pointer-events:none}
.pg-flash{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:16px;background:rgba(6,78,59,.9);color:#d1fae5;animation:pg-pop .3s ease-out}
.pg-flash strong{font-size:26px;font-weight:800}.pg-flash span{font-size:15px;font-weight:600}.pg-flash svg{color:var(--green)}
.pg-checking{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:16px;background:rgba(7,13,26,.6);font-weight:600;font-size:14px}
.pg-tray{padding:16px;border-radius:14px;background:var(--panel2);border:1px solid var(--line)}
.pg-tray.drop{border-color:var(--sky);box-shadow:0 0 0 3px rgba(56,189,248,.18)}
.pg-tray-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;font-size:12.5px}.pg-tray-head strong{font-size:13.5px}.pg-tray-head span{color:var(--mute)}
.pg-tray-tiles{display:flex;flex-wrap:wrap;gap:8px;min-height:64px;align-items:center}
.pg-tile{width:64px;height:64px;padding:0;border-radius:10px;border:1.5px solid #0369a1;overflow:hidden;background:var(--ink);cursor:pointer;flex:none;transition:transform .12s,box-shadow .12s}
.pg-tile:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 14px rgba(0,0,0,.4)}
.pg-tile.held{border-color:var(--amber);box-shadow:0 0 0 3px rgba(251,191,36,.4);transform:translateY(-3px)}
.pg-tile:disabled{cursor:not-allowed;opacity:.65}
.pg-hint p{display:flex;gap:8px;align-items:flex-start;padding:11px 14px;border-radius:12px;background:rgba(56,189,248,.07);border:1px solid rgba(56,189,248,.25);color:#bae6fd;font-size:13px;line-height:1.5}
.pg-hint svg{flex:none;margin-top:2px;color:var(--sky)}
.pg-feedback{display:flex;gap:10px;align-items:center;padding:11px 14px;border-radius:12px;font-size:13px;font-weight:600;border:1px solid}
.pg-feedback.ok{background:rgba(52,211,153,.08);border-color:rgba(52,211,153,.4);color:#a7f3d0}
.pg-feedback.no{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.4);color:#fecaca}
.pg-controls{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--line)}
.pg-toggle{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--mute);cursor:pointer}.pg-toggle input{accent-color:#0ea5e9;width:16px;height:16px}
.pg-control-btns{display:flex;gap:10px;flex-wrap:wrap}
.pg-attempts h3{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;margin-bottom:4px}.pg-attempts h3 svg{color:var(--sky)}
.pg-attempts ul{list-style:none;margin:14px 0 0;padding:0 4px 0 0;display:flex;flex-direction:column;gap:10px;max-height:560px;overflow-y:auto}
.pg-attempts li{padding:12px;border-radius:12px;border:1px solid;display:flex;flex-direction:column;gap:6px}
.pg-attempts li.ok{background:rgba(52,211,153,.06);border-color:rgba(52,211,153,.3)}.pg-attempts li.no{background:rgba(248,113,113,.06);border-color:rgba(248,113,113,.3)}
.pg-att-top,.pg-att-foot{display:flex;justify-content:space-between;gap:8px;align-items:center}
.pg-att-top strong{font-size:13px}.pg-att-foot{font-size:11px;color:var(--dim)}.pg-att-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-attempts code{font-size:11px;color:var(--amber);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.pg-tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}.pg-tag.ok{background:rgba(52,211,153,.18);color:#6ee7b7}.pg-tag.no{background:rgba(248,113,113,.18);color:#fca5a5}
.pg-none{text-align:center;color:var(--dim);font-size:13px;padding:28px 0}
@keyframes pg-spin{to{transform:rotate(360deg)}}
@keyframes pg-pulse{50%{opacity:.6}}
@keyframes pg-shake{20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
@keyframes pg-pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
@keyframes pg-tile{from{opacity:0;transform:scale(.4) rotate(-12deg)}to{opacity:1;transform:none}}
@media (max-width:980px){.pg-layout{grid-template-columns:1fr}.pg-attempts ul{max-height:340px}}
@media (max-width:560px){.pg-head h1{font-size:22px}.pg-stat{min-width:0;flex:1;padding:8px 10px}.pg-stats{width:100%}.pg-card{padding:16px}.pg-tile{width:56px;height:56px}.pg-control-btns{width:100%}.pg-control-btns .pg-btn{flex:1}}
@media (prefers-reduced-motion:reduce){.pg *{animation:none!important;transition:none!important}}
`;
