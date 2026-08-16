/**
 * messaging-core client half — sidebar entry + "消息平台" setup dialog.
 *
 * Follows the chicheng-cron house pattern (DOM-injected sidebar trigger,
 * ReactDOM dialog mounted into document.body, no build step). Entry sits
 * below the cron trigger when present, else below the New Session button.
 * The dialog is hermes-style: left = platform list (with connection dots),
 * right = per-platform configuration form backed by the host's
 * /messaging/config (GET redacted values, POST persists through the
 * settings service).
 */
window.__ModuleLoader__.load({
  id: "messaging-core",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom/client");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var CSS = '<style data-dsh-msg-css>' +
      // The sidebar trigger clones the New Session button (native look and
      // collapse behavior); only the dialog needs custom styles.
      '.dshm-panel{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.5);font-size:13px}' +
      '.dshm-box{box-sizing:border-box;width:min(860px,94vw);height:min(600px,90vh);display:flex;flex-direction:column;' +
      'background:var(--dsw-alias-bg,#161a24);border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:16px;' +
      'box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden}' +
      '.dshm-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;font-size:14px;font-weight:600;' +
      'border-bottom:1px solid var(--dsw-alias-border-l1,#262b36)}' +
      '.dshm-body{display:flex;flex:1;min-height:0}' +
      '.dshm-list{width:240px;flex:none;border-right:1px solid var(--dsw-alias-border-l1,#262b36);overflow-y:auto;padding:10px}' +
      '.dshm-plat{box-sizing:border-box;width:100%;text-align:left;cursor:pointer;padding:8px 10px;border-radius:10px;' +
      'border:1px solid transparent;background:transparent;color:inherit;display:flex;align-items:center;gap:8px;margin-bottom:4px}' +
      '.dshm-plat:hover{background:var(--dsw-alias-interactive-bg-hover,#262c3c)}' +
      '.dshm-plat[data-active="true"]{border-color:var(--dsw-alias-border-l2,#3a3f4b);background:var(--dsw-alias-interactive-bg,#1d2230)}' +
      '.dshm-dot{width:8px;height:8px;border-radius:50%;flex:none}' +
      '.dshm-content{flex:1;min-width:0;overflow-y:auto;padding:16px 20px}' +
      '.dshm-field{margin-bottom:12px}' +
      '.dshm-label{font-size:12px;color:var(--dsw-alias-label-secondary,#a8adba);margin-bottom:4px}' +
      '.dshm-input,.dshm-textarea,.dshm-select{box-sizing:border-box;width:100%;padding:7px 10px;font-size:13px;color:inherit;' +
      'background:var(--dsw-alias-input-bg,#11151d);border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:8px}' +
      '.dshm-textarea{min-height:110px;resize:vertical;font-family:ui-monospace,monospace;font-size:12px}' +
      '.dshm-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f9d);margin-bottom:12px;line-height:1.5}' +
      '.dshm-savebar{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 16px;' +
      'border-top:1px solid var(--dsw-alias-border-l1,#262b36)}' +
      '.dshm-btn{padding:6px 16px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);' +
      'background:var(--dsw-alias-interactive-bg,#1d2230);color:inherit}' +
      '.dshm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#262c3c)}' +
      '.dshm-btn[data-primary="true"]{background:#3b82f6;border-color:#3b82f6;color:#fff}' +
      '.dshm-msg{font-size:12px;color:#3fb950}' +
      '.dshm-err{font-size:12px;color:#f2a1a1}' +
      '.dshm-close{background:none;border:none;color:var(--dsw-alias-label-secondary,#a8adba);font-size:18px;cursor:pointer;padding:2px 8px}' +
      '.dshm-qr{display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px 0;text-align:center}' +
      '.dshm-qr img{background:#fff;border-radius:12px;padding:8px;image-rendering:pixelated}' +
      '.dshm-qr-status{font-size:13px;color:var(--dsw-alias-label-primary,#e6e9f0);min-height:20px}' +
      '.dshm-qr-actions{display:flex;gap:10px}' +
      '.dshm-qr-start{margin-bottom:14px;border-color:#3b82f6;color:#7ab0ff}' +
      '</style>';

    if (!document.querySelector("[data-dsh-msg-css]")) {
      document.head.insertAdjacentHTML("beforeend", CSS);
    }

    // ---------------------------------------------------------------- dom

    function findNewSessionButton() {
      var selectors = 'button[aria-label="新建会话"], button[aria-label="New session"], button[aria-label="New Session"]';
      var found = document.querySelectorAll(selectors);
      if (found.length > 0) return found[found.length - 1];
      var candidates = document.querySelectorAll("button");
      for (var i = 0; i < candidates.length; i += 1) {
        var text = candidates[i].textContent || "";
        if (text.indexOf("新建会话") >= 0 || text.indexOf("New Session") >= 0 || text.indexOf("New session") >= 0) {
          return candidates[i];
        }
      }
      return null;
    }

    function findAnchor() {
      var cronHost = document.querySelector("[data-dsh-cron-host]");
      if (cronHost !== null) return cronHost;
      return findNewSessionButton();
    }

    function isCollapsed(button) {
      var node = button && button.parentElement;
      var depth = 0;
      while (node && depth < 6) {
        var cls = typeof node.className === "string" ? node.className : "";
        if (cls.indexOf("collapsed") >= 0) return true;
        var w = node.getBoundingClientRect ? node.getBoundingClientRect().width : 0;
        if (w !== undefined && w > 0 && w < 100 && cls !== "") return true;
        node = node.parentElement;
        depth += 1;
      }
      return false;
    }

    // ---------------------------------------------------------------- dialog

    function FieldInput(props) {
      var field = props.field;
      var value = props.value;
      var setValue = props.setValue;
      var redacted = props.redacted;

      if (field.type === "bool") {
        return h("select", { className: "dshm-select", value: value === true || value === "true" ? "true" : "false",
          onChange: function (e) { setValue(e.target.value === "true"); } },
          h("option", { value: "true" }, "true"),
          h("option", { value: "false" }, "false")
        );
      }
      if (field.type === "number") {
        return h("input", { className: "dshm-input", type: "number", value: value === null || value === undefined ? "" : value,
          onChange: function (e) { setValue(e.target.value); } });
      }
      if (field.type === "json") {
        return h("textarea", { className: "dshm-textarea", value: value === null || value === undefined ? "" : JSON.stringify(value, null, 2),
          onChange: function (e) { var raw = e.target.value; try { setValue(raw.trim() ? JSON.parse(raw) : []); } catch (err) { setValue(raw); } } });
      }
      if (field.type === "list") {
        var display = Array.isArray(value) ? value.join(",") : (value || "");
        return h("input", { className: "dshm-input", type: "text", value: display,
          onChange: function (e) { setValue(e.target.value); } });
      }
      if (field.secret) {
        return h("input", { className: "dshm-input", type: "password", placeholder: redacted ? "已设置，留空保持不变" : "",
          value: typeof value === "string" ? value : "", onChange: function (e) { setValue(e.target.value); } });
      }
      return h("input", { className: "dshm-input", type: "text", value: value === null || value === undefined ? "" : String(value),
        onChange: function (e) { setValue(e.target.value); } });
    }

    function SetupDialog(props) {
      var platformId = props.platformId;
      var setPlatformId = props.setPlatformId;
      var payload = props.payload;   // { platforms, values }
      var status = props.status;     // { platforms: [{id, connected}] }
      var onSaved = props.onSaved;
      var onClose = props.onClose;

      var meta = payload && payload.platforms ? payload.platforms[platformId] : null;
      var current = payload && payload.values ? payload.values["messaging-" + platformId] || {} : {};
      var connectedMap = {};
      if (status && status.platforms) {
        for (var i = 0; i < status.platforms.length; i += 1) {
          connectedMap[status.platforms[i].id] = Boolean(status.platforms[i].connected);
        }
      }

      var initialForm = {};
      var initialRedacted = {};
      if (meta) {
        for (var fi = 0; fi < meta.fields.length; fi += 1) {
          var f = meta.fields[fi];
          var existing = current[f.key];
          var isRedacted = existing && typeof existing === "object" && existing.__redacted__;
          if (f.secret && isRedacted) {
            initialForm[f.key] = "";
            initialRedacted[f.key] = true;
          } else if (f.type === "list") {
            initialForm[f.key] = Array.isArray(existing) ? existing : [];
          } else if (f.type === "bool") {
            initialForm[f.key] = existing === undefined || existing === null ? Boolean(f.default) : Boolean(existing);
          } else if (f.type === "number") {
            initialForm[f.key] = existing === undefined || existing === null ? (f.default === null ? "" : f.default) : existing;
          } else if (f.type === "json") {
            initialForm[f.key] = existing === undefined || existing === null ? (f.default || []) : existing;
          } else if (f.secret) {
            initialForm[f.key] = isRedacted ? "" : (existing || "");
          } else {
            initialForm[f.key] = existing === undefined || existing === null ? (f.default === null ? "" : f.default) : existing;
          }
        }
      }

      var formState = useState(initialForm);
      var redactedState = useState(initialRedacted);
      var form = formState[0];
      var setForm = formState[1];
      var redactedKeys = redactedState[0];
      var setRedacted = redactedState[1];
      var noticeState = useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var qrState = useState(null); // null | { taskId, status, message, qrImage }
      var qr = qrState[0];
      var setQr = qrState[1];
      var qrBusyState = useState(false);
      var qrBusy = qrBusyState[0];
      var setQrBusy = qrBusyState[1];

      // Re-sync the form whenever the server payload changes (manual save or
      // QR auth saved new credentials server-side).
      useEffect(function () {
        var rebuilt = {};
        var redone = {};
        if (meta) {
          for (var i = 0; i < meta.fields.length; i += 1) {
            var field = meta.fields[i];
            var existing = current[field.key];
            var isRedacted = existing && typeof existing === "object" && existing.__redacted__;
            if (field.secret && isRedacted) {
              rebuilt[field.key] = "";
              redone[field.key] = true;
            } else if (field.type === "list") {
              rebuilt[field.key] = Array.isArray(existing) ? existing : [];
            } else if (field.type === "bool") {
              rebuilt[field.key] = existing === undefined || existing === null ? Boolean(field.default) : Boolean(existing);
            } else if (field.type === "number") {
              rebuilt[field.key] = existing === undefined || existing === null ? (field.default === null ? "" : field.default) : existing;
            } else if (field.type === "json") {
              rebuilt[field.key] = existing === undefined || existing === null ? (field.default || []) : existing;
            } else if (field.secret) {
              rebuilt[field.key] = isRedacted ? "" : (existing || "");
            } else {
              rebuilt[field.key] = existing === undefined || existing === null ? (field.default === null ? "" : field.default) : existing;
            }
          }
        }
        setForm(rebuilt);
        setRedacted(redone);
      }, [payload]);

      // Poll the QR task while one is active; stops on done/expired/error.
      useEffect(function () {
        if (!qr || !qr.taskId) return;
        var stopped = false;
        var timer = setInterval(function () {
          if (stopped) return;
          fetch("/messaging/qr/status?task=" + encodeURIComponent(qr.taskId), { headers: { accept: "application/json" } })
            .then(function (r) { return r.json(); })
            .then(function (json) {
              if (stopped || !json || !json.ok) return;
              if (json.status === "done") {
                stopped = true;
                clearInterval(timer);
                setQr({ taskId: json.taskId, status: "done", message: json.message, qrImage: json.qrImage });
                if (onSaved) onSaved();
                setTimeout(function () { setQr(null); }, 2500);
              } else if (json.status === "expired" || json.status === "error") {
                stopped = true;
                clearInterval(timer);
                setQr({ taskId: json.taskId, status: json.status, message: json.message, qrImage: json.qrImage });
              } else {
                setQr({ taskId: json.taskId, status: json.status, message: json.message, qrImage: json.qrImage });
              }
            })
            .catch(function () { /* keep polling */ });
        }, 2500);
        return function () { stopped = true; clearInterval(timer); };
      }, [qr && qr.taskId]);

      function startQr() {
        if (!meta || !meta.qr || qrBusy || qr) return;
        setQrBusy(true);
        setNotice(null);
        fetch("/messaging/qr/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: platformId }),
        }).then(function (r) { return r.json(); }).then(function (json) {
          if (json && json.ok) {
            setQr({ taskId: json.taskId, status: "pending", message: "等待扫码…", qrImage: json.qrImage });
          } else {
            setNotice("发起扫码失败：" + ((json && json.error) || "未知错误"));
          }
        }).catch(function (e) {
          setNotice("发起扫码失败：" + String(e && e.message ? e.message : e));
        }).finally(function () { setQrBusy(false); });
      }

      function setField(key, value) {
        var next = {};
        for (var k in form) next[k] = form[k];
        next[key] = value;
        setForm(next);
      }

      function save() {
        if (!meta || saving) return;
        setSaving(true);
        setNotice(null);
        var patch = {};
        for (var i = 0; i < meta.fields.length; i += 1) {
          var field = meta.fields[i];
          var value = form[field.key];
          if (field.secret && value === "" && redactedKeys[field.key]) continue; // untouched
          if (field.type === "list") {
            patch[field.key] = typeof value === "string"
              ? value.split(",").map(function (s) { return s.trim(); }).filter(Boolean)
              : (value || []);
          } else if (field.type === "bool") {
            patch[field.key] = value === true || value === "true";
          } else {
            patch[field.key] = value;
          }
        }
        fetch("/messaging/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: platformId, patch: patch }),
        }).then(function (r) { return r.json(); }).then(function (json) {
          if (json && json.ok) {
            setNotice("已保存 ✓");
            if (onSaved) onSaved();
          } else {
            setNotice("保存失败：" + ((json && json.error) || "未知错误"));
          }
        }).catch(function (e) {
          setNotice("保存失败：" + String(e && e.message ? e.message : e));
        }).finally(function () { setSaving(false); });
      }

      var platformIds = payload && payload.platforms ? Object.keys(payload.platforms) : [];
      var connected = connectedMap[platformId] === true;

      return h("div", { className: "dshm-panel", onClick: function (e) { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "dshm-box" },
          h("div", { className: "dshm-head" },
            h("div", null, "消息平台"),
            h("button", { className: "dshm-close", onClick: onClose, "aria-label": "关闭" }, "✕")
          ),
          h("div", { className: "dshm-body" },
            h("div", { className: "dshm-list" },
              platformIds.map(function (id) {
                var isActive = id === platformId;
                var dotColor = connectedMap[id] === true ? "#3fb950" : "#f85149";
                return h("button", {
                  key: id,
                  className: "dshm-plat",
                  "data-active": String(isActive),
                  onClick: function () { setPlatformId(id); setNotice(null); setQr(null); },
                },
                  h("span", { className: "dshm-dot", style: { background: dotColor } }),
                  h("span", null, payload.platforms[id].label)
                );
              })
            ),
            h("div", { className: "dshm-content" },
              !meta
                ? h("div", { className: "dshm-note" }, "加载中…")
                : h("div", null,
                    h("div", { className: "dshm-note" },
                      meta.note || "",
                      h("span", { style: { marginLeft: 8 } }, connected ? "● 已连接" : "○ 未连接")
                    ),
                    qr
                      ? h("div", { className: "dshm-qr" },
                          qr.qrImage
                            ? h("img", { src: qr.qrImage, alt: "扫码授权", width: 240, height: 240 })
                            : null,
                          h("div", { className: "dshm-qr-status" }, qr.message || "…"),
                          (qr.status === "expired" || qr.status === "error")
                            ? h("div", { className: "dshm-qr-actions" },
                                h("button", { className: "dshm-btn", onClick: function () { setQr(null); } }, "关闭"),
                                h("button", { className: "dshm-btn", "data-primary": "true", onClick: startQr }, "重新发起"))
                            : h("button", { className: "dshm-btn", onClick: function () { setQr(null); } }, "取消")
                        )
                      : h("div", null,
                          meta.qr
                            ? h("button", { className: "dshm-btn dshm-qr-start", onClick: startQr, disabled: qrBusy },
                                qrBusy ? "发起中…" : "📱 扫码授权")
                            : null,
                          meta.fields.map(function (field) {
                            return h("div", { key: field.key, className: "dshm-field" },
                              h("div", { className: "dshm-label" },
                                field.label + (field.required ? " *" : "") + (field.secret ? "（秘密字段）" : "")
                              ),
                              h(FieldInput, {
                                field: field,
                                value: form[field.key],
                                redacted: Boolean(redactedKeys[field.key]),
                                setValue: function (v) { setField(field.key, v); },
                              })
                            );
                          }),
                          notice
                            ? h("div", { className: notice.indexOf("失败") >= 0 ? "dshm-err" : "dshm-msg" }, notice)
                            : null
                        )
                  )
            )
          ),
          h("div", { className: "dshm-savebar" },
            h("button", { className: "dshm-btn", onClick: onClose }, "关闭"),
            h("button", { className: "dshm-btn", "data-primary": "true", disabled: saving || !meta, onClick: save },
              saving ? "保存中…" : "保存")
          )
        )
      );
    }

    // ---------------------------------------------------------------- mount

    function apply(ctx) {
      ctx.effect(function () {
        var button = null;
        var host = null;
        var root = null;
        var dialogRoot = null;
        var probeTimer = null;
        var collapseObserver = null;
        var disposed = false;

        function openDialog() {
          if (dialogRoot !== null) return;
          var wrap = document.createElement("div");
          wrap.setAttribute("data-dsh-msg-dialog", "");
          document.body.appendChild(wrap);
          dialogRoot = ReactDOM.createRoot(wrap);
          var payload = null;
          var status = null;

          function reload() {
            return fetch("/messaging/config", { headers: { accept: "application/json" } })
              .then(function (r) { return r.json(); })
              .then(function (json) { payload = json; });
          }

          function reloadStatus() {
            return fetch("/messaging/status", { headers: { accept: "application/json" } })
              .then(function (r) { return r.json(); })
              .then(function (json) { status = json; });
          }

          var platformId = null;
          function renderDialog() {
            dialogRoot.render(h(SetupDialog, {
              platformId: platformId,
              setPlatformId: function (id) { platformId = id; renderDialog(); },
              payload: payload,
              status: status,
              onSaved: function () {
                Promise.all([reload(), reloadStatus()]).then(renderDialog);
              },
              onClose: function () {
                if (dialogRoot !== null) {
                  dialogRoot.unmount();
                  dialogRoot = null;
                  var leftover = document.querySelector("[data-dsh-msg-dialog]");
                  if (leftover) leftover.remove();
                }
              },
            }));
          }

          Promise.all([reload(), reloadStatus()]).then(function () {
            if (platformId === null && payload && payload.platforms) {
              var ids = Object.keys(payload.platforms);
              platformId = ids.length > 0 ? ids[0] : null;
            }
            renderDialog();
          }).catch(function (e) {
            if (dialogRoot !== null) {
              dialogRoot.unmount();
              dialogRoot = null;
              var leftover = document.querySelector("[data-dsh-msg-dialog]");
              if (leftover) leftover.remove();
            }
            var wrap2 = document.createElement("div");
            wrap2.setAttribute("data-dsh-msg-dialog", "");
            document.body.appendChild(wrap2);
            dialogRoot = ReactDOM.createRoot(wrap2);
            var closeErr = function () {
              if (dialogRoot !== null) {
                dialogRoot.unmount();
                dialogRoot = null;
                var l = document.querySelector("[data-dsh-msg-dialog]");
                if (l) l.remove();
              }
            };
            dialogRoot.render(h("div", { className: "dshm-panel", onClick: function (ev) { if (ev.target === ev.currentTarget) closeErr(); } },
              h("div", { className: "dshm-box" },
                h("div", { className: "dshm-head" }, "消息平台"),
                h("div", { className: "dshm-content" },
                  h("div", { className: "dshm-err" }, "加载配置失败：" + String(e && e.message ? e.message : e))
                )
              )
            ));
          });
        }

        function mountTrigger() {
          button = findNewSessionButton();
          var anchor = findAnchor();
          if (anchor === null || document.querySelector("[data-dsh-msg-host]") !== null) return;
          host = document.createElement("div");
          host.setAttribute("data-dsh-msg-host", "");
          // Mirror the sidebar root's flex-column layout so the cloned button
          // is stretched to the exact same width as the New Session button
          // (the original's width comes from the parent's align-items).
          host.style.cssText = "display:flex;flex-direction:column;align-items:stretch;min-height:0";
          anchor.parentNode.insertBefore(host, anchor.nextSibling);
          var collapsed = isCollapsed(button);
          // House-style messaging icon: a filled chat bubble with a tail,
          // drawn in the same 16x16 currentColor silhouette language as the
          // app's icons (the bundled "send" glyph is actually an up arrow).
          function buildMessageIcon(size) {
            var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", String(size));
            svg.setAttribute("height", String(size));
            svg.setAttribute("viewBox", "0 0 16 16");
            svg.setAttribute("fill", "none");
            svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
            svg.setAttribute("aria-hidden", "true");
            var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", "M3.25 1.75H12.75A2.25 2.25 0 0 1 15 4V9.5A2.25 2.25 0 0 1 12.75 11.75H8.4L5.9 14.4V11.75H3.25A2.25 2.25 0 0 1 1 9.5V4A2.25 2.25 0 0 1 3.25 1.75Z");
            path.setAttribute("fill", "currentColor");
            svg.appendChild(path);
            return svg;
          }
          var render = function () {
            // Plain-DOM render: React roots reject native DOM nodes, so the
            // trigger is managed directly inside the host container.
            while (host.firstChild) host.removeChild(host.firstChild);
            // Clone the native New Session button so the entry inherits its
            // exact look, layout, and collapsed-rail behavior.
            var tpl = findNewSessionButton();
            var el = null;
            if (tpl !== null) {
              try {
                el = tpl.cloneNode(true);
              } catch (err) { el = null; }
            }
            if (el === null || el.tagName !== "BUTTON") {
              // Fallback: plain styled button.
              el = document.createElement("button");
              el.type = "button";
              el.appendChild(buildMessageIcon(collapsed ? 18 : 14));
              var fallbackLabel = document.createElement("span");
              fallbackLabel.textContent = "消息平台";
              if (collapsed) fallbackLabel.style.display = "none";
              el.appendChild(fallbackLabel);
              el.style.cssText = "box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;height:38px;margin:0 2px 8px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2,#3a3f4b);border-radius:12px;font-size:14px;font-weight:500;line-height:22px;cursor:pointer;background:var(--dsw-alias-interactive-bg,#1d2230);color:inherit";
            } else {
              el.removeAttribute("onclick");
              // Replace the visible label text with our own while keeping the
              // button's icon/structure (skip SVG subtrees, which carry no
              // label text).
              var textNode = null;
              var walk = function (node) {
                if (textNode !== null || !node) return;
                var kids = node.childNodes;
                for (var i = 0; i < kids.length; i += 1) {
                  var child = kids[i];
                  if (child.nodeType === 3) {
                    if ((child.textContent || "").trim().length > 0) {
                      textNode = child;
                      return;
                    }
                  } else if (child.nodeType === 1 && child.tagName.toLowerCase() !== "svg") {
                    walk(child);
                  }
                }
              };
              walk(el);
              if (textNode !== null) {
                textNode.textContent = "消息平台";
              }
              el.setAttribute("aria-label", "消息平台");
              el.title = "消息平台";
              // Swap the New Session icon for a messaging-platform icon,
              // keeping the original SVG's size/class so it renders identically.
              var oldSvg = el.querySelector("svg");
              if (oldSvg !== null) {
                var svgSize = parseInt(oldSvg.getAttribute("width") || "16", 10) || 16;
                var freshSvg = buildMessageIcon(svgSize);
                if (typeof oldSvg.className === "string" && oldSvg.className !== "") {
                  freshSvg.setAttribute("class", oldSvg.className);
                }
                el.replaceChild(freshSvg, oldSvg);
              }
            }
            el.setAttribute("data-dsh-msg-trigger", "");
            el.onclick = openDialog;
            host.appendChild(el);
          };
          render();
          var rootEl = host && host.parentElement;
          if (rootEl !== null && rootEl !== undefined && typeof MutationObserver !== "undefined") {
            collapseObserver = new MutationObserver(function () {
              if (disposed) return;
              if (!document.contains(button)) return;
              var next = isCollapsed(button);
              if (next !== collapsed) {
                collapsed = next;
                render();
              }
            });
            collapseObserver.observe(rootEl, { attributes: true, attributeFilter: ["class"], subtree: true });
          }
        }

        probeTimer = setInterval(function () {
          if (disposed) return;
          if (host !== null && document.contains(host)) return;
          mountTrigger();
        }, 400);

        return function teardown() {
          disposed = true;
          if (probeTimer !== null) clearInterval(probeTimer);
          if (collapseObserver !== null) collapseObserver.disconnect();
          if (root !== null) root.unmount();
          if (host !== null && host.parentNode) host.parentNode.removeChild(host);
          if (dialogRoot !== null) {
            try {
              dialogRoot.unmount();
            } catch (err) { /* ignore */ }
            var leftover = document.querySelector("[data-dsh-msg-dialog]");
            if (leftover) leftover.remove();
          }
        };
      }, "messaging-core: sidebar mount");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  }
});
