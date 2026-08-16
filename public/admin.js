// The instructor console: sign in, a course list with pending counts, a
// per-course review queue with in-place editing, and a settings tab.
(function () {
  "use strict";
  var el = SG.el;
  var api = SG.api;
  var clear = SG.clear;

  function renderAdmin(root) {
    clear(root);
    root.appendChild(el("p", { class: "loading", text: "Loading..." }));
    api
      .get("/api/me")
      .then(function (res) {
        clear(root);
        if (res.data && res.data.authenticated) renderConsole(root);
        else renderLogin(root);
      })
      .catch(function () {
        clear(root);
        renderLogin(root);
      });
  }
  SG.renderAdmin = renderAdmin;

  // --- Sign in ---

  function renderLogin(root) {
    clear(root);
    var error = el("div", { class: "login-error", role: "alert", hidden: true });
    var password = el("input", { type: "password", name: "password", autocomplete: "current-password" });
    var submit = el("button", { class: "submit", type: "submit", text: "Sign in" });

    var form = el(
      "form",
      {
        class: "login-form",
        onsubmit: async function (ev) {
          ev.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            var res = await api.send("POST", "/api/login", { password: password.value });
            if (res.status === 200) {
              renderConsole(root);
              return;
            }
            error.textContent =
              res.status === 429 ? "Too many attempts. Please wait and try again." : "Incorrect password.";
            error.hidden = false;
          } catch (e) {
            error.textContent = "Could not reach the server. Please try again.";
            error.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
      },
      [
        el("h1", { text: "Telos" }),
        el("p", {
          class: "login-tagline",
          text: "τέλος: the end toward which all effort aims",
        }),
        el("p", { class: "hint", text: "Instructor sign in" }),
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Password" }), password]),
        error,
        submit,
      ]
    );
    root.appendChild(form);
  }

  // --- Console shell ---

  function renderConsole(root) {
    clear(root);
    root.appendChild(
      el("header", { class: "admin-header" }, [
        el("h1", { class: "wordmark" }, [
          el("span", { class: "wordmark-name", text: "Telos" }),
          el("span", { class: "wordmark-greek", text: "τέλος" }),
        ]),
        el("div", { class: "admin-header-actions" }, [
          SG.theme.toggleButton(),
          el("button", {
            class: "logout no-print",
            type: "button",
            text: "Sign out",
            onclick: async function () {
              try {
                await api.send("POST", "/api/logout");
              } catch (e) {
                /* ignore */
              }
              renderAdmin(root);
            },
          }),
        ]),
      ])
    );
    var main = el("div", { class: "admin-main" });
    root.appendChild(main);
    showCourseList(main);
  }

  async function loadCourses() {
    var res = await api.get("/api/courses");
    return (res.data && res.data.courses) || [];
  }

  // --- Course list ---

  async function showCourseList(main) {
    clear(main);
    main.appendChild(el("p", { class: "loading", text: "Loading courses..." }));
    var courses = await loadCourses();
    clear(main);

    main.appendChild(el("h2", { text: "Courses" }));

    var list = el("div", { class: "course-list" });
    if (courses.length === 0) {
      list.appendChild(el("p", { class: "empty", text: "No courses yet. Create one below." }));
    }
    courses.forEach(function (c) {
      list.appendChild(
        el("div", { class: "course-row", "data-id": c.id }, [
          el("span", { class: "course-title", text: c.title }),
          el("span", { class: "pending-count", text: c.pending_count + " pending" }),
          c.archived ? el("span", { class: "badge archived", text: "archived" }) : null,
          el("button", {
            class: "open-course",
            type: "button",
            text: "Open",
            onclick: function () {
              showCourse(main, c.id);
            },
          }),
        ])
      );
    });
    main.appendChild(list);

    // New course form.
    var title = el("input", { type: "text", name: "title", maxlength: "200" });
    var topics = el("input", { type: "text", name: "topics", placeholder: "Comma separated, for example: Cells, Genetics" });
    var err = el("div", { class: "form-error", role: "alert", hidden: true });
    var form = el(
      "form",
      {
        class: "new-course-form",
        onsubmit: async function (ev) {
          ev.preventDefault();
          err.hidden = true;
          var body = {
            title: title.value,
            topics: topics.value
              .split(",")
              .map(function (t) {
                return t.trim();
              })
              .filter(Boolean),
          };
          var res = await api.send("POST", "/api/courses", body);
          if (res.status === 201) {
            showCourseList(main);
          } else {
            err.textContent = res.data && res.data.details ? res.data.details.join(" ") : "Could not create the course.";
            err.hidden = false;
          }
        },
      },
      [
        el("h3", { text: "New course" }),
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Title" }), title]),
        el("label", { class: "field" }, [el("span", { class: "field-label", text: "Topics" }), topics]),
        err,
        el("button", { class: "submit", type: "submit", text: "Create course" }),
      ]
    );
    main.appendChild(form);
  }

  // --- One course: queue and settings ---

  async function showCourse(main, id) {
    clear(main);
    main.appendChild(el("p", { class: "loading", text: "Loading course..." }));
    var courses = await loadCourses();
    var course = courses.find(function (c) {
      return c.id === id;
    });
    clear(main);
    if (!course) {
      showCourseList(main);
      return;
    }

    main.appendChild(
      el("div", { class: "course-bar" }, [
        el("button", {
          class: "back",
          type: "button",
          text: "Back to courses",
          onclick: function () {
            showCourseList(main);
          },
        }),
        el("h2", { class: "course-heading", text: course.title }),
      ])
    );

    var queuePanel = el("section", { class: "panel", id: "queue-panel" });
    var testPanel = el("section", { class: "panel test-builder", id: "test-panel", hidden: true });
    var settingsPanel = el("section", { class: "panel settings", id: "settings-panel", hidden: true });

    var tabs = [];
    function makeTab(label, panel) {
      var btn = el("button", {
        class: "tab",
        type: "button",
        text: label,
        onclick: function () {
          tabs.forEach(function (t) {
            t.panel.hidden = t.btn !== btn;
            t.btn.className = "tab" + (t.btn === btn ? " active" : "");
          });
        },
      });
      tabs.push({ btn: btn, panel: panel });
      return btn;
    }
    var tabQueue = makeTab("Queue", queuePanel);
    var tabTest = makeTab("Test builder", testPanel);
    var tabSettings = makeTab("Settings", settingsPanel);
    tabQueue.className = "tab active";

    main.appendChild(el("nav", { class: "tabs" }, [tabQueue, tabTest, tabSettings]));
    main.appendChild(queuePanel);
    main.appendChild(testPanel);
    main.appendChild(settingsPanel);

    renderSettings(settingsPanel, main, course);
    renderTestBuilder(testPanel, course);
    await renderQueue(queuePanel, course.id);
  }

  var STATUS_LABELS = { all: "All", pending: "Pending", released: "Released", rejected: "Rejected" };

  async function renderQueue(panel, courseId) {
    clear(panel);
    panel.appendChild(el("p", { class: "loading", text: "Loading questions..." }));
    var res = await api.get("/api/courses/" + courseId + "/questions");
    var questions = (res.data && res.data.questions) || [];
    clear(panel);

    var state = { status: "all", search: "" };

    var counts = { all: questions.length, pending: 0, released: 0, rejected: 0 };
    questions.forEach(function (q) {
      counts[q.status] = (counts[q.status] || 0) + 1;
    });

    var chipRow = el("div", { class: "chips" });
    ["all", "pending", "released", "rejected"].forEach(function (key) {
      chipRow.appendChild(
        el("button", {
          class: "qchip chip" + (state.status === key ? " active" : ""),
          type: "button",
          "data-status": key,
          text: STATUS_LABELS[key] + " (" + (counts[key] || 0) + ")",
          onclick: function () {
            state.status = key;
            Array.prototype.forEach.call(chipRow.querySelectorAll(".qchip"), function (c) {
              c.className = "qchip chip" + (c.getAttribute("data-status") === key ? " active" : "");
            });
            applyFilter();
          },
        })
      );
    });

    var search = el("input", {
      class: "search",
      type: "search",
      placeholder: "Search questions, answers, or names",
      oninput: function () {
        state.search = search.value.toLowerCase();
        applyFilter();
      },
    });

    var selectAll = el("input", {
      type: "checkbox",
      class: "select-all",
      onchange: function () {
        Array.prototype.forEach.call(cards.querySelectorAll(".qcard"), function (card) {
          if (!card.hidden) card.querySelector(".select").checked = selectAll.checked;
        });
      },
    });
    var bulkRelease = el("button", {
      class: "bulk-release",
      type: "button",
      text: "Release selected",
      onclick: async function () {
        var ids = [];
        Array.prototype.forEach.call(cards.querySelectorAll(".select"), function (cb) {
          if (cb.checked) ids.push(Number(cb.getAttribute("data-id")));
        });
        if (ids.length === 0) return;
        await api.send("POST", "/api/questions/status", { ids: ids, status: "released" });
        renderQueue(panel, courseId);
      },
    });

    var cards = el("div", { class: "qcards" });
    questions.forEach(function (q) {
      cards.appendChild(questionCard(q, panel, courseId));
    });

    function applyFilter() {
      Array.prototype.forEach.call(cards.querySelectorAll(".qcard"), function (card) {
        var st = card.getAttribute("data-status");
        var hay = card.getAttribute("data-search") || "";
        var statusOk = state.status === "all" || st === state.status;
        var searchOk = !state.search || hay.indexOf(state.search) !== -1;
        card.hidden = !(statusOk && searchOk);
      });
    }

    panel.appendChild(chipRow);
    panel.appendChild(
      el("div", { class: "queue-controls" }, [
        el("label", { class: "select-all-label" }, [selectAll, el("span", { text: " Select all" })]),
        bulkRelease,
        search,
      ])
    );
    panel.appendChild(cards);
    applyFilter();
  }

  function questionCard(q, panel, courseId) {
    var edited = q.edited_question != null || q.edited_answer != null;

    var topicInput = el("input", { type: "text", name: "topic", value: q.topic || "", class: "q-topic" });
    var questionArea = el("textarea", {
      name: "edited_question",
      rows: "2",
      value: q.edited_question != null ? q.edited_question : q.question,
    });
    var answerArea = el("textarea", {
      name: "edited_answer",
      rows: "3",
      value: q.edited_answer != null ? q.edited_answer : q.answer,
    });
    var notesArea = el("textarea", { name: "notes", rows: "2", class: "q-notes", value: q.notes || "" });

    async function saveEdits() {
      return api.send("PATCH", "/api/questions/" + q.id, {
        topic: topicInput.value,
        edited_question: questionArea.value,
        edited_answer: answerArea.value,
        notes: notesArea.value,
      });
    }
    async function setStatus(status) {
      return api.send("POST", "/api/questions/status", { ids: [q.id], status: status });
    }
    function refresh() {
      renderQueue(panel, courseId);
    }

    var actions = el("div", { class: "q-actions" }, [
      el("button", {
        class: "save",
        type: "button",
        text: "Save",
        onclick: async function () {
          await saveEdits();
          refresh();
        },
      }),
      el("button", {
        class: "save-release",
        type: "button",
        text: "Save and release",
        onclick: async function () {
          await saveEdits();
          await setStatus("released");
          refresh();
        },
      }),
      el("button", {
        class: "reject",
        type: "button",
        text: "Reject",
        onclick: async function () {
          await setStatus("rejected");
          refresh();
        },
      }),
      el("button", {
        class: "pull",
        type: "button",
        text: "Pull from guide",
        onclick: async function () {
          await setStatus("pending");
          refresh();
        },
      }),
    ]);

    var haystack = [q.author, q.topic, q.question, q.answer, q.edited_question, q.edited_answer]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    var children = [
      el("div", { class: "q-head" }, [
        el("label", { class: "q-select-label" }, [
          el("input", { type: "checkbox", class: "select", "data-id": q.id }),
        ]),
        el("span", { class: "q-author", text: q.author }),
        el("span", { class: "badge status-" + q.status, text: q.status }),
      ]),
      // When the instructor has edited a question, keep the student original in
      // a collapsed panel.
      edited
        ? el("details", { class: "original" }, [
            el("summary", { text: "Student original" }),
            el("div", { class: "orig-q", text: q.question }),
            el("div", { class: "orig-a", text: q.answer }),
          ])
        : null,
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Topic" }), topicInput]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Question" }), questionArea]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Answer" }), answerArea]),
      el("label", { class: "field" }, [el("span", { class: "field-label", text: "Private notes" }), notesArea]),
      actions,
    ];

    return el("article", { class: "qcard", "data-id": q.id, "data-status": q.status, "data-search": haystack }, children);
  }

  // --- Test builder ---
  // Assembles a test from released questions. Question text is copied into the
  // draft, so edits here never touch the study guide. The draft lives in the
  // browser per course and survives a refresh. Output is one single spaced,
  // numbered list per block, ready to paste into a Canvas question.

  function draftKey(courseId) {
    return "telos-test-" + courseId;
  }

  function loadDraft(courseId) {
    try {
      var raw = SG.store.get(draftKey(courseId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      var blocks = [];
      parsed.forEach(function (b) {
        if (!Array.isArray(b)) return;
        var block = [];
        b.forEach(function (q) {
          if (q && typeof q.text === "string") block.push({ id: q.id || null, text: q.text });
        });
        blocks.push(block);
      });
      return blocks.length ? blocks : null;
    } catch (e) {
      return null;
    }
  }

  function guideText(q) {
    return q.edited_question != null && q.edited_question !== "" ? q.edited_question : q.question;
  }

  async function renderTestBuilder(panel, course) {
    clear(panel);
    panel.appendChild(el("p", { class: "loading", text: "Loading released questions..." }));
    var res = await api.get("/api/courses/" + course.id + "/questions?status=released");
    var released = (res.data && res.data.questions) || [];
    clear(panel);

    var blocks = loadDraft(course.id) || [[]];

    function save() {
      SG.store.set(draftKey(course.id), JSON.stringify(blocks));
    }

    // Each question becomes one numbered, single spaced line; internal line
    // breaks collapse so the numbering stays clean when pasted.
    function blockText(block) {
      return block
        .map(function (q, i) {
          return (i + 1) + ". " + String(q.text).replace(/\s+/g, " ").trim();
        })
        .join("\n");
    }

    function wholeTestText() {
      return blocks
        .filter(function (b) {
          return b.length > 0;
        })
        .map(blockText)
        .join("\n\n");
    }

    function copy(text, btn) {
      var original = btn.textContent;
      function done() {
        btn.textContent = "Copied";
        setTimeout(function () {
          btn.textContent = original;
        }, 1500);
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {
            btn.textContent = "Copy failed";
          });
          return;
        }
      } catch (e) {
        /* ignore */
      }
      btn.textContent = "Copy failed";
    }

    panel.appendChild(el("h3", { text: "Build a test" }));
    panel.appendChild(
      el("p", {
        class: "hint",
        text:
          "Pick released questions, group them into blocks, and adjust the wording for this test only. Nothing here changes the study guide. Each block copies as a single spaced numbered list, ready to paste into one Canvas question with a free response box after it.",
      })
    );

    // Question picker.
    var pickerBoxes = [];
    var picker = el("div", { class: "tb-picker" });
    if (released.length === 0) {
      picker.appendChild(
        el("p", { class: "empty", text: "No released questions yet. Release questions from the queue first." })
      );
    }
    released.forEach(function (q) {
      var box = el("input", { type: "checkbox", class: "tb-check", "data-id": q.id });
      pickerBoxes.push({ box: box, q: q });
      picker.appendChild(
        el("label", { class: "tb-pick" }, [
          box,
          el("span", { class: "tb-pick-topic", text: q.topic || "Other" }),
          el("span", { class: "tb-pick-text", text: guideText(q) }),
        ])
      );
    });
    panel.appendChild(picker);

    var blockSelect = el("select", { class: "tb-block-select" });
    function refreshBlockSelect() {
      clear(blockSelect);
      blocks.forEach(function (_, i) {
        blockSelect.appendChild(el("option", { value: String(i), text: "Block " + (i + 1) }));
      });
      blockSelect.appendChild(el("option", { value: "new", text: "New block" }));
      blockSelect.value = String(blocks.length - 1);
    }

    panel.appendChild(
      el("div", { class: "tb-controls" }, [
        el("span", { class: "field-label", text: "Add selected to" }),
        blockSelect,
        el("button", {
          class: "tb-add",
          type: "button",
          text: "Add selected",
          onclick: function () {
            var chosen = pickerBoxes.filter(function (p) {
              return p.box.checked;
            });
            if (chosen.length === 0) return;
            var idx;
            if (blockSelect.value === "new") {
              blocks.push([]);
              idx = blocks.length - 1;
            } else {
              idx = Number(blockSelect.value);
            }
            chosen.forEach(function (p) {
              blocks[idx].push({ id: p.q.id, text: guideText(p.q) });
              p.box.checked = false;
            });
            save();
            renderBlocks();
            refreshBlockSelect();
          },
        }),
      ])
    );

    var blocksBox = el("div", { class: "tb-blocks" });
    panel.appendChild(blocksBox);

    panel.appendChild(
      el("div", { class: "tb-footer" }, [
        el("button", {
          class: "tb-new-block",
          type: "button",
          text: "Add empty block",
          onclick: function () {
            blocks.push([]);
            save();
            renderBlocks();
            refreshBlockSelect();
          },
        }),
        el("button", {
          class: "tb-copy-all",
          type: "button",
          text: "Copy entire test",
          onclick: function (ev) {
            copy(wholeTestText(), ev.target);
          },
        }),
        el("button", {
          class: "tb-clear",
          type: "button",
          text: "Clear test",
          onclick: function () {
            var ok = true;
            try {
              ok = window.confirm("Clear the whole test draft? This cannot be undone.");
            } catch (e) {
              /* no confirm available */
            }
            if (!ok) return;
            blocks = [[]];
            save();
            renderBlocks();
            refreshBlockSelect();
          },
        }),
      ])
    );

    function renderBlocks() {
      clear(blocksBox);
      blocks.forEach(function (block, bi) {
        var pre = el("pre", { class: "test-output", text: blockText(block) });
        var rows = el("div", { class: "tb-rows" });
        block.forEach(function (q, qi) {
          var area = el("textarea", {
            class: "tb-text",
            rows: "2",
            value: q.text,
            oninput: function () {
              q.text = area.value;
              save();
              pre.textContent = blockText(block);
            },
          });
          rows.appendChild(
            el("div", { class: "tb-row" }, [
              el("span", { class: "tb-num", text: qi + 1 + "." }),
              area,
              el("div", { class: "tb-row-actions" }, [
                el("button", {
                  class: "tb-up",
                  type: "button",
                  text: "Up",
                  disabled: qi === 0,
                  onclick: function () {
                    block.splice(qi, 1);
                    block.splice(qi - 1, 0, q);
                    save();
                    renderBlocks();
                  },
                }),
                el("button", {
                  class: "tb-down",
                  type: "button",
                  text: "Down",
                  disabled: qi === block.length - 1,
                  onclick: function () {
                    block.splice(qi, 1);
                    block.splice(qi + 1, 0, q);
                    save();
                    renderBlocks();
                  },
                }),
                el("button", {
                  class: "tb-remove",
                  type: "button",
                  text: "Remove",
                  onclick: function () {
                    block.splice(qi, 1);
                    save();
                    renderBlocks();
                  },
                }),
              ]),
            ])
          );
        });
        blocksBox.appendChild(
          el("section", { class: "tb-block", "data-block": String(bi) }, [
            el("div", { class: "tb-block-head" }, [
              el("h4", { class: "tb-block-title", text: "Block " + (bi + 1) }),
              el("button", {
                class: "tb-copy-block",
                type: "button",
                text: "Copy block",
                onclick: function (ev) {
                  copy(blockText(block), ev.target);
                },
              }),
              el("button", {
                class: "tb-remove-block",
                type: "button",
                text: "Remove block",
                onclick: function () {
                  blocks.splice(bi, 1);
                  if (blocks.length === 0) blocks.push([]);
                  save();
                  renderBlocks();
                  refreshBlockSelect();
                },
              }),
            ]),
            block.length === 0 ? el("p", { class: "hint", text: "No questions in this block yet." }) : rows,
            block.length === 0 ? null : el("div", { class: "tb-preview-label field-label", text: "Preview" }),
            block.length === 0 ? null : pre,
          ])
        );
      });
    }

    renderBlocks();
    refreshBlockSelect();
  }

  // --- Settings ---

  function renderSettings(panel, main, course) {
    clear(panel);
    var studentUrl = originOf() + "/c/" + course.slug;

    var linkInput = el("input", { type: "text", class: "student-link", readonly: "readonly", value: studentUrl });
    var copyBtn = el("button", {
      class: "copy-link",
      type: "button",
      text: "Copy",
      onclick: function () {
        linkInput.select();
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(studentUrl);
        } catch (e) {
          /* ignore */
        }
      },
    });

    function toggle(labelText, field, checked) {
      var box = el("input", {
        type: "checkbox",
        name: field,
        checked: checked,
        onchange: async function () {
          var patch = {};
          patch[field] = box.checked;
          var res = await api.send("PATCH", "/api/courses/" + course.id, patch);
          if (res.status === 200 && res.data && res.data.course) {
            course = res.data.course;
            if (field === "archived") {
              // Reflect the change back on the list when the user returns.
            }
          }
        },
      });
      return el("label", { class: "toggle" }, [box, el("span", { text: " " + labelText })]);
    }

    panel.appendChild(el("h3", { text: "Student link" }));
    panel.appendChild(el("p", { class: "hint", text: "Paste this link into Canvas. Anyone with it can view and submit." }));
    panel.appendChild(el("div", { class: "link-row" }, [linkInput, copyBtn]));

    panel.appendChild(el("h3", { text: "Topics" }));
    panel.appendChild(
      el("p", {
        class: "hint",
        text:
          "Removing a topic never deletes its questions; they keep their label and stay in the guide. Renaming updates every question that carries the topic.",
      })
    );
    panel.appendChild(renderTopicsEditor(panel, main, course));

    panel.appendChild(el("h3", { text: "Export" }));
    panel.appendChild(
      el("div", { class: "export-row" }, [
        el("a", { class: "export-md button-link", href: "/api/courses/" + course.id + "/export?format=md", text: "Download Markdown" }),
        el("a", { class: "export-csv button-link", href: "/api/courses/" + course.id + "/export?format=csv", text: "Download CSV" }),
      ])
    );

    panel.appendChild(el("h3", { text: "Options" }));
    panel.appendChild(
      el("div", { class: "toggles" }, [
        toggle("Accepting submissions", "accepting", course.accepting),
        toggle("Show student names in the guide", "show_authors", course.show_authors),
        toggle("Archive this course (hides it from students)", "archived", course.archived),
      ])
    );

    panel.appendChild(el("h3", { text: "Danger zone" }));
    var delErr = el("div", { class: "form-error", role: "alert", hidden: true });
    panel.appendChild(delErr);
    panel.appendChild(
      el("button", {
        class: "delete-course",
        type: "button",
        text: "Delete this course",
        onclick: async function () {
          var ok = true;
          try {
            ok = window.confirm("Delete this course and all of its questions? This cannot be undone.");
          } catch (e) {
            /* no confirm available */
          }
          if (!ok) return;
          var res = await api.send("DELETE", "/api/courses/" + course.id);
          if (res.status === 200) showCourseList(main);
          else {
            delErr.textContent = "Could not delete the course.";
            delErr.hidden = false;
          }
        },
      })
    );
  }

  // The topic list editor: add, rename, and remove topics. Every operation
  // round-trips through the API and re-renders settings with the fresh course.
  function renderTopicsEditor(panel, main, course) {
    var box = el("div", { class: "topics-editor" });
    var err = el("div", { class: "form-error", role: "alert", hidden: true });

    function fail(message) {
      err.textContent = message;
      err.hidden = false;
    }

    async function patchTopics(topics) {
      var res = await api.send("PATCH", "/api/courses/" + course.id, { topics: topics });
      if (res.status === 200 && res.data && res.data.course) {
        renderSettings(panel, main, res.data.course);
      } else {
        fail((res.data && res.data.details && res.data.details.join(" ")) || "Could not update topics.");
      }
    }

    (course.topics || []).forEach(function (topic) {
      var row = el("div", { class: "topic-row", "data-topic": topic });

      function showView() {
        SG.clear(row);
        row.appendChild(el("span", { class: "topic-name", text: topic }));
        row.appendChild(
          el("button", {
            class: "topic-rename",
            type: "button",
            text: "Rename",
            onclick: showRename,
          })
        );
        row.appendChild(
          el("button", {
            class: "topic-remove",
            type: "button",
            text: "Remove",
            onclick: async function () {
              await patchTopics(
                (course.topics || []).filter(function (t) {
                  return t !== topic;
                })
              );
            },
          })
        );
      }

      function showRename() {
        SG.clear(row);
        var input = el("input", { type: "text", class: "topic-rename-input", value: topic, maxlength: "200" });
        row.appendChild(input);
        row.appendChild(
          el("button", {
            class: "topic-rename-save",
            type: "button",
            text: "Save",
            onclick: async function () {
              var next = input.value.trim();
              if (!next || next === topic) {
                showView();
                return;
              }
              var res = await api.send("POST", "/api/courses/" + course.id + "/topics/rename", {
                from: topic,
                to: next,
              });
              if (res.status === 200 && res.data && res.data.course) {
                renderSettings(panel, main, res.data.course);
              } else {
                fail("Could not rename the topic.");
              }
            },
          })
        );
        row.appendChild(
          el("button", { class: "topic-rename-cancel", type: "button", text: "Cancel", onclick: showView })
        );
        input.focus();
      }

      showView();
      box.appendChild(row);
    });

    var addInput = el("input", {
      type: "text",
      class: "topic-add-input",
      placeholder: "New topic name",
      maxlength: "200",
    });
    var addRow = el("div", { class: "topic-row topic-add-row" }, [
      addInput,
      el("button", {
        class: "topic-add",
        type: "button",
        text: "Add topic",
        onclick: async function () {
          var name = addInput.value.trim();
          if (!name) return;
          var topics = (course.topics || []).slice();
          if (topics.indexOf(name) === -1) topics.push(name);
          await patchTopics(topics);
        },
      }),
    ]);

    box.appendChild(addRow);
    box.appendChild(err);
    return box;
  }

  function originOf() {
    try {
      return window.location.origin;
    } catch (e) {
      return "";
    }
  }
})();
