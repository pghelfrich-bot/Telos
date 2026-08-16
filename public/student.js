// The student view: a topic-grouped study guide with per-question reveals, a
// submission form, and a practice tab where students quiz themselves on the
// topics they choose.
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
      document.title = course.title + " · Telos";
    } catch (e) {
      /* ignore */
    }

    var guidePanel = el("section", { class: "panel", id: "guide-panel" });
    var practicePanel = el("section", { class: "panel", id: "practice-panel", hidden: true });
    var formPanel = el("section", { class: "panel", id: "form-panel", hidden: true });

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
    var tabGuide = makeTab("Study guide", guidePanel);
    var tabPractice = makeTab("Practice", practicePanel);
    var tabForm = makeTab("Submit a question", formPanel);
    tabGuide.className = "tab active";

    root.appendChild(el("header", { class: "course-header" }, [el("h1", { text: course.title })]));
    root.appendChild(el("nav", { class: "tabs no-print" }, [tabGuide, tabPractice, tabForm]));
    root.appendChild(guidePanel);
    root.appendChild(practicePanel);
    root.appendChild(formPanel);

    renderGuide(guidePanel, course);
    renderPracticeSetup(practicePanel, course);
    renderForm(formPanel, course, slug);
  };

  // Configured topics first, then any extras that appear on questions.
  function orderedTopics(course, counts) {
    var ordered = [];
    (course.topics || []).forEach(function (t) {
      if (counts[t]) ordered.push(t);
    });
    Object.keys(counts).forEach(function (t) {
      if (ordered.indexOf(t) === -1) ordered.push(t);
    });
    return ordered;
  }

  function topicCounts(questions) {
    var counts = {};
    questions.forEach(function (q) {
      var t = q.topic || "Other";
      counts[t] = (counts[t] || 0) + 1;
    });
    return counts;
  }

  // --- Study guide tab ---

  function renderGuide(panel, course) {
    clear(panel);
    var questions = course.questions || [];
    if (questions.length === 0) {
      panel.appendChild(el("p", { class: "empty", text: "No questions have been released yet. Check back soon." }));
      return;
    }

    var counts = topicCounts(questions);
    var ordered = orderedTopics(course, counts);
    var state = { topic: "all", search: "", showAll: false };
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
      var card = el(
        "article",
        {
          class: "card",
          "data-topic": topic,
          "data-search": (q.question + " " + q.answer).toLowerCase(),
        },
        [
          el("div", { class: "card-topic", text: topic }),
          el("h2", { class: "question", text: q.question }),
          course.show_authors && q.author ? el("div", { class: "author", text: "Submitted by " + q.author }) : null,
          reveal,
          answer,
        ]
      );
      cards.appendChild(card);
    });

    function applyFilter() {
      Array.prototype.forEach.call(cards.querySelectorAll(".card"), function (card) {
        var topicOk = state.topic === "all" || card.getAttribute("data-topic") === state.topic;
        var searchOk = !state.search || (card.getAttribute("data-search") || "").indexOf(state.search) !== -1;
        card.hidden = !(topicOk && searchOk);
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

    var search = el("input", {
      class: "guide-search",
      type: "search",
      placeholder: "Search questions and answers",
      oninput: function () {
        state.search = search.value.toLowerCase().trim();
        applyFilter();
      },
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
    panel.appendChild(el("div", { class: "controls no-print" }, [search, showAll]));
    panel.appendChild(cards);
    applyFilter();
  }

  // --- Practice tab ---

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function renderPracticeSetup(panel, course) {
    clear(panel);
    var questions = course.questions || [];
    if (questions.length === 0) {
      panel.appendChild(el("p", { class: "empty", text: "Practice opens once questions have been released." }));
      return;
    }

    var counts = topicCounts(questions);
    var ordered = orderedTopics(course, counts);

    var boxes = [];
    var topicList = el(
      "div",
      { class: "practice-topics" },
      ordered.map(function (t) {
        var box = el("input", { type: "checkbox", checked: true, "data-topic": t });
        boxes.push(box);
        return el("label", { class: "practice-topic" }, [
          box,
          el("span", { text: " " + t + " (" + counts[t] + ")" }),
        ]);
      })
    );

    var warn = el("p", { class: "practice-warn", role: "alert", hidden: true, text: "Pick at least one topic." });

    var start = el("button", {
      class: "submit practice-start",
      type: "button",
      text: "Start practicing",
      onclick: function () {
        var chosen = boxes
          .filter(function (b) {
            return b.checked;
          })
          .map(function (b) {
            return b.getAttribute("data-topic");
          });
        var deck = questions.filter(function (q) {
          return chosen.indexOf(q.topic || "Other") !== -1;
        });
        if (deck.length === 0) {
          warn.hidden = false;
          return;
        }
        runPractice(panel, course, shuffle(deck.slice()));
      },
    });

    panel.appendChild(el("h2", { class: "practice-heading", text: "Test yourself" }));
    panel.appendChild(
      el("p", {
        class: "hint",
        text: "Pick the topics you want to review. Cards come up in a shuffled order; answer in your head, then reveal and be honest with yourself.",
      })
    );
    panel.appendChild(topicList);
    panel.appendChild(warn);
    panel.appendChild(start);
  }

  function runPractice(panel, course, deck) {
    var total = deck.length;
    var done = 0;
    var missed = [];

    function showSummary() {
      clear(panel);
      panel.appendChild(el("h2", { class: "practice-heading", text: "Deck finished" }));
      panel.appendChild(
        el("p", {
          class: "practice-summary",
          text:
            "You worked through " +
            total +
            (total === 1 ? " card. " : " cards. ") +
            (missed.length === 0
              ? "Nothing marked for review. Nice work."
              : missed.length + (missed.length === 1 ? " card was" : " cards were") + " marked for review."),
        })
      );
      var actions = el("div", { class: "practice-actions" });
      if (missed.length > 0) {
        actions.appendChild(
          el("button", {
            class: "submit practice-again",
            type: "button",
            text: "Practice the missed ones",
            onclick: function () {
              runPractice(panel, course, shuffle(missed.slice()));
            },
          })
        );
      }
      actions.appendChild(
        el("button", {
          class: "showall",
          type: "button",
          text: "Back to topics",
          onclick: function () {
            renderPracticeSetup(panel, course);
          },
        })
      );
      panel.appendChild(actions);
    }

    function showCard() {
      if (deck.length === 0) {
        showSummary();
        return;
      }
      var q = deck.shift();
      clear(panel);

      var progress = el("div", { class: "practice-progress", text: "Card " + (done + 1) + " of " + total });
      var answer = el("div", { class: "answer practice-answer", hidden: true, text: q.answer });
      var marks = el("div", { class: "practice-actions", hidden: true }, [
        el("button", {
          class: "submit practice-got",
          type: "button",
          text: "Got it",
          onclick: function () {
            done++;
            showCard();
          },
        }),
        el("button", {
          class: "showall practice-miss",
          type: "button",
          text: "Review again",
          onclick: function () {
            if (missed.indexOf(q) === -1) missed.push(q);
            done++;
            showCard();
          },
        }),
      ]);
      var reveal = el("button", {
        class: "reveal practice-reveal",
        type: "button",
        text: "Show answer",
        onclick: function () {
          answer.hidden = false;
          marks.hidden = false;
          reveal.hidden = true;
        },
      });

      panel.appendChild(progress);
      panel.appendChild(
        el("article", { class: "card practice-card" }, [
          el("div", { class: "card-topic", text: q.topic || "Other" }),
          el("h2", { class: "question", text: q.question }),
          reveal,
          answer,
          marks,
        ])
      );
      panel.appendChild(
        el("button", {
          class: "practice-quit",
          type: "button",
          text: "End practice",
          onclick: function () {
            renderPracticeSetup(panel, course);
          },
        })
      );
    }

    showCard();
  }

  // --- Submission tab ---

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
