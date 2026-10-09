import React, { useState } from "react";
import { Field, Button, Notice } from "./ui";
const id = () => crypto.randomUUID();
export function ContentEditor({ value, game, busy, onSave, onClose }) {
  const [body, setBody] = useState({
    ...structuredClone(value),
    ...(game === "detective" ? { published: true } : {}),
  });
  const [error, setError] = useState("");
  const data = body.data;
  const change = (key, v) => setBody((b) => ({ ...b, [key]: v }));
  const set = (key, v) =>
    setBody((b) => ({ ...b, data: { ...b.data, [key]: v } }));
  const row = (list, index, key, v) =>
    set(
      list,
      data[list].map((x, i) => (i === index ? { ...x, [key]: v } : x)),
    );
  const remove = (list, index) =>
    setBody((b) => ({
      ...b,
      data: {
        ...b.data,
        [list]: b.data[list].filter((_, i) => i !== index),
        ...(list === "clues"
          ? {
              questions: b.data.questions.map((q) =>
                q.clueId === b.data.clues[index].id ? { ...q, clueId: "" } : q,
              ),
            }
          : {}),
        ...(list === "questions"
          ? {
              hints: b.data.hints.map((h) =>
                h.questionId === b.data.questions[index].id
                  ? { ...h, questionId: null }
                  : h,
              ),
            }
          : {}),
      },
    }));
  const add = (list, v) => set(list, [...data[list], v]);
  return (
    <div className="content-editor">
      <div className="table-toolbar">
        <h2>Edit {game === "puzzle" ? "puzzle" : "investigation"}</h2>
        <Button className="secondary" onClick={onClose}>
          Close editor
        </Button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (game === "detective") {
            if (!data.questions.length)
              return setError(
                "Add at least one question before saving the case.",
              );
            for (const [i, q] of data.questions.entries()) {
              if (!q.question.trim())
                return setError(`Question ${i + 1}: enter the question text.`);
              if (
                q.options.length < 2 ||
                q.options.length > 10 ||
                q.options.some((o) => !o.trim())
              )
                return setError(
                  `Question ${i + 1}: provide 2–10 non-empty answer options.`,
                );
              if (
                q.correctAnswerIndex < 0 ||
                q.correctAnswerIndex >= q.options.length
              )
                return setError(
                  `Question ${i + 1}: select a valid correct answer.`,
                );
            }
            onSave({
              ...body,
              data: {
                ...data,
                questions: data.questions.map((q) => ({
                  ...q,
                  question: q.question.trim(),
                  options: q.options.map((o) => o.trim()),
                })),
              },
            });
          } else if (!data.pieces.length) {
            setError(
              "Upload an image to generate the puzzle tiles before saving.",
            );
          } else onSave(body);
        }}
      >
        <p className="form-required-note">
          <span className="required-mark">*</span> Required field. Optional
          sections can be left empty.
        </p>
        <Notice error>{error}</Notice>
        <Field
          label="Title"
          value={body.title}
          onChange={(e) => change("title", e.target.value)}
          required
          minLength={2}
          maxLength={100}
        />
        {game === "puzzle" && (
          <label className="check">
            <input
              type="checkbox"
              checked={body.published}
              onChange={(e) => change("published", e.target.checked)}
            />{" "}
            Published and available for new attempts
          </label>
        )}
        <Field
          label="Display order"
          type="number"
          value={body.order}
          onChange={(e) => change("order", Number(e.target.value))}
          min={0}
          max={1000}
          required
        />
        <label className="field">
          Description
          <textarea
            value={data.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
          />
        </label>
        {game === "puzzle" ? (
          <>
            <div className="two-columns">
              <Field
                label="Points"
                type="number"
                value={data.points}
                onChange={(e) => set("points", Number(e.target.value))}
                min={0}
                max={10000}
                required
              />
              <Field
                label="Puzzle time metadata (seconds)"
                type="number"
                value={data.timeLimitSeconds}
                onChange={(e) =>
                  set("timeLimitSeconds", Number(e.target.value))
                }
                min={10}
                max={7200}
                required
              />
            </div>
            <Field
              label="Hint"
              value={data.hint}
              onChange={(e) => set("hint", e.target.value)}
            />
            {data.imageUrl ? (
              <img
                className="puzzle-preview"
                src={data.imageUrl}
                alt="Puzzle source"
              />
            ) : (
              <Notice error>
                Use the image upload form below to generate a complete puzzle.
                Manual content requires crop URLs and a valid piece order.
              </Notice>
            )}
            <div
              className="tile-preview"
              style={{ gridTemplateColumns: `repeat(${data.gridCols},1fr)` }}
            >
              {data.correctOrder.map((pieceId) => (
                <img
                  key={pieceId}
                  src={data.pieces.find((p) => p.pieceId === pieceId)?.imageUrl}
                  alt="Puzzle tile"
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <Field
              label="Difficulty label"
              value={data.difficulty}
              onChange={(e) => set("difficulty", e.target.value)}
              required
              maxLength={40}
            />
            <h3>Suspects</h3>
            {data.suspects.map((s, i) => (
              <fieldset key={i}>
                <legend>Suspect {i + 1}</legend>
                <Field
                  label="Name"
                  value={s.name}
                  onChange={(e) => row("suspects", i, "name", e.target.value)}
                />
                <Field
                  label="Role"
                  value={s.role}
                  onChange={(e) => row("suspects", i, "role", e.target.value)}
                />
                <Field
                  label="Statement"
                  value={s.statement}
                  onChange={(e) =>
                    row("suspects", i, "statement", e.target.value)
                  }
                />
                <Button
                  type="button"
                  className="secondary small"
                  onClick={() => remove("suspects", i)}
                >
                  Remove suspect
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              className="secondary small"
              onClick={() =>
                add("suspects", { name: "", role: "", statement: "" })
              }
            >
              Add suspect
            </Button>
            <h3>Evidence and clues</h3>
            {data.clues.map((c, i) => (
              <fieldset key={c.id}>
                <legend>Clue {i + 1}</legend>
                <Field
                  label="Clue title"
                  value={c.title}
                  onChange={(e) => row("clues", i, "title", e.target.value)}
                  required
                />
                <Field
                  label="Description"
                  value={c.description}
                  onChange={(e) =>
                    row("clues", i, "description", e.target.value)
                  }
                />
                <label className="field">
                  Evidence type
                  <select
                    value={c.evidenceType}
                    onChange={(e) =>
                      row("clues", i, "evidenceType", e.target.value)
                    }
                  >
                    <option value="text">Text</option>
                    <option value="document">Document / log</option>
                    <option value="image">Image URL</option>
                  </select>
                </label>
                <label className="field">
                  Evidence
                  <textarea
                    value={c.evidence}
                    onChange={(e) =>
                      row("clues", i, "evidence", e.target.value)
                    }
                    rows={3}
                  />
                </label>
                <Button
                  type="button"
                  className="secondary small"
                  onClick={() => remove("clues", i)}
                >
                  Remove clue
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              className="secondary small"
              onClick={() =>
                add("clues", {
                  id: id(),
                  title: "",
                  description: "",
                  evidence: "",
                  evidenceType: "text",
                })
              }
            >
              Add clue
            </Button>
            <h3>Questions</h3>
            {data.questions.map((q, i) => (
              <fieldset key={q.id}>
                <legend>Question {i + 1}</legend>
                <Field
                  label="Question"
                  value={q.question}
                  onChange={(e) =>
                    row("questions", i, "question", e.target.value)
                  }
                  required
                />
                <div className="question-options">
                  {q.options.map((option, optionIndex) => (
                    <div className="option-row" key={optionIndex}>
                      <Field
                        label={`Answer option ${optionIndex + 1}`}
                        value={option}
                        required
                        maxLength={400}
                        onChange={(e) =>
                          row(
                            "questions",
                            i,
                            "options",
                            q.options.map((o, j) =>
                              j === optionIndex ? e.target.value : o,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        className="secondary small"
                        disabled={q.options.length <= 2 || busy}
                        aria-label={`Remove option ${optionIndex + 1} from question ${i + 1}`}
                        onClick={() =>
                          setBody((b) => ({
                            ...b,
                            data: {
                              ...b.data,
                              questions: b.data.questions.map((question, j) =>
                                j !== i
                                  ? question
                                  : {
                                      ...question,
                                      options: question.options.filter(
                                        (_, k) => k !== optionIndex,
                                      ),
                                      correctAnswerIndex:
                                        question.correctAnswerIndex ===
                                        optionIndex
                                          ? 0
                                          : question.correctAnswerIndex >
                                              optionIndex
                                            ? question.correctAnswerIndex - 1
                                            : question.correctAnswerIndex,
                                    },
                              ),
                            },
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    className="secondary small"
                    disabled={q.options.length >= 10 || busy}
                    onClick={() =>
                      row("questions", i, "options", [...q.options, ""])
                    }
                  >
                    Add answer option
                  </Button>
                </div>
                <label className="field">
                  Correct answer <span className="required-mark">*</span>
                  <select
                    value={q.correctAnswerIndex}
                    required
                    onChange={(e) =>
                      row(
                        "questions",
                        i,
                        "correctAnswerIndex",
                        Number(e.target.value),
                      )
                    }
                  >
                    {q.options.map((option, index) => (
                      <option value={index} key={index}>
                        {index + 1}. {option || "Enter this option above"}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  label="Points"
                  type="number"
                  min={0}
                  max={10000}
                  value={q.points}
                  onChange={(e) =>
                    row("questions", i, "points", Number(e.target.value))
                  }
                  required
                />
                <Button
                  type="button"
                  className="secondary small"
                  onClick={() => remove("questions", i)}
                >
                  Remove question
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              className="secondary small"
              onClick={() =>
                add("questions", {
                  id: id(),
                  question: "",
                  options: ["", ""],
                  correctAnswerIndex: 0,
                  points: 100,
                })
              }
            >
              Add question
            </Button>
            <h3>Hints</h3>
            {data.hints.map((h, i) => (
              <fieldset key={h.id}>
                <legend>Hint {i + 1}</legend>
                <Field
                  label="Hint text"
                  value={h.hintText}
                  onChange={(e) => row("hints", i, "hintText", e.target.value)}
                  required
                />
                <Field
                  label="Point penalty"
                  type="number"
                  value={h.penalty}
                  onChange={(e) =>
                    row("hints", i, "penalty", Number(e.target.value))
                  }
                  min={0}
                  max={10000}
                  required
                />
                <label className="field">
                  Related question
                  <select
                    value={h.questionId || ""}
                    onChange={(e) =>
                      row("hints", i, "questionId", e.target.value || null)
                    }
                  >
                    <option value="">Whole investigation</option>
                    {data.questions.map((q, index) => (
                      <option value={q.id} key={q.id}>
                        Question {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={h.enabled}
                    onChange={(e) =>
                      row("hints", i, "enabled", e.target.checked)
                    }
                  />{" "}
                  Hint enabled
                </label>
                <Button
                  type="button"
                  className="secondary small"
                  onClick={() => remove("hints", i)}
                >
                  Remove hint
                </Button>
              </fieldset>
            ))}
            <Button
              type="button"
              className="secondary small"
              onClick={() =>
                add("hints", {
                  id: id(),
                  hintText: "",
                  penalty: 20,
                  enabled: true,
                  questionId: null,
                })
              }
            >
              Add hint
            </Button>
          </>
        )}
        <div className="actions content-save">
          <Button busy={busy}>
            Save {body.published ? "and publish" : "draft"}
          </Button>
        </div>
      </form>
    </div>
  );
}
