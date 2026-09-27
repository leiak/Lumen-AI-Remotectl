import { useState } from 'react';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import { storage } from '../storage';

export function Settings() {
  const api = useApi();
  const [host, setHost] = useState<string>(() => storage.getHost() ?? '');
  const [apiKey, setApiKey] = useState<string>(() => storage.getApiKey() ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTestResult(null);
    storage.setHost(host.trim());
    storage.setApiKey(apiKey.trim());
    setSaved(true);
    // Hide the saved indicator after a short delay so the UI doesn't feel sticky.
    window.setTimeout(() => setSaved(false), 2000);
  }

  async function onTest() {
    setError(null);
    setTestResult(null);
    setTesting(true);
    // Persist first so the next ApiClient construction (or refresh) sees the new values.
    storage.setHost(host.trim());
    storage.setApiKey(apiKey.trim());
    try {
      const issues = await api.listIssues();
      setTestResult(`Connected — ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setTesting(false);
    }
  }

  const hasValues = host.trim().length > 0 && apiKey.trim().length > 0;

  return (
    <div className="page settings">
      <h2>Settings</h2>
      {error && <p className="form-error">Error: {error}</p>}
      {saved && <p className="settings-saved">Saved ✓</p>}
      {testResult && <p className="settings-test-result">{testResult}</p>}
      <form onSubmit={onSave} className="settings-form">
        <label className="field">
          <span className="field-label">Server URL</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="http://100.x.x.x:3100"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">API Key</span>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            onClick={onTest}
            disabled={!hasValues || testing}
            className="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="submit"
            className="primary"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}