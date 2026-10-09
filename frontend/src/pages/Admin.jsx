import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Download,
  Plus,
  Settings,
  Users,
  Trophy,
  Gamepad2,
} from "lucide-react";
import { Shell } from "../components/Shell";
import {
  Card,
  Field,
  Button,
  Notice,
  Loading,
  Empty,
  Badge,
  Pager,
  ConfirmDialog,
  useResource,
} from "../components/ui";
import { request } from "../services/api";
import { catalog } from "./Home";
import { PuzzleUpload } from "../components/PuzzleUpload";
import { GameSettingsEditor } from "../components/GameSettingsEditor";
import { ContentEditor } from "../components/ContentEditor";
import { TeamEditor } from "../components/TeamEditor";
export function AdminDashboard() {
  const r = useResource(() => request("/admin/dashboard"));
  const d = r.data;
  return (
    <Shell
      admin
      title="Event overview"
      subtitle="The competition, at a glance."
    >
      <Notice error>{r.error}</Notice>
      {r.loading ? (
        <Loading />
      ) : d ? (
        <>
          <div className="stats-grid">
            {[
              ["Students", d.students, Users],
              ["Teams", d.teams, Users],
              ["Active teams", d.activeTeams, Users],
              ["Submissions", d.submissions, Gamepad2],
              ["Average raw score", d.average.toFixed(1), Trophy],
              ["Highest raw score", d.highest, Trophy],
            ].map(([k, v, Icon]) => (
              <Card key={k}>
                <Icon className="muted" size={20} />
                <small>{k}</small>
                <strong className="stat-value">{v}</strong>
              </Card>
            ))}
          </div>
          <Card>
            <h2>Game participation</h2>
            <p>Completed attempts and total attempts across the arena.</p>
            {catalog.map((g) => {
              const stat = d.participation.find((p) => p._id === g.id) || {
                attempts: 0,
                completed: 0,
              };
              return (
                <div className="participation" key={g.id}>
                  <span>
                    <g.icon size={18} />
                    {g.name}
                  </span>
                  <progress
                    max={Math.max(1, stat.attempts)}
                    value={stat.completed}
                    aria-label={`${g.name} completed attempts`}
                  />
                  <strong>
                    {stat.completed} / {stat.attempts}
                  </strong>
                </div>
              );
            })}
          </Card>
        </>
      ) : (
        <Empty>Event overview is unavailable. Please try again.</Empty>
      )}
    </Shell>
  );
}
export function AdminRecords({ entity, embedded = false, onChange }) {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [edit, setEdit] = useState(null),
    [remove, setRemove] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const r = useResource(
    () =>
      request(
        `/admin/${entity}?page=${page}&search=${encodeURIComponent(search)}`,
      ),
    [entity, page, search],
  );
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const f = new FormData(e.currentTarget);
      let body;
      if (entity === "students")
        body = {
          name: f.get("name"),
          rollNo: f.get("rollNo"),
          phoneNo: f.get("phoneNo"),
          ...(f.get("email") ? { email: f.get("email") } : {}),
          ...(edit._id ? { status: f.get("status") } : {}),
        };
      else
        body = {
          name: f.get("name"),
          status: f.get("status"),
          leaderId: f.get("leaderId"),
          memberIds: f
            .get("memberIds")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          regenerateCode: f.get("regenerateCode") === "on",
        };
      await request(`/admin/${entity}${edit._id ? "/" + edit._id : ""}`, {
        method: edit._id ? "PATCH" : "POST",
        body,
      });
      setEdit(null);
      r.reload();
      setMessage("Changes saved.");
      onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await request(`/admin/${entity}/${remove._id}`, {
        method: "DELETE",
        body: { confirm: true },
      });
      setRemove(null);
      r.reload();
      setMessage("Record removed from active use. Audit history retained.");
      onChange?.();
    } catch (e) {
      setError(e.message);
      setRemove(null);
    } finally {
      setBusy(false);
    }
  };
  const Wrapper = embedded ? React.Fragment : Shell;
  return (
    <Wrapper
      {...(embedded
        ? {}
        : {
            admin: true,
            title: entity === "students" ? "Member details" : "Team management",
            subtitle: "Manage registrations and competition access.",
          })}
    >
      {embedded && (
        <div className="section-heading">
          <h2>
            {entity === "students" ? "Member details" : "Team management"}
          </h2>
          <span>
            {entity === "students"
              ? "Deleting a member also removes them from the roster."
              : "Team names are fixed after registration."}
          </span>
        </div>
      )}
      <Notice error>{error || r.error}</Notice>
      <Notice>{message}</Notice>
      <Card>
        <div className="table-toolbar">
          <input
            aria-label="Search records"
            placeholder="Search name, roll, phone or team code…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <div className="actions">
            <a
              className="button secondary"
              href={`/api/admin/export/${entity}?page=${page}&search=${encodeURIComponent(search)}`}
            >
              <Download size={16} /> Export page
            </a>
            {entity === "students" && (
              <Button onClick={() => setEdit({})}>
                <Plus size={16} /> Add member
              </Button>
            )}
          </div>
        </div>
        {r.loading ? (
          <Loading />
        ) : !r.data?.rows.length ? (
          <Empty>No {entity} found.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {(entity === "students"
                    ? [
                        "Student",
                        "Roll number",
                        "Phone",
                        "Team",
                        "Status",
                        "Actions",
                      ]
                    : ["Team", "Code", "Members", "Leader", "Status", "Actions"]
                  ).map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((row) => (
                  <tr key={row._id}>
                    <td>
                      <strong>{row.name}</strong>
                      <small>
                        {entity === "students" ? row.role : "Team registration"}
                      </small>
                    </td>
                    <td>{row.rollNo || row.code}</td>
                    <td>{row.phoneNo || row.memberIds?.length}</td>
                    <td>
                      {entity === "students"
                        ? row.teamName || "No team"
                        : row.leaderName || "Team leader"}
                    </td>
                    <td>
                      <Badge>{row.status}</Badge>
                    </td>
                    <td>
                      <div className="actions">
                        <Button
                          className="secondary small"
                          onClick={() => setEdit(row)}
                        >
                          Edit
                        </Button>
                        <Button
                          className="danger small"
                          onClick={() => setRemove(row)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={r.data?.total || 0} onPage={setPage} />
      </Card>
      {edit && entity === "teams" && (
        <Card>
          <TeamEditor
            key={edit._id}
            value={edit}
            busy={busy}
            onClose={() => setEdit(null)}
            onSave={async (body) => {
              setBusy(true);
              setError("");
              try {
                await request("/admin/teams/" + edit._id, {
                  method: "PATCH",
                  body,
                });
                setEdit(null);
                r.reload();
                setMessage("Team updated.");
                onChange?.();
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        </Card>
      )}
      {edit && entity === "students" && (
        <Card>
          <div className="table-toolbar">
            <h2>{edit._id ? "Edit record" : "Add student"}</h2>
            <Button className="secondary" onClick={() => setEdit(null)}>
              Close
            </Button>
          </div>
          <form key={edit._id || "new"} onSubmit={save}>
            <Field
              label="Name"
              name="name"
              defaultValue={edit.name}
              required
              minLength={2}
              maxLength={60}
            />
            {entity === "students" ? (
              <>
                <Field
                  label="Roll number"
                  name="rollNo"
                  defaultValue={edit.rollNo}
                  required
                  maxLength={30}
                />
                <Field
                  label="Phone number"
                  name="phoneNo"
                  type="tel"
                  defaultValue={edit.phoneNo}
                  required
                  pattern="[6-9][0-9]{9}"
                />
                <Field
                  label="Email"
                  name="email"
                  type="email"
                  defaultValue={edit.email}
                  required
                />
              </>
            ) : (
              <>
                <Field
                  label="Member IDs (comma separated)"
                  name="memberIds"
                  defaultValue={edit.memberIds.join(", ")}
                  required
                />
                <Field
                  label="Leader user ID"
                  name="leaderId"
                  defaultValue={edit.leaderId}
                  required
                />
                <label className="check">
                  <input type="checkbox" name="regenerateCode" /> Regenerate
                  invitation code
                </label>
                <p className="muted">
                  Student IDs are shown in the directory editor. Members must be
                  active and free of another team.
                </p>
              </>
            )}
            {edit._id && (
              <>
                <p className="muted">
                  Record ID: <code>{edit._id}</code>
                </p>
                <label className="field">
                  Status <span className="required-mark">*</span>
                  <select required name="status" defaultValue={edit.status}>
                    <option>ACTIVE</option>
                    <option>INACTIVE</option>
                  </select>
                </label>
              </>
            )}
            <Button busy={busy}>Save changes</Button>
          </form>
        </Card>
      )}
      {remove && (
        <ConfirmDialog
          title={`Delete ${remove.name}?`}
          onConfirm={del}
          onClose={() => setRemove(null)}
          busy={busy}
        >
          The record will leave active competition. Historical results and audit
          records will be retained.
        </ConfirmDialog>
      )}
    </Wrapper>
  );
}
export function AdminGame() {
  const { gameId } = useParams(),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [edit, setEdit] = useState(null),
    [remove, setRemove] = useState(null);
  const r = useResource(
    () =>
      request(`/admin/games/${gameId}?page=${page}`).then((data) => ({
        ...data,
        gameId,
      })),
    [gameId, page],
  );
  useEffect(() => {
    setPage(1);
    setEdit(null);
    setRemove(null);
    setError("");
    setMessage("");
  }, [gameId]);
  const act = async (path, method, body) => {
    setBusy(true);
    setError("");
    try {
      await request(path, { method, body });
      r.reload();
      setMessage("Saved and recorded in the audit log.");
      setEdit(null);
      setRemove(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const d = r.data?.gameId === gameId ? r.data : null;
  return (
    <Shell
      admin
      title={catalog.find((g) => g.id === gameId)?.name || "Game management"}
      subtitle="Game-specific configuration, content and attempt controls."
    >
      <Notice error>{error || r.error}</Notice>
      <Notice>{message}</Notice>
      <div className="admin-game-intro table-toolbar">
        <p>
          Fields marked <span className="required-mark">*</span> are mandatory.
          Save your changes before testing.
        </p>
        {catalog.some((g) => g.id === gameId) && (
          <Link className="button" to={`/games/${gameId}`}>
            Play game in test mode
          </Link>
        )}
      </div>
      {r.loading ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="stats-grid">
              {[
                ["Attempts", d.sessions.total],
                ["Completed", d.stats.completed || 0],
                ["Average score", (d.stats.average || 0).toFixed(1)],
                ["Highest", d.stats.highest || 0],
                ["Lowest", d.stats.lowest || 0],
                ["Average time", Math.round(d.stats.averageTime || 0) + "s"],
              ].map(([k, v]) => (
                <Card key={k}>
                  <small>{k}</small>
                  <strong className="stat-value">{v}</strong>
                </Card>
              ))}
            </div>
            <div className="two-columns">
              <Card>
                <h2>
                  <Settings size={18} /> Game settings
                </h2>
                <p>
                  {gameId === "calculator"
                    ? "Question difficulty sequence, level timers, base points, speed bonus and gesture lock."
                    : gameId === "memory"
                      ? "Number count, display interval and answering interval for each of the three stages."
                      : "Game duration, attempts, availability window and global score weight."}
                </p>
                <GameSettingsEditor
                  key={gameId + JSON.stringify(d.settings)}
                  value={d.settings}
                  busy={busy}
                  onSave={(body) =>
                    act(`/admin/games/${gameId}/settings`, "PATCH", body)
                  }
                />
              </Card>
              <Card>
                <h2>Attempt register</h2>
                <p>
                  Answers are scored automatically. Reset clears all attempts
                  and scores for this team round and grants a retry; Memory
                  resets only that participant. Use Reset team round to clear
                  every teammate's Memory attempt. Later dependent rounds stay
                  locked until prerequisites are completed again.
                </p>
                <div className="attempt-list">
                  {d.sessions.rows.length ? (
                    d.sessions.rows.map((s) => (
                      <div key={s._id}>
                        <strong>
                          Attempt {s.attempt} · {s.score} points
                        </strong>
                        <small>{s.teamName || "Deleted team"}</small>
                        {s.userId && (
                          <small>{s.userName || "Deleted participant"}</small>
                        )}
                        <Badge>{s.status}</Badge>
                        <Button
                          className="secondary small"
                          busy={busy}
                          onClick={() => {
                            const reason = window.prompt(
                              "Reason for resetting this attempt (at least 5 characters)",
                            );
                            if (reason)
                              act(
                                `/admin/games/${gameId}/sessions/${s._id}/reset`,
                                "POST",
                                { reason },
                              );
                          }}
                        >
                          Reset {gameId === "memory" ? "participant" : "team"}{" "}
                          attempt
                        </Button>
                        {gameId === "memory" && (
                          <Button
                            className="secondary small"
                            busy={busy}
                            onClick={() => {
                              const reason = window.prompt(
                                "Reason for resetting Memory for the whole team (at least 5 characters)",
                              );
                              if (reason)
                                act(
                                  `/admin/games/memory/sessions/${s._id}/reset`,
                                  "POST",
                                  { reason, scope: "team" },
                                );
                            }}
                          >
                            Reset team round
                          </Button>
                        )}
                      </div>
                    ))
                  ) : (
                    <Empty>No attempts yet.</Empty>
                  )}
                </div>
                <Pager page={page} total={d.sessions.total} onPage={setPage} />
              </Card>
            </div>
            {["puzzle", "detective"].includes(gameId) && (
              <Card>
                <div className="table-toolbar">
                  <h2>
                    {gameId === "puzzle"
                      ? "Puzzle library"
                      : "Cases, questions, clues and hints"}
                  </h2>
                  <Button
                    onClick={() =>
                      gameId === "puzzle"
                        ? document
                            .getElementById("puzzle-upload")
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            })
                        : setEdit({
                            title: "",
                            published: true,
                            order: 0,
                            data:
                              gameId === "puzzle"
                                ? {
                                    description: "",
                                    imageUrl: "",
                                    gridRows: 3,
                                    gridCols: 3,
                                    points: 100,
                                    timeLimitSeconds: 300,
                                    hint: "",
                                    pieces: [],
                                    correctOrder: [],
                                  }
                                : {
                                    description: "",
                                    difficulty: "Medium",
                                    suspects: [],
                                    clues: [],
                                    questions: [],
                                    hints: [],
                                  },
                          })
                    }
                  >
                    {gameId === "puzzle" ? "Upload new puzzle" : "Add case"}
                  </Button>
                </div>
                <p>
                  {gameId === "detective"
                    ? "Valid cases publish automatically when saved."
                    : "Edit and publish event content."}{" "}
                  Started attempts retain a stable snapshot of their original
                  questions and configuration.
                </p>
                {d.content.map((c) => (
                  <div className="content-row" key={c._id}>
                    <div>
                      <strong>{c.title}</strong>
                      <Badge>{c.published ? "PUBLISHED" : "DRAFT"}</Badge>
                    </div>
                    <div className="actions">
                      <Button
                        className="secondary small"
                        onClick={() => setEdit(c)}
                      >
                        Edit
                      </Button>
                      <Button
                        className="danger small"
                        onClick={() => setRemove(c)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
                {!d.content.length && (
                  <Empty>
                    No content published. Add real event content to open this
                    game.
                  </Empty>
                )}
                {edit && (
                  <ContentEditor
                    key={edit._id || "new"}
                    game={gameId}
                    onClose={() => setEdit(null)}
                    value={{
                      title: edit.title,
                      published: edit.published,
                      order: edit.order,
                      data: edit.data,
                    }}
                    busy={busy}
                    onSave={(body) =>
                      act(
                        `/admin/games/${gameId}/content${edit._id ? "/" + edit._id : ""}`,
                        edit._id ? "PUT" : "POST",
                        body,
                      )
                    }
                  />
                )}
              </Card>
            )}
            {gameId === "puzzle" && (
              <PuzzleUpload
                onSave={() => {
                  r.reload();
                  setMessage(
                    "Puzzle image cropped and saved as a draft. Review and publish it.",
                  );
                }}
              />
            )}
            <AdminResults gameId={gameId} />
          </>
        )
      )}
      {remove && (
        <ConfirmDialog
          title="Delete game content?"
          onClose={() => setRemove(null)}
          busy={busy}
          onConfirm={() =>
            act(`/admin/games/${gameId}/content/${remove._id}`, "DELETE", {
              confirm: true,
            })
          }
        >
          Existing attempt snapshots will retain this content. New attempts will
          no longer use it.
        </ConfirmDialog>
      )}
    </Shell>
  );
}
export function AdminResults({ gameId }) {
  const [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const r = useResource(
    () =>
      request(
        `/admin/results?page=${page}${gameId ? "&gameId=" + gameId : ""}`,
      ),
    [gameId, page],
  );
  async function reset(row) {
    if (
      !window.confirm(
        `Reset ${row.gameId} for ${row.gameId === "memory" ? row.userName : row.teamName}? This removes this attempt's score and allows a retry.`,
      )
    )
      return;
    setError("");
    setBusy(true);
    try {
      await request(
        `/admin/games/${row.gameId}/sessions/${row.sessionId}/reset`,
        {
          method: "POST",
          body: { reason: "Administrator granted a retry from results" },
        },
      );
      r.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="table-toolbar">
        <h2>Automatic results</h2>
        <a
          className="button secondary"
          href={`/api/admin/export/results?page=${page}${gameId ? "&gameId=" + gameId : ""}`}
        >
          Export page
        </a>
      </div>
      <Notice error>{error || r.error}</Notice>
      {r.loading ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Game</th>
                <th>Team / user</th>
                <th>Score</th>
                <th>Time</th>
                <th>Scoring status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.rows.map((row) => (
                <tr key={row._id}>
                  <td>{row.gameId}</td>
                  <td>
                    <small>{row.teamName || "Deleted team"}</small>
                    {row.userId && (
                      <small>{row.userName || "Deleted participant"}</small>
                    )}
                  </td>
                  <td>
                    {row.score} / {row.maximum}
                  </td>
                  <td>{row.completionTime.toFixed(1)}s</td>
                  <td>
                    <Badge>
                      {row.valid ? "Automatically checked" : "Excluded"}
                    </Badge>
                  </td>
                  <td>
                    <div className="actions">
                      <Button
                        busy={busy}
                        disabled={!row.valid}
                        className="secondary small"
                        onClick={() => reset(row)}
                      >
                        Reset {row.gameId === "memory" ? "participant" : "team"}{" "}
                        attempt
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!r.data?.rows.length && <Empty>No submitted results.</Empty>}
        </div>
      )}
      <Pager page={page} total={r.data?.total || 0} onPage={setPage} />
    </Card>
  );
}
export function AdminSettings() {
  const r = useResource(() => request("/admin/settings")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <Shell
      admin
      title="Platform settings"
      subtitle="Competition-wide controls."
    >
      <Notice error>{error || r.error}</Notice>
      <Notice>{message}</Notice>
      <Card>
        <h2>Team capacity</h2>
        <p>
          Calculator always requires exactly three players. Other games support
          larger teams.
        </p>
        {r.loading ? (
          <Loading />
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const size = Number(new FormData(e.currentTarget).get("size"));
              setBusy(true);
              try {
                await request("/admin/settings", {
                  method: "PATCH",
                  body: { maxTeamSize: size },
                });
                r.reload();
                setMessage("Team capacity saved.");
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              label="Maximum team size"
              name="size"
              type="number"
              min={3}
              max={12}
              defaultValue={r.data?.maxTeamSize}
              required
            />
            <Button busy={busy}>Save settings</Button>
          </form>
        )}
      </Card>
    </Shell>
  );
}
export function AuditLogs() {
  const [page, setPage] = useState(1),
    r = useResource(() => request("/admin/audit-logs?page=" + page), [page]);
  return (
    <Shell
      admin
      title="Audit trail"
      subtitle="Every administrative change, with the record before and after."
    >
      <Notice error>{r.error}</Notice>
      <Card>
        {r.loading ? (
          <Loading />
        ) : r.data?.rows.length ? (
          r.data.rows.map((log) => (
            <details className="audit-row" key={log._id}>
              <summary>
                <strong>{log.action}</strong>
                <span>{new Date(log.timestamp).toLocaleString()}</span>
                <small>
                  {log.entityType} · {log.entityId}
                </small>
              </summary>
              <p>Administrator: {log.adminId}</p>
              <div className="two-columns">
                <pre>{JSON.stringify(log.oldValue, null, 2)}</pre>
                <pre>{JSON.stringify(log.newValue, null, 2)}</pre>
              </div>
            </details>
          ))
        ) : (
          <Empty>No administrative changes yet.</Empty>
        )}
        <Pager page={page} total={r.data?.total || 0} onPage={setPage} />
      </Card>
    </Shell>
  );
}
