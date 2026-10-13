import { useEffect, useMemo, useState } from 'react';
import { getEligibleDraftSensors, LocationApiError, suggestDraftCoverage } from '../../../entities/location-config/api/index.ts';
import type { DraftDetail, EligibleSensor, LocationDocument, TableCoverageSuggestion } from '../../../entities/location-config/model/types.ts';
import { coverageState, ownerSeatCount, proposedSensors } from '../../../features/location-editor/index.ts';

type LoadResult = { key: string; state: 'loading' } | { key: string; state: 'ready'; sensors: EligibleSensor[]; suggestions: TableCoverageSuggestion[] }
  | { key: string; state: 'error'; message: string };

/**
 * Read-only Review section, rendered by the shared wizard after the draft is
 * persisted. It loads current eligible sensors and advisory seat counts; the
 * parent callback returns to the editable Sensors step.
 * @example <SensorCoverageSummary draft={draft} document={document} onEdit={() => onStep('sensors')} />
 */
export function SensorCoverageSummary({ draft, document, onEdit }: { draft: DraftDetail; document: LocationDocument; onEdit(): void }) {
  const [result, setResult] = useState<LoadResult | null>(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([draft.draftId, draft.draftRevision, document.widthCm, document.heightCm, document.outline, document.zones, document.tables, document.sensorAssignments]);
  const current = result?.key === key ? result : null;
  const eligibleByUid = useMemo(() => new Map((current?.state === 'ready' ? current.sensors : []).map((sensor) => [sensor.uid.toLowerCase(), sensor])), [current]);
  const rowsByTable = useMemo(() => new Map((current?.state === 'ready' ? current.suggestions : []).map((row) => [row.tableId, row])), [current]);

  useEffect(() => {
    let active = true;
    setResult({ key, state: 'loading' });
    void getEligibleDraftSensors(draft.draftId).then((eligible) => {
      const proposal = proposedSensors(document, eligible.sensors);
      return suggestDraftCoverage(draft.draftId, document, proposal).then((coverage) => ({ sensors: eligible.sensors, suggestions: coverage.suggestions }));
    }).then((coverage) => { if (active) setResult({ key, state: 'ready', ...coverage }); })
      .catch((error: unknown) => {
        if (!active) return;
        setResult({ key, state: 'error', message: error instanceof LocationApiError ? error.message : 'Coverage summary could not be loaded.' });
      });
    return () => { active = false; };
  }, [draft.draftId, document, key, retry]);

  const loading = current?.state !== 'ready' && current?.state !== 'error';
  return <section className="card loc-review-coverage" aria-labelledby="location-review-coverage-heading">
    <div className="loc-sensor-heading"><div><h3 id="location-review-coverage-heading">Sensor coverage summary</h3>
      <p className="cx-muted">Combined seat coverage and the selected primary owner are shown separately. The server rechecks eligibility and full-seat ownership when you publish.</p></div>
      <button type="button" className="btn btn-secondary" data-testid="location-review-edit-coverage" onClick={onEdit}>Edit coverage</button>
    </div>
    {loading ? <p role="status" aria-busy="true">Loading current coverage summary…</p>
      : current?.state === 'error' ? <div role="alert"><p>{current.message}</p><button type="button" className="btn btn-secondary" data-testid="location-review-coverage-retry" onClick={() => setRetry((value) => value + 1)}>Retry coverage</button></div>
        : !document.tables.length ? <p>No tables to review. Unassigned locations remain unknown.</p>
          : <>
          {current.sensors.length === 0 && <p role="status" data-testid="location-review-no-eligible-sensors">No eligible sensors are available for current coverage suggestions. Saved assignments remain in this private draft.</p>}
          <div className="loc-coverage-table-wrap"><table className="loc-coverage-table">
            <thead><tr><th scope="col">Table</th><th scope="col">Combined seat coverage</th><th scope="col">Primary owner</th><th scope="col">Owner coverage</th></tr></thead>
            <tbody>{document.tables.map((table) => {
              const row = rowsByTable.get(table.id);
              const owner = document.sensorAssignments.find((assignment) => assignment.owns.includes(table.id));
              const sensor = owner ? eligibleByUid.get(owner.uid.toLowerCase()) : undefined;
              const count = ownerSeatCount(row, owner?.uid);
              const state = coverageState(row);
              const unionLabel = state === 'full' ? 'All seats covered together' : state === 'partial' ? 'Some seats uncovered'
                : state === 'none' ? 'No sensor coverage' : 'Unknown';
              const ownerLabel = !owner ? 'Unknown · no owner selected' : !sensor ? 'Needs attention · no longer eligible'
                : count === row?.seatCoverage.totalSeats ? 'Draft owner covers every seat'
                  : `Needs attention · owner covers ${count ?? 0}/${row?.seatCoverage.totalSeats ?? table.seats.length}`;
              return <tr key={table.id} data-testid={`location-review-coverage-${testToken(table.id)}`}>
                <th scope="row">{table.name}<small>{table.seats.length} seats</small></th>
                <td><span className={`loc-coverage-status is-${state}`}>{unionLabel}</span>
                  {row && <small>{row.seatCoverage.coveredSeats} / {row.seatCoverage.totalSeats} seats covered by the proposed set</small>}</td>
                <td>{owner ? sensor?.label ?? 'Previously assigned sensor · no longer eligible' : 'No sensor selected'}</td>
                <td>{ownerLabel}{owner && count !== null && <small>{count} / {row?.seatCoverage.totalSeats ?? table.seats.length} seats covered by this owner</small>}</td>
              </tr>;
            })}</tbody>
          </table></div></>}
  </section>;
}

function testToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
