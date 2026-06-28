const NETWORK_SETUP = "/usr/sbin/networksetup";
const ROUTE = "/sbin/route";
const NETSTAT = "/usr/sbin/netstat";
const PORT = Number(Bun.env.PORT ?? 4327);
const STATE_FILE = new URL("./.proxy-state.json", import.meta.url);
const ENFORCE_INTERVAL_MS = 5000;
const TRAFFIC_HISTORY_LIMIT = 60;

type ProxyStatus = {
  enabled: boolean;
  server: string;
  port: number | null;
};

type ServiceStatus = {
  service: string;
  http: ProxyStatus;
  https: ProxyStatus;
};

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type DesiredProxyState = {
  enabled: boolean;
  service: string;
  host: string;
  port: string;
};

type InterfaceBytes = {
  name: string;
  receivedBytes: number;
  sentBytes: number;
};

type TrafficPoint = {
  time: number;
  receivedBytesPerSecond: number;
  sentBytesPerSecond: number;
};

let lastInterfaceBytes: (InterfaceBytes & { time: number }) | null = null;
let trafficHistory: TrafficPoint[] = [];

function json<T>(payload: ApiResponse<T>, status = 200) {
  return Response.json(payload, { status });
}

async function readDesiredState(): Promise<DesiredProxyState | null> {
  const file = Bun.file(STATE_FILE);
  if (!(await file.exists())) return null;

  try {
    const state = await file.json();
    if (
      typeof state.enabled === "boolean" &&
      typeof state.service === "string" &&
      typeof state.host === "string" &&
      typeof state.port === "string"
    ) {
      return state;
    }
  } catch {
    return null;
  }

  return null;
}

async function writeDesiredState(state: DesiredProxyState) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function runNetworkSetup(args: string[]) {
  return runCommand(NETWORK_SETUP, args);
}

async function runCommand(command: string, args: string[]) {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `networksetup exited with ${exitCode}`).trim());
  }

  return stdout.trim();
}

function cleanServiceName(line: string) {
  return line.replace(/^\*\s*/, "").trim();
}

function isVisibleService(service: string) {
  return /^wi-?fi$/i.test(service);
}

async function listServices() {
  const output = await runNetworkSetup(["-listallnetworkservices"]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("An asterisk"))
    .map(cleanServiceName)
    .filter(isVisibleService);
}

function parseProxy(output: string): ProxyStatus {
  const lines = output.split("\n");
  const value = (label: string) => {
    const line = lines.find((item) => item.toLowerCase().startsWith(label.toLowerCase()));
    return line?.split(":").slice(1).join(":").trim() ?? "";
  };

  const enabled = value("Enabled").toLowerCase() === "yes";
  const server = value("Server");
  const portText = value("Port");
  const port = portText ? Number(portText) : null;

  return {
    enabled,
    server,
    port: Number.isFinite(port) ? port : null
  };
}

async function serviceStatus(service: string): Promise<ServiceStatus> {
  const [http, https] = await Promise.all([
    runNetworkSetup(["-getwebproxy", service]).then(parseProxy),
    runNetworkSetup(["-getsecurewebproxy", service]).then(parseProxy)
  ]);

  return { service, http, https };
}

function proxyMatches(status: ServiceStatus, host: string, port: string) {
  return (
    status.http.enabled &&
    status.https.enabled &&
    status.http.server === host &&
    status.https.server === host &&
    String(status.http.port) === port &&
    String(status.https.port) === port
  );
}

async function enableSystemProxy(service: string, host: string, port: string) {
  await runNetworkSetup(["-setwebproxy", service, host, port]);
  await runNetworkSetup(["-setsecurewebproxy", service, host, port]);
  await runNetworkSetup(["-setwebproxystate", service, "on"]);
  await runNetworkSetup(["-setsecurewebproxystate", service, "on"]);
}

async function disableSystemProxy(service: string) {
  await runNetworkSetup(["-setwebproxystate", service, "off"]);
  await runNetworkSetup(["-setsecurewebproxystate", service, "off"]);
}

async function enforceDesiredProxy() {
  const desired = await readDesiredState();
  if (!desired?.enabled) return;

  const services = await listServices();
  if (!services.includes(desired.service)) return;

  const status = await serviceStatus(desired.service);
  if (!proxyMatches(status, desired.host, desired.port)) {
    await enableSystemProxy(desired.service, desired.host, desired.port);
  }
}

setInterval(() => {
  enforceDesiredProxy().catch((error) => {
    console.error("系统代理自动恢复失败:", error instanceof Error ? error.message : error);
  });
}, ENFORCE_INTERVAL_MS);

enforceDesiredProxy().catch(() => {});

function validateService(service: unknown, services: string[]) {
  if (typeof service !== "string" || !service.trim()) {
    throw new Error("请选择网络服务");
  }
  if (!services.includes(service)) {
    throw new Error("网络服务不存在");
  }
  return service;
}

function validateHost(host: unknown) {
  if (typeof host !== "string") {
    throw new Error("代理地址不合法");
  }
  const value = host.trim();
  if (!/^[a-zA-Z0-9.-]+$/.test(value) || value.length > 253) {
    throw new Error("代理地址只能包含字母、数字、点和横线");
  }
  return value;
}

function validatePort(port: unknown) {
  const value = typeof port === "number" ? port : Number(String(port ?? ""));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("端口必须是 1-65535 的整数");
  }
  return String(value);
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("请求 JSON 不合法");
  }
}

async function handleApi(request: Request, pathname: string) {
  if (request.method === "GET" && pathname === "/api/services") {
    const services = await listServices();
    const preferred = services.find((item) => item.toLowerCase() === "wi-fi") ?? services[0] ?? "";
    const status = preferred ? await serviceStatus(preferred) : null;
    const desired = await readDesiredState();
    return json({ ok: true, data: { services, preferred, status, desired } });
  }

  if (request.method === "GET" && pathname === "/api/status") {
    const url = new URL(request.url);
    const services = await listServices();
    const service = validateService(url.searchParams.get("service"), services);
    const status = await serviceStatus(service);
    const desired = await readDesiredState();
    return json({ ok: true, data: { status, desired } });
  }

  if (request.method === "POST" && pathname === "/api/proxy") {
    const body = await readJson(request);
    const services = await listServices();
    const service = validateService(body.service, services);
    const host = validateHost(body.host);
    const port = validatePort(body.port);

    await enableSystemProxy(service, host, port);
    await writeDesiredState({ enabled: true, service, host, port });

    return json({ ok: true, data: await serviceStatus(service) });
  }

  if (request.method === "POST" && pathname === "/api/proxy/off") {
    const body = await readJson(request);
    const services = await listServices();
    const service = validateService(body.service, services);

    await disableSystemProxy(service);
    const current = await readDesiredState();
    await writeDesiredState({
      enabled: false,
      service,
      host: current?.host ?? "",
      port: current?.port ?? ""
    });

    return json({ ok: true, data: await serviceStatus(service) });
  }

  return json({ ok: false, error: "API 不存在" }, 404);
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, url.pathname);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        400
      );
    }
  }
});

console.log(`系统代理控制台已启动: http://localhost:${server.port}`);

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>系统代理控制台</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #667085;
        --line: #d9dee7;
        --blue: #2563eb;
        --green: #138a52;
        --red: #c83d3d;
        --shadow: 0 10px 24px rgba(28, 39, 49, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        letter-spacing: 0;
      }

      main {
        width: min(880px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        font-weight: 760;
      }

      .status-pill {
        min-width: 96px;
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 999px;
        padding: 8px 12px;
        text-align: center;
        color: var(--muted);
        font-size: 13px;
        font-weight: 680;
      }

      .status-pill.on {
        border-color: rgba(19, 138, 82, 0.24);
        color: var(--green);
        background: #eefaf3;
      }

      .status-pill.off {
        border-color: rgba(200, 61, 61, 0.22);
        color: var(--red);
        background: #fff2f2;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        padding: 20px;
      }

      .grid {
        display: grid;
        grid-template-columns: 1.2fr 1fr 160px;
        gap: 14px;
        align-items: end;
      }

      label {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 680;
      }

      input,
      select {
        width: 100%;
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--text);
        padding: 0 12px;
        font: inherit;
        outline: none;
      }

      input:focus,
      select:focus {
        border-color: var(--blue);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13);
      }

      .actions {
        display: flex;
        gap: 10px;
        margin-top: 18px;
        flex-wrap: wrap;
      }

      button {
        min-height: 40px;
        border: 1px solid transparent;
        border-radius: 6px;
        padding: 0 14px;
        font: inherit;
        font-size: 14px;
        font-weight: 720;
        cursor: pointer;
      }

      button.primary {
        background: var(--blue);
        color: #fff;
      }

      button.secondary {
        background: #fff;
        color: var(--text);
        border-color: var(--line);
      }

      button.danger {
        background: #fff;
        color: var(--red);
        border-color: rgba(200, 61, 61, 0.32);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }

      .details {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .item {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px;
        background: #fbfcfe;
      }

      .item-title {
        color: var(--muted);
        font-size: 12px;
        font-weight: 760;
        text-transform: uppercase;
        margin-bottom: 8px;
      }

      .item-value {
        font-size: 15px;
        font-weight: 720;
        overflow-wrap: anywhere;
      }

      .message {
        min-height: 22px;
        margin-top: 14px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      .message.error {
        color: var(--red);
      }

      .message.ok {
        color: var(--green);
      }

      @media (max-width: 760px) {
        main {
          width: min(100vw - 24px, 880px);
          padding-top: 20px;
        }

        header {
          align-items: flex-start;
          flex-direction: column;
        }

        .grid,
        .details {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>系统代理控制台</h1>
        <div id="statusPill" class="status-pill">读取中</div>
      </header>

      <section class="panel">
        <div class="grid">
          <label>
            网络服务
            <select id="service"></select>
          </label>
          <label>
            代理地址
            <input id="host" value="100.0.0.1" autocomplete="off" />
          </label>
          <label>
            端口
            <input id="port" value="7810" inputmode="numeric" autocomplete="off" />
          </label>
        </div>

        <div class="actions">
          <button id="enableBtn" class="primary">开启</button>
          <button id="disableBtn" class="danger">关闭</button>
          <button id="refreshBtn" class="secondary">刷新</button>
        </div>

        <div class="details">
          <div class="item">
            <div class="item-title">网页代理</div>
            <div id="httpValue" class="item-value">-</div>
          </div>
          <div class="item">
            <div class="item-title">安全网页代理</div>
            <div id="httpsValue" class="item-value">-</div>
          </div>
        </div>

        <div id="message" class="message"></div>
      </section>
    </main>

    <script>
      const els = {
        service: document.querySelector("#service"),
        host: document.querySelector("#host"),
        port: document.querySelector("#port"),
        statusPill: document.querySelector("#statusPill"),
        httpValue: document.querySelector("#httpValue"),
        httpsValue: document.querySelector("#httpsValue"),
        message: document.querySelector("#message"),
        enableBtn: document.querySelector("#enableBtn"),
        disableBtn: document.querySelector("#disableBtn"),
        refreshBtn: document.querySelector("#refreshBtn")
      };

      let busy = false;

      function setBusy(value) {
        busy = value;
        els.enableBtn.disabled = busy;
        els.disableBtn.disabled = busy;
        els.refreshBtn.disabled = busy;
        els.service.disabled = busy;
      }

      function setMessage(text, type = "") {
        els.message.textContent = text;
        els.message.className = "message " + type;
      }

      async function api(path, options) {
        const response = await fetch(path, options);
        const payload = await response.json();
        if (!payload.ok) throw new Error(payload.error || "请求失败");
        return payload.data;
      }

      function proxyText(item) {
        if (!item.enabled) return "关闭";
        return item.server && item.port ? item.server + ":" + item.port : "开启";
      }

      function renderStatus(status) {
        if (!status) return;
        const enabled = status.http.enabled && status.https.enabled;
        els.statusPill.textContent = enabled ? "已开启" : "已关闭";
        els.statusPill.className = "status-pill " + (enabled ? "on" : "off");
        els.httpValue.textContent = proxyText(status.http);
        els.httpsValue.textContent = proxyText(status.https);

        if (status.http.server) els.host.value = status.http.server;
        if (status.http.port) els.port.value = status.http.port;
      }

      function renderDesired(desired) {
        if (!desired?.enabled) return;
        if (desired.host) els.host.value = desired.host;
        if (desired.port) els.port.value = desired.port;
      }

      async function loadInitial() {
        setBusy(true);
        setMessage("");
        try {
          const data = await api("/api/services");
          els.service.innerHTML = "";
          for (const service of data.services) {
            const option = document.createElement("option");
            option.value = service;
            option.textContent = service;
            els.service.appendChild(option);
          }
          els.service.value = data.preferred;
          renderStatus(data.status);
          renderDesired(data.desired);
          setMessage(data.desired?.enabled ? "自动保持已开启" : "已刷新", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function refreshStatus() {
        if (!els.service.value) return;
        setBusy(true);
        setMessage("");
        try {
          const data = await api("/api/status?service=" + encodeURIComponent(els.service.value));
          renderStatus(data.status);
          renderDesired(data.desired);
          setMessage(data.desired?.enabled ? "自动保持已开启" : "已刷新", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function enableProxy() {
        setBusy(true);
        setMessage("");
        try {
          const status = await api("/api/proxy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              service: els.service.value,
              host: els.host.value,
              port: els.port.value
            })
          });
          renderStatus(status);
          setMessage("已开启，切换 Wi-Fi 后会自动补回", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      async function disableProxy() {
        setBusy(true);
        setMessage("");
        try {
          const status = await api("/api/proxy/off", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ service: els.service.value })
          });
          renderStatus(status);
          setMessage("已关闭，自动保持已停止", "ok");
        } catch (error) {
          setMessage(error.message, "error");
        } finally {
          setBusy(false);
        }
      }

      els.service.addEventListener("change", refreshStatus);
      els.refreshBtn.addEventListener("click", refreshStatus);
      els.enableBtn.addEventListener("click", enableProxy);
      els.disableBtn.addEventListener("click", disableProxy);

      loadInitial();
    </script>
  </body>
</html>`;
