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
        el("h1", { text: "Telos" }),
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
    var settingsPanel = el("section", { class: "panel settings", id: "settings-panel", hidden: true });

    var tabQueue = el("button", {
      class: "tab active",
      type: "button",
      text: "Queue",
      onclick: function () {
        setTab(true);
      },
    });
    var tabSettings = el("button", {
      class: "tab",
      type: "button",
      text: "Settings",
      onclick: function () {
        setTab(false);
      },
    });
    function setTab(showQueue) {
      queuePanel.hidden = !showQueue;
      settingsPanel.hidden = showQueue;
      tabQueue.className = "tab" + (showQueue ? " active" : "");
      tabSettings.className = "tab" + (showQueue ? "" : " active");
    }

    main.appendChild(el("nav", { class: "tabs" }, [tabQueue, tabSettings]));
    main.appendChild(queuePanel);
    main.appendChild(settingsPanel);

    renderSettings(settingsPanel, main, course);
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
