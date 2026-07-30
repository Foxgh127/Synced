const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const STORE_VERSION = 2;
const MAX_STORE_BYTES = 1024 * 1024;

function cleanText(value, limit = 256) {
  return String(value || "").trim().slice(0, limit);
}

function accountIdFor(session) {
  const serverIdentity = cleanText(session.serverId, 160)
    ? `server:${cleanText(session.serverId, 160)}`
    : String(session.serverUrl || "");
  return createHash("sha256")
    .update(`${serverIdentity}\0${session.userId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function legacyAccountIdFor(session) {
  return createHash("sha256")
    .update(`${String(session.serverUrl || "")}\0${session.userId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function sessionEndpointUrls(session) {
  const values =
    Array.isArray(session?.endpoints) && session.endpoints.length
      ? session.endpoints.map((endpoint) => endpoint?.url)
      : [session?.serverUrl];
  return new Set(
    values
      .map((value) => {
        try {
          return new URL(String(value || "")).toString();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
}

function publicAccount(record) {
  return {
    id: record.id,
    user: { ...record.user },
    server: { ...record.server },
    lastUsedAt: record.lastUsedAt,
  };
}

class EmbyAccountManager {
  constructor(options = {}) {
    if (typeof options.createService !== "function") {
      throw new TypeError("createService is required");
    }
    this.createService = options.createService;
    this.storagePath = cleanText(options.storagePath, 4_096);
    this.encryptString =
      typeof options.encryptString === "function"
        ? options.encryptString
        : undefined;
    this.decryptString =
      typeof options.decryptString === "function"
        ? options.decryptString
        : undefined;
    this.encryptionAvailable =
      typeof options.encryptionAvailable === "function"
        ? options.encryptionAvailable
        : () => Boolean(this.encryptString && this.decryptString);
    this.records = new Map();
    this.services = new Map();
    this.activeAccountId = undefined;
    this.streamingAccountId = undefined;
    this.streamOperationGeneration = 0;
    this.load();
  }

  canPersist() {
    try {
      return Boolean(
        this.storagePath &&
          this.encryptString &&
          this.decryptString &&
          this.encryptionAvailable(),
      );
    } catch {
      return false;
    }
  }

  state() {
    return {
      accounts: [...this.records.values()]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map(publicAccount),
      activeAccountId: this.activeAccountId,
      persistence: this.canPersist() ? "encrypted" : "session-only",
    };
  }

  load() {
    if (!this.canPersist()) return;
    let raw;
    try {
      const stat = fs.statSync(this.storagePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STORE_BYTES) {
        return;
      }
      raw = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
    } catch {
      return;
    }
    if (![1, STORE_VERSION].includes(raw?.version) || !Array.isArray(raw.accounts)) {
      return;
    }
    const migratedIds = new Map();
    let migratedLegacyStore = false;
    for (const saved of raw.accounts.slice(0, 24)) {
      try {
        const encrypted = Buffer.from(cleanText(saved?.secret, 32_768), "base64");
        if (!encrypted.length || encrypted.length > 16_384) continue;
        const session = JSON.parse(this.decryptString(encrypted));
        const id = accountIdFor(session);
        const savedId = cleanText(saved?.id, 64);
        const legacyId = legacyAccountIdFor(session);
        if (
          id !== savedId &&
          !(raw.version === 1 && legacyId === savedId)
        ) {
          continue;
        }
        if (id !== savedId) {
          migratedIds.set(savedId, id);
          migratedLegacyStore = true;
        }
        const service = this.createService();
        const login = service.restoreSession(session);
        this.records.set(id, {
          id,
          user: login.user,
          server: login.server,
          session,
          lastUsedAt: Math.max(0, Number(saved?.lastUsedAt) || 0),
        });
        this.services.set(id, service);
      } catch {
        // One corrupt or expired local record must not hide other accounts.
      }
    }
    const storedActive = cleanText(raw.activeAccountId, 64);
    const requestedActive = migratedIds.get(storedActive) || storedActive;
    if (this.records.has(requestedActive)) {
      this.activeAccountId = requestedActive;
    } else {
      this.activeAccountId = this.state().accounts[0]?.id;
    }
    if (migratedLegacyStore) {
      try {
        this.persist();
      } catch {
        // The migrated in-memory account remains usable for this process.
      }
    }
  }

  persist() {
    if (!this.canPersist()) return false;
    const accounts = [];
    for (const record of this.records.values()) {
      const encrypted = this.encryptString(JSON.stringify(record.session));
      if (!Buffer.isBuffer(encrypted) || encrypted.length > 16_384) {
        throw new Error("Emby 登录信息加密失败");
      }
      accounts.push({
        id: record.id,
        lastUsedAt: record.lastUsedAt,
        secret: encrypted.toString("base64"),
      });
    }
    const payload = JSON.stringify(
      {
        version: STORE_VERSION,
        activeAccountId: this.activeAccountId,
        accounts,
      },
      null,
      2,
    );
    if (Buffer.byteLength(payload) > MAX_STORE_BYTES) {
      throw new Error("Emby 本地账户数据异常过大");
    }
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.storagePath);
    return true;
  }

  serviceFor(accountId) {
    const id = cleanText(accountId, 64);
    const record = this.records.get(id);
    if (!record) throw new Error("找不到已保存的 Emby 账户");
    let service = this.services.get(id);
    if (!service) {
      service = this.createService();
      service.restoreSession(record.session);
      this.services.set(id, service);
    }
    return service;
  }

  activeService() {
    if (!this.activeAccountId) throw new Error("请先登录 Emby");
    return this.serviceFor(this.activeAccountId);
  }

  async login(input) {
    const service = this.createService();
    const login = await service.login(input);
    const session = service.exportSession();
    const id = accountIdFor(session);
    const nextUrls = sessionEndpointUrls(session);
    for (const [existingId, record] of [...this.records]) {
      if (
        existingId === id ||
        record.session?.userId !== session.userId
      ) {
        continue;
      }
      const sameEntry = [...sessionEndpointUrls(record.session)].some(
        (url) => nextUrls.has(url),
      );
      if (!sameEntry) continue;
      await this.services
        .get(existingId)
        ?.stopStream("account-upgraded")
        .catch(() => undefined);
      this.records.delete(existingId);
      this.services.delete(existingId);
      if (this.activeAccountId === existingId) {
        this.activeAccountId = undefined;
      }
    }
    const previous = this.services.get(id);
    if (previous && previous !== service) {
      await previous.logout().catch(() => undefined);
    }
    const record = {
      id,
      user: login.user,
      server: login.server,
      session,
      lastUsedAt: Date.now(),
    };
    this.records.set(id, record);
    this.services.set(id, service);
    this.activeAccountId = id;
    try {
      this.persist();
    } catch {
      // The active session remains usable even if OS encryption is unavailable.
    }
    return publicAccount(record);
  }

  async activate(accountId) {
    const id = cleanText(accountId, 64);
    const record = this.records.get(id);
    if (!record) throw new Error("找不到已保存的 Emby 账户");
    if (
      this.streamingAccountId &&
      this.streamingAccountId !== id
    ) {
      throw new Error("放映期间不能切换 Emby 账户，请先停止当前放映");
    }
    const service = this.serviceFor(id);
    const verified =
      typeof service.validateSession === "function"
        ? await service.validateSession()
        : (await service.listViews(), undefined);
    const session = service.exportSession();
    if (verified?.user) record.user = { ...verified.user };
    if (verified?.server) record.server = { ...verified.server };
    record.session = session;
    record.lastUsedAt = Date.now();
    this.activeAccountId = id;
    try {
      this.persist();
    } catch {
      // Activation still succeeds for this process.
    }
    return publicAccount(record);
  }

  async removeActive() {
    const id = this.activeAccountId;
    if (!id) return this.state();
    const service = this.services.get(id) || this.serviceFor(id);
    await service.logout().catch(() => undefined);
    if (this.streamingAccountId === id) {
      this.streamingAccountId = undefined;
    }
    this.services.delete(id);
    this.records.delete(id);
    this.activeAccountId = this.state().accounts[0]?.id;
    try {
      this.persist();
    } catch {
      // The in-memory removal is still authoritative for this process.
    }
    return this.state();
  }

  async updateEndpoints(accountId, input) {
    const id = cleanText(accountId || this.activeAccountId, 64);
    const record = this.records.get(id);
    if (!record) throw new Error("找不到已保存的 Emby 账户");
    const service = this.serviceFor(id);
    const login = await service.updateEndpoints(input);
    const session = service.exportSession();
    const nextId = accountIdFor(session);
    const nextRecord = {
      ...record,
      id: nextId,
      session,
      server: login.server,
      user: login.user,
      lastUsedAt: Date.now(),
    };
    if (nextId !== id) {
      const replacedService = this.services.get(nextId);
      if (replacedService && replacedService !== service) {
        await replacedService
          .stopStream("account-routes-merged")
          .catch(() => undefined);
      }
      this.records.delete(id);
      this.services.delete(id);
      this.records.set(nextId, nextRecord);
      this.services.set(nextId, service);
      if (this.activeAccountId === id || this.activeAccountId === nextId) {
        this.activeAccountId = nextId;
      }
      if (this.streamingAccountId === id) {
        this.streamingAccountId = nextId;
      }
    } else {
      this.records.set(id, nextRecord);
    }
    try {
      this.persist();
    } catch {
      // Updated routes remain active for this process.
    }
    return publicAccount(nextRecord);
  }

  listViews(input = {}) {
    return this.serviceFor(
      input.accountId || this.activeAccountId,
    ).listViews();
  }

  async listItems(input = {}) {
    const id = cleanText(input.accountId || this.activeAccountId, 64);
    const record = this.records.get(id);
    const result = await this.serviceFor(id).listItems(input);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        accountId: id,
        serverName: record?.server.name,
      })),
    };
  }

  imageData(input = {}) {
    return this.serviceFor(input.accountId || this.activeAccountId).imageData(
      input,
    );
  }

  playbackInfo(input = {}) {
    return this.serviceFor(
      input.accountId || this.activeAccountId,
    ).playbackInfo(input);
  }

  async startStream(input = {}) {
    const generation = ++this.streamOperationGeneration;
    const id = cleanText(input.accountId || this.activeAccountId, 64);
    const service = this.serviceFor(id);
    if (this.streamingAccountId && this.streamingAccountId !== id) {
      await this.serviceFor(this.streamingAccountId)
        .stopStream("replaced")
        .catch(() => undefined);
      this.streamingAccountId = undefined;
    }
    this.streamingAccountId = id;
    try {
      const result = await service.startStream(input);
      if (generation !== this.streamOperationGeneration) {
        await service.stopStream("stale-start").catch(() => undefined);
        throw new Error("Emby 启动请求已被停止或替代");
      }
      return result;
    } catch (error) {
      if (
        generation === this.streamOperationGeneration &&
        this.streamingAccountId === id &&
        !service.pipeline
      ) {
        this.streamingAccountId = undefined;
      }
      throw error;
    }
  }

  async stopStream(reason, expectedPipelineId) {
    const id = this.streamingAccountId || this.activeAccountId;
    if (!id) return;
    const service = this.serviceFor(id);
    const expected = cleanText(expectedPipelineId, 128);
    if (expected && service.pipeline?.id !== expected) return;
    const generation = ++this.streamOperationGeneration;
    try {
      await service.stopStream(reason, {
        expectedPipelineId: expected || undefined,
      });
    } finally {
      if (
        generation === this.streamOperationGeneration &&
        this.streamingAccountId === id
      ) {
        this.streamingAccountId = undefined;
      }
    }
  }

  setFlowPaused(paused, expectedPipelineId) {
    const id = this.streamingAccountId || this.activeAccountId;
    if (id) {
      this.serviceFor(id).setFlowPaused(
        paused,
        cleanText(expectedPipelineId, 128) || undefined,
      );
    }
  }

  reportPlayback(input) {
    const id = this.streamingAccountId || this.activeAccountId;
    if (!id) return Promise.resolve();
    return this.serviceFor(id).reportPlayback(input);
  }

  async searchAll(input = {}) {
    const searchTerm = cleanText(input.searchTerm, 160);
    if (!searchTerm) {
      throw new Error("请输入要跨服务器搜索的内容");
    }
    const limit = Math.min(240, Math.max(1, Number(input.limit) || 120));
    const records = [...this.records.values()];
    const settled = await Promise.allSettled(
      records.map(async (record) => {
        const result = await this.serviceFor(record.id).listItems({
          ...input,
          parentId: undefined,
          searchTerm,
          startIndex: 0,
          limit: Math.min(60, limit),
        });
        return {
          record,
          total: result.total,
          items: result.items.map((item) => ({
            ...item,
            accountId: record.id,
            serverName: record.server.name,
          })),
        };
      }),
    );
    const items = [];
    let total = 0;
    const failedServers = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "fulfilled") {
        total += result.value.total;
        items.push(...result.value.items);
      } else {
        failedServers.push(records[index].server.name);
      }
    }
    const query = searchTerm.toLocaleLowerCase("zh-CN");
    items.sort((left, right) => {
      const leftName = cleanText(left.name, 300).toLocaleLowerCase("zh-CN");
      const rightName = cleanText(right.name, 300).toLocaleLowerCase("zh-CN");
      const leftRank = leftName === query ? 0 : leftName.startsWith(query) ? 1 : 2;
      const rightRank =
        rightName === query ? 0 : rightName.startsWith(query) ? 1 : 2;
      return (
        leftRank - rightRank ||
        leftName.localeCompare(rightName, "zh-CN", { numeric: true })
      );
    });
    return {
      items: items.slice(0, limit),
      total,
      serverCount: records.length,
      failedServers,
    };
  }

  async destroy() {
    await Promise.allSettled(
      [...this.services.values()].map((service) =>
        service.stopStream("app-quit"),
      ),
    );
    this.services.clear();
  }
}

module.exports = {
  accountIdFor,
  EmbyAccountManager,
  legacyAccountIdFor,
  sessionEndpointUrls,
};
