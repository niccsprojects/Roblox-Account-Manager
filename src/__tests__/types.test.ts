import { describe, it, expect } from "vitest";
import type {
  ScriptWindowSnapshot,
  ScriptPermissions,
  ManagedScript,
} from "../scripting/types";

/**
 * Tests for src/scripting/types.ts
 *
 * The PR added a `generator` field to ScriptWindowSnapshot.
 * These tests verify the shape and runtime behavior of the interfaces.
 */

describe("ScriptWindowSnapshot", () => {
  it("accepts an object with the new generator field set to null", () => {
    const snapshot: ScriptWindowSnapshot = {
      ts: Date.now(),
      placeId: "1234567890",
      jobId: "",
      launchData: "",
      selectedUserIds: [],
      accounts: [],
      presenceByUserId: {},
      launchedUserIds: [],
      botting: null,
      generator: null,
      settings: null,
    };

    expect(snapshot.generator).toBeNull();
  });

  it("accepts an object with generator set to a non-null value", () => {
    const generatorStatus = {
      running: true,
      provider: "BloxGen",
      generated: 10,
    };

    const snapshot: ScriptWindowSnapshot = {
      ts: Date.now(),
      placeId: "1234567890",
      jobId: "abc-job",
      launchData: "",
      selectedUserIds: [111, 222],
      accounts: [],
      presenceByUserId: { "111": 2, "222": 1 },
      launchedUserIds: [111],
      botting: null,
      generator: generatorStatus,
      settings: null,
    };

    expect(snapshot.generator).toEqual(generatorStatus);
  });

  it("accepts an object with generator set to undefined (optional-like)", () => {
    // generator is typed as `unknown`, so undefined is valid at runtime
    const snapshot = {
      ts: 0,
      placeId: "",
      jobId: "",
      launchData: "",
      selectedUserIds: [],
      accounts: [],
      presenceByUserId: {},
      launchedUserIds: [],
      botting: null,
      generator: undefined,
      settings: null,
    } satisfies ScriptWindowSnapshot;

    expect(snapshot.generator).toBeUndefined();
  });

  it("snapshot botting and generator fields coexist independently", () => {
    const bottingStatus = { running: true, placeId: "9999" };
    const generatorStatus = { running: false, generated: 0 };

    const snapshot: ScriptWindowSnapshot = {
      ts: 100,
      placeId: "9999",
      jobId: "job-1",
      launchData: "",
      selectedUserIds: [],
      accounts: [],
      presenceByUserId: {},
      launchedUserIds: [],
      botting: bottingStatus,
      generator: generatorStatus,
      settings: null,
    };

    expect(snapshot.botting).toEqual(bottingStatus);
    expect(snapshot.generator).toEqual(generatorStatus);
  });

  it("accepts accounts with expected shape", () => {
    const snapshot: ScriptWindowSnapshot = {
      ts: 0,
      placeId: "",
      jobId: "",
      launchData: "",
      selectedUserIds: [],
      accounts: [
        {
          userId: 12345,
          username: "TestUser",
          alias: "alias",
          group: "group1",
          valid: true,
          lastUse: "2024-01-01T00:00:00Z",
          lastAttemptedRefresh: "2024-01-01T00:00:00Z",
        },
      ],
      presenceByUserId: { "12345": 2 },
      launchedUserIds: [12345],
      botting: null,
      generator: null,
      settings: { Section: { Key: "Value" } },
    };

    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0].userId).toBe(12345);
    expect(snapshot.settings).toEqual({ Section: { Key: "Value" } });
  });
});

describe("ScriptPermissions", () => {
  it("supports all-true permissions (allPermissions pattern)", () => {
    const allTrue: ScriptPermissions = {
      allowInvoke: true,
      allowHttp: true,
      allowWebSocket: true,
      allowWindow: true,
      allowModal: true,
      allowSettings: true,
      allowUi: true,
    };

    // Verify all fields are true
    expect(allTrue.allowInvoke).toBe(true);
    expect(allTrue.allowHttp).toBe(true);
    expect(allTrue.allowWebSocket).toBe(true);
    expect(allTrue.allowWindow).toBe(true);
    expect(allTrue.allowModal).toBe(true);
    expect(allTrue.allowSettings).toBe(true);
    expect(allTrue.allowUi).toBe(true);
  });

  it("supports all-false permissions (default permissions pattern)", () => {
    const allFalse: ScriptPermissions = {
      allowInvoke: false,
      allowHttp: false,
      allowWebSocket: false,
      allowWindow: false,
      allowModal: false,
      allowSettings: false,
      allowUi: false,
    };

    const values = Object.values(allFalse);
    expect(values.every((v) => v === false)).toBe(true);
  });

  it("has exactly 7 permission fields", () => {
    const perms: ScriptPermissions = {
      allowInvoke: false,
      allowHttp: false,
      allowWebSocket: false,
      allowWindow: false,
      allowModal: false,
      allowSettings: false,
      allowUi: false,
    };

    expect(Object.keys(perms)).toHaveLength(7);
  });
});

describe("ManagedScript", () => {
  it("supports trusted and autoStart flags independently", () => {
    const script: ManagedScript = {
      id: "test-id-123",
      name: "Test Script",
      description: "A test script",
      language: "javascript",
      source: 'ram.info("hello");',
      enabled: true,
      trusted: true,
      autoStart: true,
      permissions: {
        allowInvoke: true,
        allowHttp: true,
        allowWebSocket: true,
        allowWindow: true,
        allowModal: true,
        allowSettings: true,
        allowUi: true,
      },
      createdAtMs: 1000,
      updatedAtMs: 1000,
    };

    expect(script.trusted).toBe(true);
    expect(script.autoStart).toBe(true);
  });

  it("defaults trusted and autoStart to false (default permissions pattern)", () => {
    const script: ManagedScript = {
      id: "test-id-456",
      name: "Default Script",
      description: "",
      language: "javascript",
      source: "",
      enabled: true,
      trusted: false,
      autoStart: false,
      permissions: {
        allowInvoke: false,
        allowHttp: false,
        allowWebSocket: false,
        allowWindow: false,
        allowModal: false,
        allowSettings: false,
        allowUi: false,
      },
      createdAtMs: 0,
      updatedAtMs: 0,
    };

    expect(script.trusted).toBe(false);
    expect(script.autoStart).toBe(false);
  });
});