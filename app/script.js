(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var root = document.documentElement;

  var SETTINGS_KEY = "skim.settings";
  var HISTORY_KEY = "skim.history";
  var LENGTH_KEY = "skim.length";
  var THEME_KEY = "theme";

  var TRANSCRIPT_HOST = "youtube-transcript3.p.rapidapi.com";
  var TRANSCRIPT_CAP = 30000;
  var HISTORY_MAX = 20;

  var PRESET_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
  ];
  var CUSTOM_MODEL = "__custom";
  var LANGS = [
    "English",
    "Bangla",
    "Hindi",
    "Urdu",
    "Arabic",
    "Chinese",
    "Japanese",
  ];
  var LENGTH_HINT = {
    short: "Keep it very brief: 2 sentences in TL;DR, at most 4 key points, 2 takeaways.",
    medium: "Balanced: a 3-sentence TL;DR, 5-7 key points, 3 takeaways.",
    detailed: "Be thorough: a 4-5 sentence TL;DR, 8-12 key points, 4-5 takeaways.",
  };

  var N = window.Native || null;

  /* ---------------- storage ---------------- */

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      toast("Storage is blocked — changes won't persist");
    }
  }

  var settings = readJSON(SETTINGS_KEY, null) || {};
  settings = {
    rapidKey: settings.rapidKey || "",
    geminiKey: settings.geminiKey || "",
    model: settings.model || PRESET_MODELS[0],
    lang: LANGS.indexOf(settings.lang) > -1 ? settings.lang : "English",
  };

  var history = readJSON(HISTORY_KEY, []);
  if (!Array.isArray(history)) history = [];

  var state = {
    length: "medium",
    current: null,
  };

  /* ---------------- ui helpers ---------------- */

  var toastTimer = 0;

  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 2200);
  }

  function setStatus(msg, kind) {
    var el = $("status");
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = msg || "";
  }

  function showView(name) {
    ["home", "history", "settings", "about"].forEach(function (v) {
      $("view-" + v).hidden = v !== name;
    });
    document.body.setAttribute("data-view", name);

    var tabs = document.querySelectorAll(".tabbar button");
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute("data-tab") === name;
      tabs[i].classList.toggle("active", on);
      if (on) tabs[i].setAttribute("aria-current", "page");
      else tabs[i].removeAttribute("aria-current");
    }
    window.scrollTo(0, 0);
    if (name === "history") renderHistory();
  }

  /* ---------------- theme ---------------- */

  function applyTheme(dark) {
    root.classList.toggle("dark", dark);
    var btn = $("themeBtn");
    btn.setAttribute("aria-pressed", String(dark));
    btn.setAttribute(
      "aria-label",
      dark ? "Switch to light mode" : "Switch to dark mode"
    );
  }

  applyTheme(root.classList.contains("dark"));

  $("themeBtn").addEventListener("click", function () {
    var dark = !root.classList.contains("dark");
    applyTheme(dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch (e) {}
  });

  /* ---------------- markdown ---------------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function inlineFmt(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function md(src) {
    var lines = String(src).split(/\r?\n/);
    var html = "";
    var list = null;
    var quote = [];

    function closeList() {
      if (list) {
        html += "</" + list + ">";
        list = null;
      }
    }

    function flushQuote() {
      if (quote.length) {
        html += "<blockquote><p>" + quote.join("<br>") + "</p></blockquote>";
        quote = [];
      }
    }

    lines.forEach(function (raw) {
      var line = raw.trim();

      if (/^>/.test(line)) {
        closeList();
        quote.push(inlineFmt(line.replace(/^>\s?/, "")));
        return;
      }
      flushQuote();

      if (!line || /^-{3,}$/.test(line)) {
        closeList();
        return;
      }

      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        var lvl = Math.min(h[1].length + 1, 4);
        html += "<h" + lvl + ">" + inlineFmt(h[2]) + "</h" + lvl + ">";
        return;
      }

      var ul = line.match(/^[-*•]\s+(.*)$/);
      var ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        var want = ul ? "ul" : "ol";
        if (list !== want) {
          closeList();
          html += "<" + want + ">";
          list = want;
        }
        html += "<li>" + inlineFmt((ul || ol)[1]) + "</li>";
        return;
      }

      closeList();
      html += "<p>" + inlineFmt(line) + "</p>";
    });

    closeList();
    flushQuote();
    return html;
  }

  /* ---------------- misc ---------------- */

  function videoId(input) {
    if (!input) return null;
    var m = input.match(
      /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
    );
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) return input.trim();
    return null;
  }

  function thumbUrl(id) {
    return "https://img.youtube.com/vi/" + id + "/hqdefault.jpg";
  }

  function readTimeWords(text) {
    var words = String(text).replace(/[#*`>]/g, " ").split(/\s+/).filter(Boolean)
      .length;
    return Math.max(1, Math.round(words / 200));
  }

  function fmtDate(ts) {
    try {
      var d = new Date(ts);
      return (
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " · " +
        d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      );
    } catch (e) {
      return "";
    }
  }

  function currentModel() {
    return (settings.model || PRESET_MODELS[0]).trim();
  }

  /* ---------------- clipboard / share ---------------- */

  function copyText(text, okMsg) {
    var done = okMsg || "Copied";

    if (N && N.copyText) {
      N.copyText(text);
      toast(done);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(done);
        },
        fallback
      );
      return;
    }
    fallback();

    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {}
      ta.remove();
      if (ok) toast(done);
      else alert("Couldn't copy. Select the text manually.");
    }
  }

  function shareText(text) {
    if (N && N.shareText) {
      N.shareText(text);
      return;
    }
    if (navigator.share) {
      navigator.share({ text: text }).catch(function () {});
      return;
    }
    copyText(text, "Sharing isn't available — copied instead");
  }

  /* ---------------- home: input ---------------- */

  function renderPreview() {
    var id = videoId($("url").value.trim());
    var box = $("preview");
    if (!id) {
      box.hidden = true;
      return;
    }
    $("pvImg").src = thumbUrl(id);
    $("pvTxt").textContent = "Video ID: " + id;
    box.hidden = false;
  }

  $("url").addEventListener("input", renderPreview);
  $("url").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      startSummary();
    }
  });

  $("pasteBtn").addEventListener("click", function () {
    function apply(text) {
      $("url").value = (text || "").trim();
      renderPreview();
    }
    if (N && N.readClipboard) {
      apply(N.readClipboard());
      return;
    }
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(apply, function () {
        toast("Clipboard blocked — paste manually");
      });
      return;
    }
    toast("Long-press the field to paste");
  });

  /* ---------------- length ---------------- */

  var lengthBtns = document.querySelectorAll(".seg button");

  function applyLength(len) {
    state.length = LENGTH_HINT[len] ? len : "medium";
    for (var i = 0; i < lengthBtns.length; i++) {
      var on = lengthBtns[i].getAttribute("data-length") === state.length;
      lengthBtns[i].setAttribute("aria-pressed", String(on));
    }
    try {
      localStorage.setItem(LENGTH_KEY, JSON.stringify(state.length));
    } catch (e) {}
  }

  for (var i = 0; i < lengthBtns.length; i++) {
    lengthBtns[i].addEventListener("click", function () {
      applyLength(this.getAttribute("data-length"));
    });
  }

  applyLength(readJSON(LENGTH_KEY, "medium"));

  /* ---------------- api ---------------- */

  var job = {
    running: false,
    aborter: null,
    cancelled: false,
  };

  function msgOf(body) {
    if (!body) return "";
    if (body.error && body.error.message) return body.error.message;
    if (body.message) return body.message;
    return "";
  }

  function http(url, opts) {
    opts = opts || {};
    if (job.aborter) opts.signal = job.aborter.signal;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (raw) {
        var body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          body = { raw: raw };
        }
        return { ok: res.ok, status: res.status, body: body };
      });
    });
  }

  function fetchTranscript(id) {
    var url =
      "https://" +
      TRANSCRIPT_HOST +
      "/api/transcript?videoId=" +
      encodeURIComponent(id);

    return http(url, {
      method: "GET",
      headers: {
        "x-rapidapi-key": settings.rapidKey,
        "x-rapidapi-host": TRANSCRIPT_HOST,
      },
    }).then(function (res) {
      if (!res.ok) {
        throw new Error(
          msgOf(res.body) ||
            "Transcript failed (" + res.status + "). Check the RapidAPI key or quota."
        );
      }

      var arr = res.body && res.body.transcript;
      if (arr && arr.transcript) arr = arr.transcript;
      if (!Array.isArray(arr)) {
        throw new Error("No transcript found for this video.");
      }

      var text = arr
        .map(function (item) {
          return typeof item === "string" ? item : item && item.text ? item.text : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) throw new Error("This video has an empty transcript.");
      return text;
    });
  }

  function fetchSummary(transcript) {
    var model = currentModel();
    var prompt =
      "Write the summary in " +
      settings.lang +
      ". Summarize this YouTube video transcript clearly and faithfully using markdown:\n" +
      "## TL;DR\n## Key points\n## Takeaways\n" +
      LENGTH_HINT[state.length] +
      "\nNever invent facts. If something is unclear, leave it out.\n\nTranscript:\n\n" +
      transcript.slice(0, TRANSCRIPT_CAP);

    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(settings.geminiKey);

    return http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }).then(function (res) {
      if (!res.ok) {
        throw new Error(
          msgOf(res.body) || "Gemini request failed (" + res.status + ")."
        );
      }

      var cand = res.body.candidates && res.body.candidates[0];
      var parts = cand && cand.content && cand.content.parts;
      var text = parts
        ? parts
            .map(function (p) {
              return p.text || "";
            })
            .join("\n")
        : "";

      if (!text.trim()) throw new Error("Gemini returned an empty summary.");
      return text.trim();
    });
  }

  function fetchMeta(id) {
    var url =
      "https://www.youtube.com/oembed?url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + id) +
      "&format=json";

    return fetch(url)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (j) {
        return j ? { title: j.title || "", channel: j.author_name || "" } : null;
      })
      .catch(function () {
        return null;
      });
  }

  /* ---------------- job ---------------- */

  function setBusy(busy) {
    var btn = $("sumBtn");
    btn.disabled = busy;
    btn.textContent = busy ? "Working…" : "Summarize";
    $("cancelBtn").hidden = !busy;
  }

  function startSummary() {
    if (job.running) {
      toast("A summary is already running");
      return;
    }

    var url = $("url").value.trim();
    var id = videoId(url);

    if (!id) {
      setStatus("Enter a valid YouTube link.", "err");
      return;
    }
    if (!navigator.onLine) {
      setStatus("You're offline. Connect and try again.", "err");
      return;
    }
    if (!settings.rapidKey || !settings.geminiKey) {
      setStatus("Add your API keys in Settings first.", "err");
      toast("Keys missing");
      showView("settings");
      return;
    }

    job.running = true;
    job.cancelled = false;
    job.aborter = typeof AbortController === "function" ? new AbortController() : null;
    setBusy(true);
    setStatus("Fetching transcript…");

    var started = Date.now();
    var meta = fetchMeta(id);

    fetchTranscript(id)
      .then(function (transcript) {
        if (job.cancelled) return null;
        setStatus("Writing the summary with " + currentModel() + "…");
        return fetchSummary(transcript).then(function (summary) {
          return meta.then(function (info) {
            return {
              text: transcript,
              summary: summary,
              meta: info,
              seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
            };
          });
        });
      })
      .then(function (res) {
        if (!res || job.cancelled) return;

        var entry = {
          id: Date.now(),
          videoId: id,
          url: url,
          title: (res.meta && res.meta.title) || "",
          channel: (res.meta && res.meta.channel) || "",
          model: currentModel(),
          lang: settings.lang,
          length: state.length,
          date: Date.now(),
          text: res.summary,
          readTime: readTimeWords(res.summary),
        };

        history.unshift(entry);
        history = history.slice(0, HISTORY_MAX);
        writeJSON(HISTORY_KEY, history);

        showResult(entry);
        setStatus("Done in " + res.seconds + "s.", "ok");
        toast("Summary ready");
      })
      .catch(function (err) {
        if (job.cancelled) {
          setStatus("Cancelled.");
          return;
        }
        var msg = (err && err.message) || "Something went wrong.";
        setStatus(msg, "err");
        toast("Summary failed");
      })
      .then(function () {
        job.running = false;
        job.aborter = null;
        job.cancelled = false;
        setBusy(false);
      });
  }

  $("sumBtn").addEventListener("click", startSummary);

  $("cancelBtn").addEventListener("click", function () {
    if (!job.running) return;
    job.cancelled = true;
    if (job.aborter) job.aborter.abort();
    setStatus("Cancelled.");
    toast("Cancelled");
  });

  /* ---------------- result ---------------- */

  function showResult(entry) {
    state.current = entry;

    var img = $("outImg");
    img.src = thumbUrl(entry.videoId);
    img.alt = entry.title || "Video thumbnail";

    $("outTitle").textContent = entry.title || "Video " + entry.videoId;

    var bits = [];
    if (entry.channel) bits.push(entry.channel);
    bits.push(entry.model);
    bits.push(entry.lang);
    bits.push(entry.readTime + " min read");
    $("outSub").textContent = bits.join(" · ");

    $("summaryBody").innerHTML = md(entry.text);
    $("out").hidden = false;
    $("emptyHint").hidden = true;

    $("out").scrollIntoView({ block: "start" });
  }

  $("readBtn").addEventListener("click", openReader);
  $("copyBtn").addEventListener("click", function () {
    if (state.current) copyText(state.current.text, "Summary copied");
  });
  $("shareBtn").addEventListener("click", function () {
    if (state.current) shareText(state.current.text);
  });

  $("clearBtn").addEventListener("click", function () {
    clearResult();
    $("url").value = "";
    renderPreview();
  });

  function clearResult() {
    state.current = null;
    $("out").hidden = true;
    $("summaryBody").innerHTML = "";
    $("emptyHint").hidden = false;
    setStatus("");
  }

  /* ---------------- reader ---------------- */

  function openReader() {
    var entry = state.current;
    if (!entry) return;

    $("readerTitle").textContent = entry.title || "Video " + entry.videoId;
    $("readerSub").textContent = entry.channel
      ? entry.channel + " · " + entry.readTime + " min read"
      : entry.model + " · " + entry.readTime + " min read";
    $("readerContent").innerHTML = md(entry.text);
    $("reader").hidden = false;
    document.body.classList.add("reading");
    $("reader").scrollTop = 0;
  }

  function closeReader() {
    $("reader").hidden = true;
    document.body.classList.remove("reading");
  }

  $("readerClose").addEventListener("click", closeReader);
  $("readerCopy").addEventListener("click", function () {
    if (state.current) copyText(state.current.text, "Summary copied");
  });
  $("readerShare").addEventListener("click", function () {
    if (state.current) shareText(state.current.text);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("reader").hidden) closeReader();
  });

  /* ---------------- history ---------------- */

  function renderHistory() {
    var list = $("histList");
    list.innerHTML = "";

    if (!history.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent =
        "Nothing here yet. Summaries you make are kept on this device — the last 20.";
      list.appendChild(empty);
      return;
    }

    history.forEach(function (entry) {
      var li = document.createElement("li");
      li.className = "hist-item";

      var img = document.createElement("img");
      img.src = thumbUrl(entry.videoId);
      img.alt = "";
      img.loading = "lazy";

      var body = document.createElement("div");
      body.className = "body";

      var title = document.createElement("b");
      title.textContent = entry.title || "Video " + entry.videoId;

      var meta = document.createElement("span");
      meta.textContent =
        fmtDate(entry.date) + " · " + entry.model + " · " + entry.lang;

      body.appendChild(title);
      body.appendChild(meta);

      var del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.setAttribute("aria-label", "Delete summary");
      del.textContent = "×";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        history = history.filter(function (x) {
          return x.id !== entry.id;
        });
        writeJSON(HISTORY_KEY, history);
        renderHistory();
        toast("Deleted");
      });

      li.appendChild(img);
      li.appendChild(body);
      li.appendChild(del);

      li.addEventListener("click", function () {
        showView("home");
        showResult(entry);
        setStatus("");
      });

      list.appendChild(li);
    });
  }

  $("histClear").addEventListener("click", function () {
    if (!history.length) {
      toast("History is already empty");
      return;
    }
    if (!confirm("Delete all " + history.length + " saved summaries?")) return;
    history = [];
    writeJSON(HISTORY_KEY, history);
    renderHistory();
    toast("History cleared");
  });

  /* ---------------- colour pickers ---------------- */

  var COLOR_KEY = "skim.colors";
  var DEFAULT_COLORS = {
    lightBg: "#f7f6f3",
    lightSurface: "#ffffff",
    darkBg: "#0a0a0a",
    darkSurface: "#121212",
  };

  function hexOr(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback;
  }

  var storedColors = readJSON(COLOR_KEY, null) || {};
  var palette = {
    lightBg: hexOr(storedColors.lightBg, DEFAULT_COLORS.lightBg),
    lightSurface: hexOr(storedColors.lightSurface, DEFAULT_COLORS.lightSurface),
    darkBg: hexOr(storedColors.darkBg, DEFAULT_COLORS.darkBg),
    darkSurface: hexOr(storedColors.darkSurface, DEFAULT_COLORS.darkSurface),
  };

  function applyPalette() {
    $("colorOverride").textContent =
      ":root{--bg:" +
      palette.lightBg +
      ";--surface:" +
      palette.lightSurface +
      "}html.dark{--bg:" +
      palette.darkBg +
      ";--surface:" +
      palette.darkSurface +
      "}";
  }

  function syncColorInputs() {
    $("cLightBg").value = palette.lightBg;
    $("cLightSurface").value = palette.lightSurface;
    $("cDarkBg").value = palette.darkBg;
    $("cDarkSurface").value = palette.darkSurface;
  }

  function savePalette() {
    writeJSON(COLOR_KEY, palette);
  }

  var colorInputs = [
    ["cLightBg", "lightBg"],
    ["cLightSurface", "lightSurface"],
    ["cDarkBg", "darkBg"],
    ["cDarkSurface", "darkSurface"],
  ];

  colorInputs.forEach(function (pair) {
    $(pair[0]).addEventListener("input", function () {
      palette[pair[1]] = this.value;
      applyPalette();
    });
    $(pair[0]).addEventListener("change", function () {
      palette[pair[1]] = this.value;
      applyPalette();
      savePalette();
      toast("Color saved");
    });
  });

  $("colorsReset").addEventListener("click", function () {
    palette = {
      lightBg: DEFAULT_COLORS.lightBg,
      lightSurface: DEFAULT_COLORS.lightSurface,
      darkBg: DEFAULT_COLORS.darkBg,
      darkSurface: DEFAULT_COLORS.darkSurface,
    };
    try {
      localStorage.removeItem(COLOR_KEY);
    } catch (e) {}
    applyPalette();
    syncColorInputs();
    toast("Colors reset");
  });

  applyPalette();
  syncColorInputs();

  /* ---------------- settings ---------------- */

  function buildOptions() {
    var modelSel = $("modelSel");
    var langSel = $("langSel");

    PRESET_MODELS.forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      modelSel.appendChild(opt);
    });

    var custom = document.createElement("option");
    custom.value = CUSTOM_MODEL;
    custom.textContent = "Custom model…";
    modelSel.appendChild(custom);

    LANGS.forEach(function (l) {
      var opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l;
      langSel.appendChild(opt);
    });
  }

  function syncModelField() {
    var custom = $("modelSel").value === CUSTOM_MODEL;
    $("modelCustom").hidden = !custom;
    if (custom) $("modelCustom").focus();
  }

  function renderSettings() {
    $("rapidKey").value = settings.rapidKey;
    $("geminiKey").value = settings.geminiKey;

    var preset = PRESET_MODELS.indexOf(settings.model) > -1;
    $("modelSel").value = preset ? settings.model : CUSTOM_MODEL;
    $("modelCustom").value = preset ? "" : settings.model;
    $("modelCustom").hidden = preset;

    $("langSel").value = settings.lang;
  }

  buildOptions();
  renderSettings();

  $("modelSel").addEventListener("change", syncModelField);

  $("saveBtn").addEventListener("click", function () {
    var rapid = $("rapidKey").value.trim();
    var gemini = $("geminiKey").value.trim();
    var sel = $("modelSel").value;
    var model = sel === CUSTOM_MODEL ? $("modelCustom").value.trim() : sel;

    if (!model) {
      alert("Enter a model name or pick a preset.");
      $("modelCustom").focus();
      return;
    }

    settings = {
      rapidKey: rapid,
      geminiKey: gemini,
      model: model,
      lang: $("langSel").value,
    };
    writeJSON(SETTINGS_KEY, settings);
    renderSettings();

    if (!rapid || !gemini) toast("Saved — add the missing key to summarize");
    else toast("Settings saved");
  });

  $("removeKeys").addEventListener("click", function () {
    if (!confirm("Remove both API keys from this device?")) return;
    settings.rapidKey = "";
    settings.geminiKey = "";
    writeJSON(SETTINGS_KEY, settings);
    renderSettings();
    toast("Keys removed");
  });

  $("updateLink").addEventListener("click", function (e) {
    var url = this.getAttribute("href");
    if (N && N.openUrl) {
      e.preventDefault();
      N.openUrl(url);
    }
  });

  /* ---------------- offline + tabs ---------------- */

  function syncOffline() {
    $("offline").hidden = navigator.onLine !== false;
  }

  window.addEventListener("online", syncOffline);
  window.addEventListener("offline", syncOffline);
  syncOffline();

  var tabs = document.querySelectorAll(".tabbar button");
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener("click", function () {
      showView(this.getAttribute("data-tab"));
    });
  }

  showView("home");
  renderHistory();
})();
