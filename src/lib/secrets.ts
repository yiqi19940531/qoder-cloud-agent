export function redactSecrets(message: string) {
  let safe = message;
  for (const value of [process.env.QODER_ACCESS_TOKEN, process.env.APIFY_API_TOKEN]) {
    if (value && value.length > 8) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
}
