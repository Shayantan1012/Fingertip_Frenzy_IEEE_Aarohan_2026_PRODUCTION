import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Copy, Users, Trophy, CheckCircle2 } from "lucide-react";
import { Shell } from "../components/Shell";
import { useAuth } from "../components/Auth";
import {
  Card,
  Button,
  Notice,
  Badge,
  Loading,
  Empty,
  useResource,
} from "../components/ui";
import { subscribeArena } from "../services/realtime";
import { request } from "../services/api";
import { catalog } from "./Home";
export function Dashboard({ gamesOnly = false }) {
  const { user } = useAuth();
  const [live, setLive] = useState(null),
    [liveError, setLiveError] = useState("");
  useEffect(
    () =>
      subscribeArena(
        "progress",
        (data) => {
          setLive(data);
          setLiveError("");
        },
        (error) => setLiveError(error.message),
      ),
    [],
  );
  const r = { data: live, error: liveError, loading: !live };
  return (
    <Shell
      title={
        gamesOnly
          ? "Choose your challenge"
          : `Welcome, ${user.name.split(" ")[0]}`
      }
      subtitle="Your next breakthrough starts here."
    >
      <Notice error>{r.error}</Notice>
      {r.loading ? (
        <Loading />
      ) : (
        <>
          <div className="dashboard-summary">
            <Card>
              <span className="stat-icon">
                <Users />
              </span>
              <small>YOUR TEAM</small>
              <h2>{r.data?.team?.name || "Find your people"}</h2>
              <p>
                {r.data?.team?.code ||
                  "Create a team or join with a team code."}
              </p>
              <Link to="/team">
                {r.data?.team ? "View your team" : "Set up your team"}{" "}
                <ArrowRight size={14} />
              </Link>
            </Card>
            <Card>
              <span className="stat-icon">
                <CheckCircle2 />
              </span>
              <small>YOUR PROGRESS</small>
              <h2>
                {r.data?.games.filter((g) => g.status === "COMPLETED").length ||
                  0}{" "}
                <span>/ 4</span>
              </h2>
              <p>Challenges completed</p>
            </Card>
            <Card>
              <span className="stat-icon">
                <Trophy />
              </span>
              <small>YOUR TEAM SCORE</small>
              <h2>Every round counts</h2>
              <p>View your team’s game scores and weighted total.</p>
              <Link to="/team">
                View team scores <ArrowRight size={14} />
              </Link>
            </Card>
          </div>
          {r.data?.team && <TeamScore liveScore={r.data.score} />}
          <div className="section-heading">
            <h2>The assessment arena</h2>
            <span>Four original experiences</span>
          </div>
          <div className="game-grid">
            {catalog.map((g, i) => {
              const state = r.data?.games.find((x) => x.id === g.id);
              return (
                <Card key={g.id} className={`game-card ${g.color}`}>
                  <div className="game-top">
                    <span className="game-icon">
                      <g.icon />
                    </span>
                    <span className="game-number">0{i + 1}</span>
                  </div>
                  <Badge>
                    {!state?.enabled
                      ? "DISABLED"
                      : !r.data?.team
                        ? "LOCKED"
                        : state.locked
                          ? "LOCKED"
                          : state.status}
                  </Badge>
                  <h3>{g.name}</h3>
                  <p>{g.description}</p>
                  <div className="game-meta">
                    <span>
                      Raw score <strong>{state?.score || 0}</strong>
                    </span>
                    <span>
                      Weight <strong>{state?.weight}%</strong>
                    </span>
                  </div>
                  {state?.available === false ? (
                    <>
                      <p className="round-lock">{state.unavailableReason}</p>
                      <Button disabled className="secondary">
                        Awaiting organizer
                      </Button>
                    </>
                  ) : state?.locked ? (
                    <>
                      <p className="round-lock">
                        Complete the previous round to unlock.
                      </p>
                      <Button disabled className="secondary">
                        Round locked
                      </Button>
                    </>
                  ) : (
                    <Link
                      className="button secondary"
                      to={!r.data?.team ? "/team" : `/games/${g.id}`}
                    >
                      {state?.status === "COMPLETED"
                        ? "View result"
                        : state?.status === "IN_PROGRESS"
                          ? "Continue"
                          : "Open challenge"}{" "}
                      <ArrowRight size={16} />
                    </Link>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </Shell>
  );
}
export function TeamPage() {
  const r = useResource(() => request("/teams/me")),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const team = r.data?.team;
  return (
    <Shell title="My team" subtitle="Good ideas get better together.">
      <Notice error>{error || r.error}</Notice>
      <Notice>{message}</Notice>
      {r.loading ? (
        <Loading />
      ) : team ? (
        <>
          <Card className="team-hero">
            <span className="game-icon">
              <Users />
            </span>
            <h2>{team.name}</h2>
            <Badge>{team.status}</Badge>
            <div className="team-code">
              <code>{team.code}</code>
              <Button
                className="icon"
                aria-label="Copy team code"
                onClick={() =>
                  navigator.clipboard
                    .writeText(team.code)
                    .then(() => setMessage("Team code copied."))
                    .catch(() =>
                      setError(
                        "Copy failed. Select and copy the code manually.",
                      ),
                    )
                }
              >
                <Copy size={17} />
              </Button>
            </div>
            <p>
              Share this code with your two teammates. They join through the
              login page using their own name, roll number, phone and email.
              Join before starting a game.
            </p>
          </Card>
          <Card>
            <h2>Team roster</h2>
            <div className="roster">
              {team.members.map((m) => (
                <div key={m._id}>
                  <span className="avatar">{m.name[0]}</span>
                  <div>
                    <strong>{m.name}</strong>
                    <small>{m.rollNo}</small>
                  </div>
                  <Badge>{m.role}</Badge>
                </div>
              ))}
            </div>
          </Card>
          <p className="muted">
            Your registered team name is fixed. Contact the administrator for
            member corrections.
          </p>
          <TeamScore />
        </>
      ) : (
        <Card>
          <h2>Team access unavailable</h2>
          <p>
            Register as a team leader, or log in with your leader's invitation
            code.
          </p>
          <Link className="button" to="/register">
            Leader registration
          </Link>
        </Card>
      )}
    </Shell>
  );
}
function TeamScore({ liveScore } = {}) {
  const r = useResource(() => request("/teams/me/score"));
  useEffect(() => {
    const id = setInterval(r.reload, 30000);
    return () => clearInterval(id);
  }, []);
  const row = liveScore || r.data?.score;
  return (
    <Card>
      <h2>Your team scores</h2>
      <Notice error>{r.error}</Notice>
      {r.loading && !row ? (
        <Loading />
      ) : row ? (
        <div className="score-strip">
          {catalog.map((g) => (
            <div key={g.id}>
              <small>{g.name}</small>
              <strong>{row.scores[g.id] || 0}</strong>
            </div>
          ))}
          <div>
            <small>Weighted total</small>
            <strong>{row.total}</strong>
          </div>
        </div>
      ) : (
        <Empty>No scores yet. Your first result will appear here.</Empty>
      )}
    </Card>
  );
}
export function Profile() {
  const { user } = useAuth(),
    r = useResource(() => request("/teams/me"));
  return (
    <Shell
      title="Your profile"
      subtitle="Your identity across the assessment arena."
    >
      <Notice error>{r.error}</Notice>
      <Card className="profile-card">
        <span className="avatar large">{user.name[0]}</span>
        <h2>{user.name}</h2>
        <Badge>{user.role}</Badge>
        <dl>
          {Object.entries({
            "Roll number": user.rollNo,
            "Phone number": user.phoneNo,
            Email: user.email || "Not provided",
            Team: r.loading
              ? "Loading team…"
              : r.error
                ? "Team unavailable"
                : r.data?.team?.name || "No team yet",
          }).map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      </Card>
    </Shell>
  );
}
