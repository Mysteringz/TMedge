/**
 * ML Training, module 02. The design has a full training bench -- editor,
 * job runner, metrics, export -- but running submitted code is a real
 * backend (a sandboxed worker and a dataset store) that does not exist yet,
 * and a screen of invented accuracies on a production console would be
 * believed. So it says plainly that it is coming.
 */
import { navigate } from './router.ts';

export function Train() {
  const cells = Array.from({ length: 20 }, (_, i) => i < 6);
  return (
    <main className="cx-train">
      <header className="cx-train-head">
        <div>
          <div className="cx-kicker">&gt; MODULE 02</div>
          <h2 className="cx-h2">ML Training</h2>
        </div>
        <span className="cx-job">job <span className="tag tag-neutral">NOT YET AVAILABLE</span></span>
      </header>
      <section className="card elev-sm cx-soon">
        <div className="cx-soon-bar" aria-hidden="true">
          {cells.map((on, i) => <span key={i} className={on ? 'on' : ''} />)}
        </div>
        <h3 className="cx-soon-title">Coming soon<span className="cx-blink">█</span></h3>
        <p>Write a training script, send it to train on data collected from the sensors, batch-test the result and export the model.</p>
        <p className="cx-muted">Until it lands, the Human Location model is trained off the box with <code>tools/train_human_location.py</code>; see <code>docs/ALGO_DASHBOARD.md</code>.</p>
        <div><button className="btn btn-primary cx-px" onClick={() => navigate('/flow')}>OPEN ALGORITHM FLOW</button></div>
      </section>
    </main>
  );
}
