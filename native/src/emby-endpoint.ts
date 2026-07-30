export type EmbyEndpointProtocol = "https" | "http";

export interface EmbyEndpointDraft {
  protocol: EmbyEndpointProtocol;
  host: string;
  port: string;
  path: string;
}

function defaultPort(protocol: EmbyEndpointProtocol): string {
  return protocol === "https" ? "443" : "80";
}

function normalizedPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function parseEmbyEndpointInput(
  input: string,
  fallbackProtocol: EmbyEndpointProtocol = "https",
): EmbyEndpointDraft {
  const value = input.trim();
  if (!value) {
    return {
      protocol: fallbackProtocol,
      host: "",
      port: defaultPort(fallbackProtocol),
      path: "",
    };
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `${fallbackProtocol}://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("服务器地址格式无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("服务器线路只支持 HTTP 或 HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("请不要把用户名或密码写进服务器地址");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("服务器地址不应包含查询参数或片段");
  }
  const protocol = parsed.protocol.slice(0, -1) as EmbyEndpointProtocol;
  if (!parsed.hostname) throw new Error("服务器地址缺少主机名");
  return {
    protocol,
    host: parsed.hostname,
    port: parsed.port || defaultPort(protocol),
    path: normalizedPath(parsed.pathname),
  };
}

export function composeEmbyEndpoint(draft: EmbyEndpointDraft): string {
  const protocol: EmbyEndpointProtocol =
    draft.protocol === "http" ? "http" : "https";
  const host = draft.host.trim();
  if (!host) throw new Error("请填写服务器地址");
  if (/[\s/@?#]/.test(host)) throw new Error("服务器地址中包含无效字符");
  const port = draft.port.trim() || defaultPort(protocol);
  const portNumber = Number(port);
  if (
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65_535
  ) {
    throw new Error("服务器端口必须在 1–65535 之间");
  }
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const parsed = new URL(
    `${protocol}://${authority}:${portNumber}${normalizedPath(draft.path)}`,
  );
  return parsed.toString().replace(/\/$/, "");
}

export function endpointDefaultPort(
  protocol: EmbyEndpointProtocol,
): string {
  return defaultPort(protocol);
}
