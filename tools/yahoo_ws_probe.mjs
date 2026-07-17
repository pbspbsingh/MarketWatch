#!/usr/bin/env node

const ENDPOINT = "wss://streamer.finance.yahoo.com/?version=2";
const HEARTBEAT_MS = 15_000;

const fields = new Map([
  [1, ["id", "string"]],
  [2, ["price", "float"]],
  [3, ["time", "sint64"]],
  [4, ["currency", "string"]],
  [5, ["exchange", "string"]],
  [6, ["quoteType", "int"]],
  [7, ["marketHours", "int"]],
  [8, ["changePercent", "float"]],
  [9, ["dayVolume", "sint64"]],
  [10, ["dayHigh", "float"]],
  [11, ["dayLow", "float"]],
  [12, ["change", "float"]],
  [13, ["shortName", "string"]],
  [14, ["expireDate", "sint64"]],
  [15, ["openPrice", "float"]],
  [16, ["previousClose", "float"]],
  [17, ["strikePrice", "float"]],
  [18, ["underlyingSymbol", "string"]],
  [19, ["openInterest", "sint64"]],
  [20, ["optionsType", "sint64"]],
  [21, ["miniOption", "sint64"]],
  [22, ["lastSize", "sint64"]],
  [23, ["bid", "float"]],
  [24, ["bidSize", "sint64"]],
  [25, ["ask", "float"]],
  [26, ["askSize", "sint64"]],
  [27, ["priceHint", "sint64"]],
  [28, ["vol24hr", "sint64"]],
  [29, ["volAllCurrencies", "sint64"]],
  [30, ["fromCurrency", "string"]],
  [31, ["lastMarket", "string"]],
  [32, ["circulatingSupply", "double"]],
  [33, ["marketCap", "double"]],
]);

function parseArgs(argv) {
  const options = {
    durationSeconds: 30,
    unsubscribe: undefined,
    unsubscribeAfterSeconds: 10,
    symbols: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--duration") {
      options.durationSeconds = Number(argv[++index]);
    } else if (value === "--unsubscribe") {
      options.unsubscribe = argv[++index]?.toUpperCase();
    } else if (value === "--unsubscribe-after") {
      options.unsubscribeAfterSeconds = Number(argv[++index]);
    } else if (value === "--help") {
      console.log(
        "Usage: node tools/yahoo_ws_probe.mjs [--duration 30] " +
        "[--unsubscribe SYMBOL] [--unsubscribe-after 10] SYMBOL...",
      );
      process.exit(0);
    } else {
      options.symbols.push(value.toUpperCase());
    }
  }
  options.symbols = [...new Set(options.symbols.filter(Boolean))];
  if (options.symbols.length === 0) throw new Error("at least one symbol is required");
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) {
    throw new Error("--duration must be positive");
  }
  if (
    !Number.isFinite(options.unsubscribeAfterSeconds) ||
    options.unsubscribeAfterSeconds <= 0
  ) {
    throw new Error("--unsubscribe-after must be positive");
  }
  if (options.unsubscribe !== undefined && !options.symbols.includes(options.unsubscribe)) {
    throw new Error("--unsubscribe symbol must be included in the subscription list");
  }
  return options;
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = BigInt(buffer[cursor++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return [value, cursor];
    shift += 7n;
    if (shift > 70n) throw new Error("invalid protobuf varint");
  }
  throw new Error("truncated protobuf varint");
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value.toString();
}

function decodeValue(buffer, offset, wireType, type) {
  if (wireType === 0) {
    const [raw, next] = readVarint(buffer, offset);
    const value = type === "sint64" ? (raw >> 1n) ^ -(raw & 1n) : raw;
    return [safeNumber(value), next];
  }
  if (wireType === 2) {
    const [length, contentOffset] = readVarint(buffer, offset);
    const end = contentOffset + Number(length);
    if (end > buffer.length) throw new Error("truncated protobuf field");
    return [buffer.toString("utf8", contentOffset, end), end];
  }
  if (wireType === 5 && type === "float") {
    return [buffer.readFloatLE(offset), offset + 4];
  }
  if (wireType === 1 && type === "double") {
    return [buffer.readDoubleLE(offset), offset + 8];
  }
  throw new Error(`unsupported protobuf field: wire=${wireType}, type=${type}`);
}

function skipUnknown(buffer, offset, wireType) {
  if (wireType === 0) return readVarint(buffer, offset)[1];
  if (wireType === 1) return offset + 8;
  if (wireType === 2) {
    const [length, contentOffset] = readVarint(buffer, offset);
    return contentOffset + Number(length);
  }
  if (wireType === 5) return offset + 4;
  throw new Error(`unsupported protobuf wire type ${wireType}`);
}

function decodePricingData(base64) {
  const buffer = Buffer.from(base64, "base64");
  const result = {};
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, valueOffset] = readVarint(buffer, offset);
    offset = valueOffset;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    const definition = fields.get(fieldNumber);
    if (definition === undefined) {
      offset = skipUnknown(buffer, offset, wireType);
      continue;
    }
    const [name, type] = definition;
    [result[name], offset] = decodeValue(buffer, offset, wireType, type);
  }
  return result;
}

function send(socket, command) {
  const payload = JSON.stringify(command);
  socket.send(payload);
  console.log(JSON.stringify({ direction: "send", payload, time: new Date().toISOString() }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const activeSymbols = new Set(options.symbols);
  const counts = new Map(options.symbols.map((symbol) => [symbol, 0]));
  const messagesAfterUnsubscribe = new Map();
  let unsubscribeTime;
  let failure;

  const socket = new WebSocket(ENDPOINT);
  socket.addEventListener("open", () => {
    console.log(JSON.stringify({ event: "open", time: new Date().toISOString() }));
    send(socket, { subscribe: [...activeSymbols] });
  });
  socket.addEventListener("message", (event) => {
    try {
      const envelope = JSON.parse(String(event.data));
      const pricing = decodePricingData(envelope.message ?? "");
      const symbol = pricing.id;
      if (typeof symbol === "string") {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
        if (
          unsubscribeTime !== undefined &&
          symbol === options.unsubscribe &&
          Date.now() >= unsubscribeTime
        ) {
          messagesAfterUnsubscribe.set(symbol, (messagesAfterUnsubscribe.get(symbol) ?? 0) + 1);
        }
      }
      console.log(JSON.stringify({ event: "pricing", pricing }));
    } catch (error) {
      failure = error;
      console.error(`message decode failed: ${error.message}`);
    }
  });
  socket.addEventListener("error", (event) => {
    failure ??= new Error(event.message || "WebSocket error");
  });
  socket.addEventListener("close", (event) => {
    console.log(
      JSON.stringify({ event: "close", code: event.code, reason: event.reason }),
    );
  });

  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN && activeSymbols.size > 0) {
      send(socket, { subscribe: [...activeSymbols] });
    }
  }, HEARTBEAT_MS);

  let unsubscribeTimer;
  if (options.unsubscribe !== undefined) {
    unsubscribeTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      activeSymbols.delete(options.unsubscribe);
      unsubscribeTime = Date.now();
      send(socket, { unsubscribe: [options.unsubscribe] });
    }, options.unsubscribeAfterSeconds * 1000);
  }

  await new Promise((resolve) => setTimeout(resolve, options.durationSeconds * 1000));
  clearInterval(heartbeat);
  if (unsubscribeTimer !== undefined) clearTimeout(unsubscribeTimer);
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, "probe complete");
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(
    JSON.stringify({
      event: "summary",
      endpoint: ENDPOINT,
      heartbeatSeconds: HEARTBEAT_MS / 1000,
      counts: Object.fromEntries(counts),
      messagesAfterUnsubscribe: Object.fromEntries(messagesAfterUnsubscribe),
    }),
  );
  if (failure !== undefined) throw failure;
}

main().catch((error) => {
  console.error(`WebSocket probe failed: ${error.message}`);
  process.exitCode = 1;
});
