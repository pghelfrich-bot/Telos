// The student view: a topic-grouped study guide with per-question reveals, and
// a submission form on a second tab.
(function () {
  "use strict";
  var el = SG.el;
  var api = SG.api;
  var store = SG.store;
  var clear = SG.clear;

  SG.renderStudent = async function (root, slug) {
    clear(root);
    root.appendChild(el("p", { class: "loading", text: "Loading the study guide..." }));

    var res;
    try {
      res = await api.get("/api/course/" + encodeURIComponent(slug));
    } catch (e) {
      clear(root);
      root.appendChild(
        el("div", { class: "notice" }, [
          el("h1", { text: "Could not load the study guide" }),
          el("p", { text: "Please check your connection and refresh the page." }),
        ])
      );
      return;
    }
    clear(root);

    if (res.status === 404 || !res.data) {
      root.appendChild(
        el("div", { class: "notice" }, [
          el("h1", { text: "Study guide not found" }),
          el("p", { text: "This link may be incorrect, or the guide may have been taken down." }),
        ])
      );
      return;
    }

    var course = res.data;
    try {
      document.title = course.title + " study guide";
    } catch (e) {
      /* ignore */
    }

    var guidePanel = el("section", { class: "panel", id: "guide-panel" });
    var formPanel = el("section", { class: "panel", id: "form-panel", hidden: true });

    var tabGuide = el("button", {
      class: "tab active",
      type: "button",
      text: "Study guide",
      onclick: function () {
        setTab(true);
      },
    });
    var tabForm = el("button", {
      class: "tab",
      type: "button",
      text: "Submit a question",
      onclick: function () {
        setTab(false);
      },
    });
    function setTab(showGuide) {
      guidePanel.hidden = !showGuide;
      formPanel.hidden = showGuide;
      tabGuide.className = "tab" + (showGuide ? " active" : "");
      tabForm.className = "tab" + (showGuide ? "" : " active");
    }

    root.appendChild(el("header", { class: "course-header" }, [el("h1", { text: course.title })]));
    root.appendChild(el("nav", { class: "tabs no-print" }, [tabGuide, tabForm]));
    root.appendChild(guidePanel);
    root.appendChild(formPanel);

    renderGuide(guidePanel, course);
    renderForm(formPanel, course, slug);
  };

  function renderGuide(panel, course) {
    clear(panel);
    var questions = course.questions || [];
    if (questions.length === 0) {
      panel.appendChild(el("p", { class: "empty", text: "No questions have been released yet. Check back soon." }));
      return;
    }

    var counts = {};
    questions.forEach(function (q) {
      var t = q.topic || "Other";
      counts[t] = (counts[t] || 0) + 1;
    });

    // Configured topics first, then any extras that appear on questions.
    var ordered = [];
    (course.topics || []).forEach(function (t) {
      if (counts[t]) ordered.push(t);
    });
    Object.keys(counts).forEach(function (t) {
      if (ordered.indexOf(t) === -1) ordered.push(t);
    });

    var state = { topic: "all", showAll: false };
    var cards = el("div", { class: "cards" });

    questions.forEach(function (q) {
      var topic = q.topic || "Other";
      var answer = el("div", { class: "answer", hidden: true, text: q.answer });
      var reveal = el("button", {
        class: "reveal no-print",
        type: "button",
        text: "Show answer",
        onclick: function () {
          answer.hidden = !answer.hidden;
          reveal.textContent = answer.hidden ? "Show answer" : "Hide answer";
        },
      });
      var card = el("article", { class: "card", "data-topic": topic }, [
        el("div", { class: "card-topic", text: topic }),
        el("h2", { class: "question", text: q.question }),
        course.show_authors && q.author ? el("div", { class: "author", text: "Submitted by " + q.author }) : null,
        reveal,
        answer,
      ]);
      cards.appendChild(card);
    });

    function applyFilter() {
      Array.prototype.forEach.call(cards.querySelectorAll(".card"), function (card) {
        var t = card.getAttribute("data-topic");
        card.hidden = !(state.topic === "all" || t === state.topic);
      });
    }

    var chipRow = el("div", { class: "chips no-print" });
    function chip(label, key, count) {
      return el(
        "button",
        {
          class: "chip" + (state.topic === key ? " active" : ""),
          type: "button",
          "data-topic": key,
          onclick: function () {
            state.topic = key;
            applyFilter();
            Array.prototype.forEach.call(chipRow.querySelectorAll(".chip"), function (c) {
              c.className = "chip" + (c.getAttribute("data-topic") === state.topic ? " active" : "");
            });
          },
        },
        [el("span", { text: label }), el("span", { class: "count", text: " (" + count + ")" })]
      );
    }
    chipRow.appendChild(chip("All topics", "all", questions.length));
    ordered.forEach(function (t) {
      chipRow.appendChild(chip(t, t, counts[t]));
    });

    var showAll = el("button", {
      class: "showall no-print",
      type: "button",
      text: "Show all answers",
      onclick: function () {
        state.showAll = !state.showAll;
        showAll.textContent = state.showAll ? "Hide all answers" : "Show all answers";
        Array.prototype.forEach.call(cards.querySelectorAll(".answer"), function (a) {
          a.hidden = !state.showAll;
        });
        Array.prototype.forEach.call(cards.querySelectorAll(".reveal"), function (b) {
          b.textContent = state.showAll ? "Hide answer" : "Show answer";
        });
      },
    });

    panel.appendChild(chipRow);
    panel.appendChild(el("div", { class: "controls no-print" }, [showAll]));
    panel.appendChild(cards);
    applyFilter();
  }

  function field(labelText, input) {
    return el("label", { class: "field" }, [el("span", { class: "field-label", text: labelText }), input]);
  }

  function renderForm(panel, course, slug) {
    clear(panel);
    if (!course.accepting) {
      panel.appendChild(
        el("p", { class: "closed", text: "This course is not accepting new questions right now." })
      );
      return;
    }

    var error = el("div", { class: "form-error", role: "alert", hidden: true });
    var success = el("div", { class: "form-success", role: "status", hidden: true });

    var nameInput = el("input", {
      type: "text",
      name: "name",
      maxlength: "2000",
      value: store.get("sg-name") || "",
    });
    var topicSelect = el("select", { name: "topic" });
    topicSelect.appendChild(el("option", { value: "", text: "Choose a topic" }));
    (course.topics || []).forEach(function (t) {
      topicSelect.appendChild(el("option", { value: t, text: t }));
    });
    var questionInput = el("textarea", { name: "question", rows: "3", maxlength: "2000" });
    var answerInput = el("textarea", { name: "answer", rows: "4", maxlength: "2000" });
    var submitBtn = el("button", { class: "submit", type: "submit", text: "Submit question" });

    var form = el(
      "form",
      {
        class: "submit-form",
        novalidate: "novalidate",
        onsubmit: async function (ev) {
          ev.preventDefault();
          error.hidden = true;
          success.hidden = true;
          submitBtn.disabled = true;
          var body = {
            name: nameInput.value,
            topic: topicSelect.value,
            question: questionInput.value,
            answer: answerInput.value,
          };
          try {
            var res = await api.send("POST", "/api/course/" + encodeURIComponent(slug) + "/questions", body);
            if (res.status === 201) {
              store.set("sg-name", nameInput.value.trim());
              success.textContent = "Thanks. Your question was submitted for review.";
              success.hidden = false;
              questionInput.value = "";
              answerInput.value = "";
            } else if (res.status === 429) {
              error.textContent = "Too many submissions right now. Please try again later.";
              error.hidden = false;
            } else {
              var details =
                res.data && res.data.details
                  ? res.data.details.join(" ")
                  : (res.data && res.data.error) || "Something went wrong. Please check your entries.";
              error.textContent = details;
              error.hidden = false;
            }
          } catch (e) {
            error.textContent = "Could not reach the server. Please try again.";
            error.hidden = false;
          } finally {
            submitBtn.disabled = false;
          }
        },
      },
      [
        field("Your name", nameInput),
        field("Topic", topicSelect),
        field("Question", questionInput),
        field("Answer", answerInput),
        error,
        success,
        submitBtn,
      ]
    );

    panel.appendChild(form);
  }
})();
