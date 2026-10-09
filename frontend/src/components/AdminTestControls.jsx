import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Notice } from "./ui";
import { request } from "../services/api";
import { subscribeArena } from "../services/realtime";

export function AdminTestControls({ game }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState(null);
  const apply = useCallback(
    (next) =>
      setState((previous) =>
        previous?.sessionId === next.sessionId &&
        previous.revision > next.revision
          ? previous
          : next,
      ),
    [],
  );
  useEffect(() => {
    if (game !== "calculator") return;
    let alive = true;
    const refresh = () =>
      request("/games/calculator/sync", { method: "POST" })
        .then((data) => {
          if (alive) {
            apply(data);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    refresh();
    const disconnect = subscribeArena(
      "calculator",
      (data) => {
        if (alive) {
          apply(data);
          setError("");
        }
      },
      (error) => {
        if (alive && error.status !== 409) setError(error.message);
      },
    );
    return () => {
      alive = false;
      disconnect();
    };
  }, [game, apply]);
  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const event = (body) =>
    act(async () => {
      apply(
        await request("/games/calculator/event", {
          method: "POST",
          body: { ...body, sessionId: state?.sessionId },
        }),
      );
    });
  return (
    <details className="admin-test-panel arena-practice">
      <summary>
        Practice controls <span>Untimed practice; scores excluded</span>
      </summary>
      <div className="table-toolbar">
        <div>
          <strong>Admin test mode</strong>
          <p>
            Unlimited practice with no answer deadline. Scores do not enter the
            leaderboard or team results.
          </p>
        </div>
        <div className="actions">
          <Link className="button secondary" to={`/admin/games/${game}`}>
            Back to game settings
          </Link>
          <Button
            busy={busy}
            onClick={() =>
              act(async () => {
                await request(`/admin/games/${game}/test/reset`, {
                  method: "POST",
                });
                await request(`/games/${game}/start`, { method: "POST" });
                window.location.reload();
              })
            }
          >
            New test attempt
          </Button>
        </div>
      </div>
      <Notice error>{error}</Notice>
      {game === "calculator" && state && (
        <div className="test-calculator-controls">
          <p>
            Test all three players here, or use the camera below. Current role:{" "}
            <b>{state.you.role}</b> · {state.phase} · {state.score} points
          </p>
          <div className="actions">
            {["X", "Y", "Z"].map((role) => (
              <Button
                key={role}
                busy={busy}
                className={state.you.role === role ? "" : "secondary"}
                aria-pressed={state.you.role === role}
                onClick={() => event({ type: "role", role })}
              >
                Player {role}
              </Button>
            ))}
            <Button
              busy={busy}
              disabled={state.phase !== "ASSIGN"}
              onClick={() => event({ type: "start" })}
            >
              Start practice
            </Button>
          </div>
          <div className="test-digit-controls">
            {Array.from({ length: 10 }, (_, digit) => (
              <Button
                key={digit}
                busy={busy}
                disabled={state.phase !== "PLAYING"}
                onClick={() =>
                  event({
                    type: "digit",
                    digit,
                    conf: 1,
                    questionId: state.question?.question_id,
                  })
                }
              >
                {digit}
              </Button>
            ))}
            <Button
              className="secondary"
              busy={busy}
              disabled={state.phase !== "PLAYING"}
              onClick={() =>
                event({
                  type: "digit",
                  digit: null,
                  conf: 1,
                  questionId: state.question?.question_id,
                })
              }
            >
              Clear digit
            </Button>
          </div>
        </div>
      )}
    </details>
  );
}
