import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  accountIdFor,
  EmbyAccountManager,
} = require("../electron/emby-account-manager.cjs");

class FakeEmbyService {
  constructor(audit) {
    this.audit = audit;
    this.session = undefined;
  }

  async login(input) {
    const address = new URL(input.serverUrl).toString();
    const host = new URL(address).hostname;
    this.session = {
      serverUrl: address,
      token: `token-${host}`,
      userId: `user-${host}`,
      username: input.username,
      serverName: `Server ${host}`,
      serverVersion: "4.9.0",
      insecure: address.startsWith("http:"),
    };
    return this.result();
  }

  result() {
    return {
      user: {
        id: this.session.userId,
        name: this.session.username,
      },
      server: {
        name: this.session.serverName,
        version: this.session.serverVersion,
        address: this.session.serverUrl,
        insecure: this.session.insecure,
      },
    };
  }

  exportSession() {
    return { ...this.session };
  }

  restoreSession(session) {
    this.session = { ...session };
    return this.result();
  }

  async validateSession() {
    const host = new URL(this.session.serverUrl).hostname;
    (this.audit.validations ||= []).push(host);
    if (this.audit.validationFailureHost === host) {
      throw new Error("saved token rejected");
    }
    return this.result();
  }

  async logout() {
    this.audit.logouts.push(this.session?.serverUrl);
    this.session = undefined;
  }

  async stopStream(reason) {
    this.audit.stops.push([this.session?.serverUrl, reason]);
    this.pipeline = undefined;
  }

  async updateEndpoints(input) {
    const urls = input.serverUrls.map((value) => new URL(value).toString());
    this.session = {
      ...this.session,
      serverId: "stable-server-id",
      serverUrl: urls[0],
      activeEndpointId: `endpoint-0`,
      endpoints: urls.map((url, index) => ({
        id: `endpoint-${index}`,
        url,
        label: index ? `备用线路 ${index}` : "主线路",
        priority: index,
      })),
    };
    return this.result();
  }

  async listViews() {
    return [];
  }

  async listItems(input) {
    const host = new URL(this.session.serverUrl).hostname;
    return {
      items: [
        {
          id: `movie-${host}`,
          name: `${input.searchTerm || "Movie"} ${host}`,
          type: "Movie",
        },
      ],
      total: 1,
    };
  }

  async imageData() {
    return `data:image/mock,${new URL(this.session.serverUrl).hostname}`;
  }

  async playbackInfo() {
    this.audit.playback.push(this.session?.serverUrl);
    return { mediaSources: [] };
  }

  async startStream() {
    this.audit.starts.push(this.session?.serverUrl);
    this.pipeline = {};
    return { pipelineId: "fake" };
  }

  setFlowPaused() {
    this.audit.flow.push(this.session?.serverUrl);
  }

  async reportPlayback() {
    this.audit.reports.push(this.session?.serverUrl);
  }
}

function createHarness(storagePath) {
  const audit = {
    logouts: [],
    stops: [],
    playback: [],
    starts: [],
    flow: [],
    reports: [],
    validations: [],
  };
  const options = {
    storagePath,
    createService: () => new FakeEmbyService(audit),
    encryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => {
      const encoded = value.toString("utf8");
      assert.match(encoded, /^sealed:/);
      return Buffer.from(encoded.slice(7), "base64").toString("utf8");
    },
  };
  return {
    audit,
    manager: new EmbyAccountManager(options),
    options,
  };
}

test("persists multiple encrypted Emby accounts and searches every server", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-accounts-"),
  );
  const storagePath = path.join(temporary, "accounts.json");
  try {
    const first = createHarness(storagePath);
    const alpha = await first.manager.login({
      serverUrl: "https://alpha.example:8920",
      username: "Alice",
      password: "never-store-this",
    });
    const beta = await first.manager.login({
      serverUrl: "https://beta.example:8920",
      username: "Bob",
      password: "also-never-store-this",
    });
    const state = first.manager.state();
    assert.equal(state.accounts.length, 2);
    assert.equal(state.activeAccountId, beta.id);
    assert.equal(state.persistence, "encrypted");

    const persisted = fs.readFileSync(storagePath, "utf8");
    assert.doesNotMatch(persisted, /token-alpha|token-beta/);
    assert.doesNotMatch(persisted, /never-store-this/);

    const restoredAudit = {
      logouts: [],
      stops: [],
      playback: [],
      starts: [],
      flow: [],
      reports: [],
    };
    const restored = new EmbyAccountManager({
      ...first.options,
      createService: () => new FakeEmbyService(restoredAudit),
    });
    assert.equal(restored.state().accounts.length, 2);
    assert.equal(restored.state().activeAccountId, beta.id);

    const search = await restored.searchAll({
      searchTerm: "Matrix",
      includeItemTypes: ["Movie"],
    });
    assert.equal(search.serverCount, 2);
    assert.equal(search.failedServers.length, 0);
    assert.equal(search.items.length, 2);
    assert.deepEqual(
      new Set(search.items.map((item) => item.accountId)),
      new Set([alpha.id, beta.id]),
    );
    assert.ok(search.items.every((item) => item.serverName));

    await restored.activate(alpha.id);
    assert.deepEqual(restoredAudit.validations, ["alpha.example"]);
    const activeItems = await restored.listItems({ searchTerm: "Alien" });
    assert.equal(activeItems.items[0].accountId, alpha.id);
    assert.match(
      await restored.imageData({
        accountId: beta.id,
        itemId: "movie-beta.example",
      }),
      /beta\.example/,
    );

    const remaining = await restored.removeActive();
    assert.equal(remaining.accounts.length, 1);
    assert.equal(remaining.activeAccountId, beta.id);
    assert.equal(restoredAudit.logouts.length, 1);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("activation verifies the saved token before changing the active account", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-activation-"),
  );
  try {
    const { manager, audit } = createHarness(
      path.join(temporary, "accounts.json"),
    );
    const alpha = await manager.login({
      serverUrl: "https://alpha.example",
      username: "Alice",
      password: "",
    });
    const beta = await manager.login({
      serverUrl: "https://beta.example",
      username: "Bob",
      password: "",
    });
    audit.validationFailureHost = "alpha.example";
    await assert.rejects(
      manager.activate(alpha.id),
      /saved token rejected/u,
    );
    assert.equal(manager.state().activeAccountId, beta.id);
    assert.deepEqual(audit.validations, ["alpha.example"]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("falls back to process-only accounts when OS encryption is unavailable", async () => {
  const audit = {
    logouts: [],
    stops: [],
    playback: [],
    starts: [],
    flow: [],
    reports: [],
  };
  const manager = new EmbyAccountManager({
    storagePath: "unused.json",
    createService: () => new FakeEmbyService(audit),
    encryptionAvailable: () => false,
  });
  await manager.login({
    serverUrl: "https://memory.example",
    username: "Viewer",
    password: "",
  });
  assert.equal(manager.state().persistence, "session-only");
  assert.equal(manager.state().accounts.length, 1);
});

test("media operations stay bound to the selected account across active-account races", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-account-routing-"),
  );
  try {
    const { manager, audit } = createHarness(
      path.join(temporary, "accounts.json"),
    );
    const alpha = await manager.login({
      serverUrl: "https://alpha.example",
      username: "Alice",
      password: "",
    });
    const beta = await manager.login({
      serverUrl: "https://beta.example",
      username: "Bob",
      password: "",
    });
    assert.equal(manager.state().activeAccountId, beta.id);

    await manager.playbackInfo({
      accountId: alpha.id,
      itemId: "movie-alpha",
      quality: "1080p-8",
    });
    await manager.startStream({
      accountId: alpha.id,
      itemId: "movie-alpha",
      quality: "1080p-8",
    });
    manager.setFlowPaused(true);
    await manager.reportPlayback({ action: "progress", positionTicks: 0 });

    assert.ok(audit.playback.at(-1).includes("alpha.example"));
    assert.ok(audit.starts.at(-1).includes("alpha.example"));
    assert.ok(audit.flow.at(-1).includes("alpha.example"));
    assert.ok(audit.reports.at(-1).includes("alpha.example"));
    await assert.rejects(
      manager.activate(beta.id),
      /放映期间不能切换 Emby 账户/u,
    );
    await manager.stopStream("test-finished");
    assert.ok(audit.stops.at(-1)[0].includes("alpha.example"));

    const alphaService = manager.serviceFor(alpha.id);
    let releaseLateStart;
    let markLateStartEntered;
    const lateStartEntered = new Promise((resolve) => {
      markLateStartEntered = resolve;
    });
    alphaService.startStream = async () => {
      markLateStartEntered();
      return new Promise((resolve) => {
        releaseLateStart = resolve;
      });
    };
    const lateStart = manager.startStream({
      accountId: alpha.id,
      itemId: "movie-alpha",
      quality: "1080p-8",
    });
    await lateStartEntered;
    await manager.stopStream("start-timeout");
    releaseLateStart({ pipelineId: "late" });
    await assert.rejects(lateStart, /已被停止或替代/u);
    assert.ok(audit.stops.at(-1)[0].includes("alpha.example"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("upgrading a legacy account to Server Id routes migrates its account id", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-route-migration-"),
  );
  const storagePath = path.join(temporary, "accounts.json");
  try {
    const first = createHarness(storagePath);
    const legacy = await first.manager.login({
      serverUrl: "https://primary.example/emby",
      username: "Alice",
      password: "",
    });
    const upgraded = await first.manager.updateEndpoints(legacy.id, {
      serverUrls: [
        "https://primary.example/emby",
        "https://backup.example/emby",
      ],
      allowInsecure: false,
    });
    assert.notEqual(upgraded.id, legacy.id);
    assert.equal(first.manager.state().activeAccountId, upgraded.id);
    assert.equal(first.manager.state().accounts.length, 1);

    const restored = createHarness(storagePath);
    assert.equal(restored.manager.state().accounts.length, 1);
    assert.equal(restored.manager.state().activeAccountId, upgraded.id);
    assert.doesNotMatch(
      fs.readFileSync(storagePath, "utf8"),
      /token-primary/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("loads and rewrites a v1 encrypted account whose Server Id changes its identity", async () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "synced-emby-v1-identity-"),
  );
  const storagePath = path.join(temporary, "accounts.json");
  try {
    const first = createHarness(storagePath);
    const legacy = await first.manager.login({
      serverUrl: "https://legacy.example/emby",
      username: "Alice",
      password: "",
    });
    const stored = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    const sealed = Buffer.from(stored.accounts[0].secret, "base64");
    const session = JSON.parse(first.options.decryptString(sealed));
    session.serverId = "stable-server-id-after-upgrade";
    const migratedId = accountIdFor(session);
    assert.notEqual(migratedId, legacy.id);
    stored.version = 1;
    stored.activeAccountId = legacy.id;
    stored.accounts[0].secret = first.options
      .encryptString(JSON.stringify(session))
      .toString("base64");
    fs.writeFileSync(storagePath, JSON.stringify(stored));

    const restored = createHarness(storagePath);
    assert.equal(restored.manager.state().accounts.length, 1);
    assert.equal(restored.manager.state().activeAccountId, migratedId);
    const rewritten = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    assert.equal(rewritten.version, 2);
    assert.equal(rewritten.activeAccountId, migratedId);
    assert.equal(rewritten.accounts[0].id, migratedId);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
