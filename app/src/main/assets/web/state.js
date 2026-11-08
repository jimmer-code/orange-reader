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

  root.ShuState = Object.freeze({ machine, gate });
}(window));
