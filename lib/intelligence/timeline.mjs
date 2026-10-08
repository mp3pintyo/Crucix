// Threat timeline: the located events the entity store holds, counted per UTC day for the last seven days and split by threat level (critical, high, watch, info),
// with a simple trend label. The panel idea (a seven-day stacked view of the threat levels and a worsening / easing / steady label) comes from World Monitor
// (koala73/worldmonitor, docs/panels/threat-timeline.mdx); the computation is Crucix's own and runs on the store, nothing extra is persisted.
// The count is of LOCATED events that were linked to a country (mode 'l'), by the event's own observation time when it has one; today is a partial day.
// The trend compares the three complete days before today with the three before those, on critical plus high events: worsening when the recent mean is at least
// one event a day and 25% higher, easing when it is at least one a day and 20% lower, else steady. Nothing is said before the store has watched three days.
import { refTime } from './entities.mjs';

const DAY = 86400000;
export const TIMELINE = Object.freeze({ days: 7, minObservedDays: 3, minDiff: 1, worsening: 1.25, easing: 0.8 });
const LEVELS = ['critical', 'high', 'watch', 'info'];
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

/** `{ ready, observedDays, days: [{ day, critical, high, watch, info }], trend }`, days oldest first and the last one is today (UTC). */
export function computeTimeline(store, now) {
  const observedDays = Math.floor(store.observedDays(now));
  const first = Math.floor(now / DAY) * DAY - (TIMELINE.days - 1) * DAY;
  const days = Array.from({ length: TIMELINE.days }, (_, i) => ({ day: new Date(first + i * DAY).toISOString().slice(0, 10), critical: 0, high: 0, watch: 0, info: 0 }));
  for (const ref of store.events.values()) {
    if (ref.m !== 'l') continue;
    const index = Math.floor((refTime(ref) - first) / DAY);
    if (index < 0 || index >= TIMELINE.days) continue;
    days[index][LEVELS.includes(ref.l) ? ref.l : 'info']++;
  }
  const ready = observedDays >= TIMELINE.minObservedDays;
  let trend = null;
  if (ready) {
    const severe = days.map(d => d.critical + d.high);
    const recent = mean(severe.slice(3, 6)), earlier = mean(severe.slice(0, 3));
    trend = recent - earlier >= TIMELINE.minDiff && recent >= earlier * TIMELINE.worsening ? 'worsening'
      : earlier - recent >= TIMELINE.minDiff && recent <= earlier * TIMELINE.easing ? 'easing' : 'steady';
  }
  return { ready, observedDays, days, trend };
}
