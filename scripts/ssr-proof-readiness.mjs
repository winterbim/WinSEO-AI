function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function hasApiListenMarker(output) {
  return output.includes("API server listening");
}

export function hasNextListenMarker(output, port) {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const localUrl = new RegExp(
    `- Local:\\s+http://(?:localhost|127\\.0\\.0\\.1):${escapedPort}(?:\\s|$)`,
  );
  return localUrl.test(stripAnsi(output));
}
