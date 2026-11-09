/* Small, framework-free state helpers shared by the WebView UI. */
(function (root) {
  "use strict";

  function machine(name, initial, transitions) {
    let state = initial;
    let revision = 0;

    function transition(event, value) {
      const table = transitions[state] || {};
      if (!Object.prototype.hasOwnProperty.call(table, event)) {
        return { ok: false, name, event, from: state, to: state, revision };
      }
      const next = typeof table[event] === "function" ? table[event](value, state) : table[event];
      if (next == null || next === false) {
        return { ok: false, name, event, from: state, to: state, revision };
      }
      const from = state;
      state = next;
      revision++;
      return { ok: true, name, event, from, to: state, revision, value };
    }

    return Object.freeze({
      get state() { return state; },
      get revision() { return revision; },
      is(value) { return state === value; },
      can(event) { return Object.prototype.hasOwnProperty.call(transitions[state] || {}, event); },
      transition,
      reset(value = initial) { state = value; revision++; return state; },
      snapshot() { return { name, state, revision }; }
    });
  }

  function gate(name) {
    let token = 0;
    return Object.freeze({
      get current() { return token; },
      begin() { token++; return token; },
      cancel() { token++; return token; },
      isCurrent(value) { return value === token; },
      snapshot() { return { name, token }; }
    });
  }

  // A gate is intentionally tiny: it gives every asynchronous flow a monotonic
  // generation without making the rendering layer aware of promises or AbortController.
  // A result may update the UI only while its generation is current.
  function request(name) {
    let serial = 0;
    let active = 0;
    let currentValue;
    return Object.freeze({
      get current() { return active; },
      get value() { return currentValue; },
      begin(value) { active = ++serial; currentValue = value === undefined ? active : value; return { id: active, value: currentValue }; },
      cancel() { active = ++serial; currentValue = undefined; return active; },
      isCurrent(value) { return !!value && (typeof value === "object" ? value.id : value) === active; },
      snapshot() { return { name, id: active }; }
    });
  }

  root.ShuState = Object.freeze({ machine, gate, request });
}(window));
