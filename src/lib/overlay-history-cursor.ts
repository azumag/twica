/**
 * Normalize the public overlay history timestamp accepted by `/events`.
 *
 * This function is shared by the API, browser transport, and reload snapshot
 * reader. A looser browser-only `Date.parse` check is unsafe: it can accept a
 * value that the API rejects forever, pinning every later recovery request at
 * HTTP 400. PostgreSQL's signed-offset/microsecond wire format is handled
 * explicitly and returned as canonical UTC without truncating microseconds.
 */
export function normalizeOverlayHistoryTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-]| )(\d{2}):(\d{2}))$/,
  );
  if (!match) return null;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = "",
    timezone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  // PostgreSQL represents years before 1 CE with a separate BC suffix. Keep
  // this public cursor grammar to four-digit, non-BC database values.
  if (year < 1) return null;

  // Date stores only milliseconds, so keep the authoritative fraction outside
  // it. `setUTCFullYear` also avoids Date.UTC's 0-99 -> 1900-1999 remapping.
  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);
  // Date setters normalize invalid calendar values (for example February 30),
  // therefore compare every component before accepting a public cursor.
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHours = Number(offsetHourText);
    const offsetMinutePart = Number(offsetMinuteText);
    if (offsetHours > 23 || offsetMinutePart > 59) return null;
    // URLSearchParams can expose a literal `+` as a space. Only the strict
    // timezone-sign position accepts that representation.
    offsetMinutes =
      (offsetSign === "-" ? -1 : 1)
      * (offsetHours * 60 + offsetMinutePart);
  }

  const utcDate = new Date(localDate.getTime() - offsetMinutes * 60_000);
  const utcYear = utcDate.getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null;
  const utcWholeSecond = utcDate.toISOString().slice(0, 19);
  return `${utcWholeSecond}${fraction ? `.${fraction}` : ""}Z`;
}
