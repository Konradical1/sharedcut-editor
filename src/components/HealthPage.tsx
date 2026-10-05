import { useEffect, useState } from 'react';
import { api, ApiError } from '../services/api';
import { formatAgo, hostFacts, keyNumbers, lightLabel, sparklineSegments, splitPeople } from '../services/playbackReport';
import type { Fact } from '../services/playbackReport';
import type { HealthSummary, HostHealth, PersonHealth } from '../services/playbackReportTypes';

const POLL_MS = 10_000;
const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;
const DEFAULT_TARGET_FPS = 30;

type Load = { summary: HealthSummary | null; unavailable: boolean; failed: boolean };

/** Reads the owner-only summary every ten seconds while mounted. 403 and 404 mean "not for you": stop asking. */
function useHealthSummary(): Load {
  const [load, setLoad] = useState<Load>({ summary: null, unavailable: false, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      let again = true;
      try {
        const summary = await api<HealthSummary>('/health/report', { signal: controller.signal });
        setLoad({ summary, unavailable: false, failed: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) { again = false; setLoad({ summary: null, unavailable: true, failed: false }); }
        else setLoad(previous => ({ ...previous, failed: true }));
      }
      if (again && !controller.signal.aborted) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, []);
  return load;
}

function Facts({ facts }: { facts: Fact[] }) {
  return <dl className="health-facts">{facts.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Sparkline({ person }: { person: PersonHealth }) {
  // A grey minute had no playing in it: leave a gap there, never a zero.
  const values = person.recent.map(minute => minute.light === 'grey' ? null : minute.fps);
  const played = values.filter((value): value is number => value !== null);
  const target = person.latest?.targetFps ?? DEFAULT_TARGET_FPS;
  const segments = sparklineSegments(values, SPARK_WIDTH, SPARK_HEIGHT, target);
  if (!segments.length) return <span className="health-spark-empty muted">{values.length > 1 ? 'Not playing' : 'No history yet'}</span>;
  const label = `Pictures per second over the last ${values.length} minutes (idle minutes left out), from ${Math.round(Math.min(...played))} to ${Math.round(Math.max(...played))} of ${Math.round(target)}`;
  return <svg className="health-spark" width={SPARK_WIDTH} height={SPARK_HEIGHT} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} role="img" aria-label={label}>{segments.map(points => <polyline key={points} points={points} fill="none" />)}</svg>;
}

function PersonRow({ person, now }: { person: PersonHealth; now: number }) {
  return <li className="health-person" data-light={person.light}>
    <div className="health-person-head">
      <span className="health-dot" aria-hidden="true" />
      <strong>{person.name}</strong>
      <span className="health-light">{lightLabel(person.light)}</span>
      <span className="health-seen muted">{person.online ? 'Online' : 'Offline'}, last seen {formatAgo(now - person.lastSeenAt)}</span>
    </div>
    <p className="health-sentence">{person.sentence}</p>
    <div className="health-person-detail">
      <Facts facts={keyNumbers(person.latest)} />
      <Sparkline person={person} />
    </div>
  </li>;
}

function HostCard({ host }: { host: HostHealth }) {
  return <section className="health-host" aria-labelledby="health-host-title"><h4 id="health-host-title">Host computer</h4><Facts facts={hostFacts(host)} /></section>;
}

function PeopleList({ people, now, label }: { people: PersonHealth[]; now: number; label: string }) {
  return <ul className="health-people" aria-label={label}>{people.map(person => <PersonRow key={`${person.userId}:${person.clientId}`} person={person} now={now} />)}</ul>;
}

export default function HealthPage() {
  const { summary, unavailable, failed } = useHealthSummary();
  const { real, harness } = splitPeople(summary?.people ?? []);
  return <section className="health-page" aria-labelledby="health-title">
    <h3 id="health-title">Playback health</h3>
    {unavailable && <p className="health-note" role="status">Not available</p>}
    {!unavailable && !summary && <p className="health-note" role="status">{failed ? 'Could not reach the server.' : 'Loading…'}</p>}
    {summary && <>
      {failed && <p className="health-note" role="status">Could not reach the server. Showing the last numbers.</p>}
      <HostCard host={summary.host} />
      {real.length ? <PeopleList people={real} now={summary.generatedAt} label="People" /> : <p className="health-note">Nobody has reported yet.</p>}
      {harness.length > 0 && <details className="health-harness"><summary>Test runs ({harness.length})</summary><PeopleList people={harness} now={summary.generatedAt} label="Test runs" /></details>}
    </>}
  </section>;
}
