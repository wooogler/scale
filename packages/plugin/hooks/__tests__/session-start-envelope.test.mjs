/**
 * The SessionStart hook's OUTPUT CONTRACT (WP-C).
 *
 * Two audiences share one JSON object and they are not interchangeable:
 * `hookSpecificOutput.additionalContext` reaches Claude, `systemMessage`
 * reaches the human. Getting the nesting wrong is silent — the field is simply
 * ignored and nobody ever sees the viewer URL — so the shape is pinned here.
 *
 * The hook script itself is not exercised (it spawns a CLI); the envelope
 * builder it delegates to is pure, which is the whole reason it lives in
 * lib/scale.mjs rather than inline.
 */
import { describe, it, expect } from "vitest";

import { buildSessionStartEnvelope } from "../lib/scale.mjs";

const URL_ = "http://localhost:4318";
const ready = { initialized: true, memory: { present: true, components: 7 } };

describe("buildSessionStartEnvelope — the shape", () => {
  it("puts additionalContext under hookSpecificOutput and systemMessage at the top level", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "SCALE: 7 territories",
      viewer: { url: URL_ },
      setup: ready,
    });
    expect(e.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(e.hookSpecificOutput.additionalContext).toContain("SCALE: 7 territories");
    expect(typeof e.systemMessage).toBe("string");
    expect(e.hookSpecificOutput.systemMessage).toBeUndefined();
  });

  it("is null when there is nothing at all to say", () => {
    expect(
      buildSessionStartEnvelope({ source: "startup", context: "", viewer: null, setup: null }),
    ).toBeNull();
  });
});

describe("buildSessionStartEnvelope — the viewer URL", () => {
  it("appends the viewer line to the context Claude reads", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "SCALE: 7 territories",
      viewer: { url: URL_ },
      setup: ready,
    });
    expect(e.hookSpecificOutput.additionalContext).toContain(`Map viewer: ${URL_}`);
    expect(e.hookSpecificOutput.additionalContext).toContain("/scale-open");
  });

  it("does not repeat a URL `scale context` already printed", () => {
    const context = `SCALE: 7 territories\nMap viewer: ${URL_} — /scale-open opens it.`;
    const e = buildSessionStartEnvelope({
      source: "startup",
      context,
      viewer: { url: URL_ },
      setup: ready,
    });
    expect(e.hookSpecificOutput.additionalContext).toBe(context);
  });

  it("falls back to the URL from `setup status` when `serve ensure` gave none", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "",
      viewer: null,
      setup: { ...ready, viewer: { url: "http://localhost:4319", running: true } },
    });
    expect(e.systemMessage).toContain("http://localhost:4319");
  });

  it("strips the API token before the URL reaches Claude or the banner", () => {
    // `serve ensure --json` answers with the URL a BROWSER needs; off loopback
    // that carries a bearer token for a server that writes config and holds API
    // keys, and both fields here are transcript.
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "SCALE: 7 territories",
      viewer: { url: "http://192.168.1.20:4318/?token=sekrit" },
      setup: ready,
    });
    expect(JSON.stringify(e)).not.toContain("token=");
    expect(e.hookSpecificOutput.additionalContext).toContain(
      "Map viewer: http://192.168.1.20:4318/",
    );
    expect(e.systemMessage).toContain("http://192.168.1.20:4318/");
  });

  it("says nothing to the user when no URL could be resolved at all", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "SCALE: 7 territories",
      viewer: null,
      setup: null,
    });
    expect(e.systemMessage).toBeUndefined();
    expect(e.hookSpecificOutput.additionalContext).toBe("SCALE: 7 territories");
  });
});

describe("buildSessionStartEnvelope — which banner", () => {
  it("nudges an un-set-up repo toward chat setup", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "",
      viewer: { url: URL_ },
      setup: { initialized: false, memory: { present: false } },
    });
    expect(e.systemMessage).toBe(
      `SCALE is not set up for this repo yet — run /scale-settings to set it up in chat (map viewer: ${URL_}).`,
    );
  });

  it("points at /scale-map when there is no coverage memory", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "",
      viewer: { url: URL_ },
      setup: { initialized: true, memory: { present: false, components: 0 } },
    });
    expect(e.systemMessage).toContain("/scale-map");
    expect(e.systemMessage).toContain(URL_);
  });

  it("is the plain one-liner once the repo is ready", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "",
      viewer: { url: URL_ },
      setup: ready,
    });
    expect(e.systemMessage).toBe(
      `SCALE · map viewer: ${URL_} · settings in chat: /scale-settings`,
    );
  });

  it("assumes a healthy repo when setup status could not be read", () => {
    const e = buildSessionStartEnvelope({
      source: "startup",
      context: "",
      viewer: { url: URL_ },
      setup: null,
    });
    expect(e.systemMessage).not.toContain("not set up");
    expect(e.systemMessage).not.toContain("/scale-map");
  });
});

describe("buildSessionStartEnvelope — when the user is spoken to", () => {
  for (const source of ["startup", "resume"]) {
    it(`shows the banner on ${source}`, () => {
      const e = buildSessionStartEnvelope({
        source,
        context: "x",
        viewer: { url: URL_ },
        setup: ready,
      });
      expect(e.systemMessage).toContain(URL_);
    });
  }

  // A compact/clear is a mid-session mechanic the junior did not ask SCALE
  // about; re-banner them there and the line stops being read anywhere.
  for (const source of ["clear", "compact", undefined]) {
    it(`stays silent on ${source ?? "an unknown source"} but still feeds Claude`, () => {
      const e = buildSessionStartEnvelope({
        source,
        context: "SCALE: 7 territories",
        viewer: { url: URL_ },
        setup: ready,
      });
      expect(e.systemMessage).toBeUndefined();
      expect(e.hookSpecificOutput.additionalContext).toContain("SCALE: 7 territories");
    });
  }
});
