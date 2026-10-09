import React, { useEffect, useState } from "react";
import { Trophy, Download } from "lucide-react";
import { Shell } from "../components/Shell";
import { useAuth } from "../components/Auth";
import {
  Card,
  Notice,
  Loading,
  Empty,
  Pager,
  Button,
  useResource,
} from "../components/ui";
import { request } from "../services/api";
import { catalog } from "./Home";
import { AdminResults, AdminRecords } from "./Admin";
export function Leaderboard({ admin = false }) {
  const { user } = useAuth(),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [filter, setFilter] = useState(""),
    [completed, setCompleted] = useState(false),
    [sort, setSort] = useState("score-desc"),
    [management, setManagement] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const path = `/admin/leaderboard?page=${page}&sort=${sort}&search=${encodeURIComponent(query)}${filter ? "&gameId=" + filter : ""}${completed ? "&completed=true" : ""}`,
    r = useResource(() => request(path), [path], { refreshMs: 30000 });
  const podium = useResource(() => request("/admin/leaderboard?limit=3"), [], {
    refreshMs: 30000,
  });
  const body = (
    <>
      <div className="podium">
        {podium.data?.rows.map((row, i) => (
          <Card key={row._id} className={"podium-card place-" + i}>
            <span className="medal">
              <Trophy size={i === 0 ? 32 : 25} />
            </span>
            <p>#{row.rank}</p>
            <h2>{row.name}</h2>
            <small>{row.code}</small>
            <strong>
              {row.total}
              <span> weighted points</span>
            </strong>
          </Card>
        ))}
      </div>
      <Card>
        <div className="table-toolbar">
          <div>
            <h2>Competition standings</h2>
            <p>
              Best valid attempts · score ties use average time, then completed
              rounds
            </p>
          </div>
          {admin && (
            <a
              className="button secondary"
              href={`/api/admin/export/leaderboard${path.slice(path.indexOf("?"))}`}
            >
              <Download size={16} /> Export page
            </a>
          )}
        </div>
        <div className="filters">
          <select
            aria-label="Sort standings"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            <option value="score-desc">
              Total score: High → Low · faster average breaks ties
            </option>
            <option value="score-asc">Total score: Low → High</option>
            <option value="time-asc">Average time: Fastest → Slowest</option>
            <option value="time-desc">Average time: Slowest → Fastest</option>
          </select>
          <input
            aria-label="Search team"
            placeholder="Search team name or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Game filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Global weighted ranking</option>
            {catalog.map((g) => (
              <option value={g.id} key={g.id}>
                {g.name} · raw score
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={completed}
              onChange={(e) => {
                setCompleted(e.target.checked);
                setPage(1);
              }}
            />{" "}
            All games completed
          </label>
        </div>
        <Notice error>{r.error}</Notice>
        {r.loading ? (
          <Loading />
        ) : !r.data?.rows.length ? (
          <Empty>No teams match these standings.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Team</th>
                  {catalog.map((g) => (
                    <th key={g.id}>{g.name}</th>
                  ))}
                  <th>{filter ? "Raw score" : "Weighted total"}</th>
                  <th>Progress</th>
                  <th>Average time</th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((row) => (
                  <tr
                    key={row._id}
                    className={user?.teamId === row._id ? "my-team" : ""}
                  >
                    <td>
                      <span className="rank">
                        {String(row.rank).padStart(2, "0")}
                      </span>
                    </td>
                    <td>
                      <strong>{row.name}</strong>
                      <small>{row.code}</small>
                    </td>
                    {catalog.map((g) => (
                      <td key={g.id}>{row.scores[g.id] ?? "—"}</td>
                    ))}
                    <td className="total">{row.total}</td>
                    <td>{row.completed}/4</td>
                    <td>
                      {row.averageTime === null
                        ? "—"
                        : `${row.averageTime.toFixed(1)} sec`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={r.data?.total || 0} onPage={setPage} />
      </Card>
      {admin && <AdminResults />}
      {admin && (
        <>
          <Card>
            <div className="table-toolbar">
              <div>
                <h2>Registration management</h2>
                <p>
                  Edit participant details, manage rosters or remove teams.
                  Registered team names stay fixed.
                </p>
              </div>
              <div className="actions">
                <Button
                  type="button"
                  className={management === "teams" ? "" : "secondary"}
                  onClick={() =>
                    setManagement(management === "teams" ? "" : "teams")
                  }
                >
                  Manage teams
                </Button>
                <Button
                  type="button"
                  className={management === "students" ? "" : "secondary"}
                  onClick={() =>
                    setManagement(management === "students" ? "" : "students")
                  }
                >
                  Manage members
                </Button>
              </div>
            </div>
          </Card>
          {management && (
            <AdminRecords
              key={management}
              entity={management}
              embedded
              onChange={() => {
                r.reload();
                podium.reload();
              }}
            />
          )}
        </>
      )}
      <p className="muted">
        Raw game scores retain their original rules. Global scores normalize
        each game’s maximum and apply organizer-defined weights.
      </p>
    </>
  );
  return (
    <Shell
      admin
      title="The leaderboard"
      subtitle="Every challenge counts. Every team has a place."
    >
      {body}
    </Shell>
  );
}
