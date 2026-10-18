import { type DisplayPreferences, defaultDisplay } from '../lib/display';
import { Dialog } from './primitives';

export function KeyboardShortcuts() {
  return (
    <section className="keyboard-reference" aria-label="Keyboard shortcuts">
      <h3>Keyboard shortcuts</h3>
      <dl className="shortcut-list">
        <div>
          <dt>Commands</dt>
          <dd>
            <kbd>Ctrl / Cmd K</kbd>
            <span>or</span>
            <kbd>/</kbd>
          </dd>
        </div>
        <div>
          <dt>New work draft</dt>
          <dd>
            <kbd>N</kbd>
          </dd>
        </div>
        <div>
          <dt>Switch view</dt>
          <dd>
            <kbd>Alt 1</kbd>
            <span>through</span>
            <kbd>Alt 8</kbd>
          </dd>
        </div>
        <div>
          <dt>Collapse sidebar</dt>
          <dd>
            <kbd>Ctrl / Cmd \</kbd>
          </dd>
        </div>
        <div>
          <dt>Help</dt>
          <dd>
            <kbd>?</kbd>
          </dd>
        </div>
      </dl>
      <p className="source-note">
        View numbers follow the sidebar, from Workspace to Connections. Single-key shortcuts pause
        while typing. All workspace shortcuts pause during a dialog; Escape closes it.
      </p>
    </section>
  );
}

export function ViewOptions({
  display,
  onChange,
  onClose,
}: {
  display: DisplayPreferences;
  onChange: (patch: Partial<DisplayPreferences>) => void;
  onClose: () => void;
}) {
  return (
    <Dialog title="View options" onClose={onClose}>
      <div className="dialog-body view-options">
        <p className="source-note">
          Personalize this browser. Changes apply to local and demo views.
        </p>
        <fieldset className="density-options">
          <legend>Row density</legend>
          {(['compact', 'comfortable'] as const).map((density) => (
            <label key={density}>
              <input
                type="radio"
                name="density"
                value={density}
                checked={display.density === density}
                onChange={() => onChange({ density })}
              />
              <span>
                <strong>{density === 'compact' ? 'Compact' : 'Comfortable'}</strong>
                <small>
                  {density === 'compact' ? 'More work in view' : 'Extra room between rows'}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="display-toggle">
          <span>
            <strong>Collapse desktop sidebar</strong>
            <small>Keep navigation one click away in a narrow rail.</small>
          </span>
          <input
            type="checkbox"
            checked={display.sidebarCollapsed}
            onChange={(event) => onChange({ sidebarCollapsed: event.target.checked })}
          />
        </label>
        <label className="display-toggle">
          <span>
            <strong>Single-key shortcuts</strong>
            <small>Use / for Commands, N for a draft, and ? for Help.</small>
          </span>
          <input
            type="checkbox"
            checked={display.singleKeyShortcuts}
            onChange={(event) => onChange({ singleKeyShortcuts: event.target.checked })}
          />
        </label>
        <KeyboardShortcuts />
      </div>
      <div className="sheet-footer">
        <button className="button secondary" onClick={() => onChange(defaultDisplay)}>
          Reset view
        </button>
        <button className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
