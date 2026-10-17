import { version } from '../shared/version';
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  type WorkspaceMode,
  type Snapshot,
  type Approval,
  type Work,
  type WorkEvent,
} from '../shared/types';
import { type View, nav } from './navigation';
import { request, download } from './api';
import {
  ChevronDown,
  ArrowRight,
  CircleHelp,
  Menu,
  ChevronRight,
  Search,
  Command,
  Sun,
  Moon,
  Bell,
  BookOpen,
  RefreshCw,
  LoaderCircle,
  X,
  UsersRound,
  Terminal,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import { IconButton, Dialog } from './components/primitives';
import { PageHeading } from './components/PageHeading';
import { Overview } from './pages/Overview';
import { WorkPage } from './pages/WorkPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { AccountsPage } from './pages/AccountsPage';
import { ResourcesPage } from './pages/ResourcesPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { ActivityPage } from './pages/ActivityPage';
import { MemoryPage } from './pages/MemoryPage';
import { WorkForm } from './components/WorkForm';
import { AccountForm } from './components/AccountForm';
import { WorkDetail } from './components/WorkDetail';
import { ApprovalDialog } from './components/ApprovalDialog';
import { LaunchDialog } from './components/LaunchDialog';
import { HandoffDialog } from './components/HandoffDialog';
import { SearchDialog } from './components/SearchDialog';

export function App() {
  const t3Result = new URLSearchParams(window.location.search).get('t3');
  const returnedFromT3 = ['connected', 'denied', 'failed'].includes(t3Result ?? '');
  const [mode, setMode] = useState<WorkspaceMode>(() =>
    !returnedFromT3 && localStorage.getItem('forge.workspace') === 'demo' ? 'demo' : 'local',
  );
  const [view, setView] = useState<View>(returnedFromT3 ? 'activity' : 'overview');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [networkError, setNetworkError] = useState('');
  const [toast, setToast] = useState(
    t3Result === 'connected'
      ? 'T3 Code connected. Read its activity when you are ready.'
      : t3Result === 'denied'
        ? 'T3 Code sign-in was cancelled. Your existing sources are unchanged.'
        : t3Result === 'failed'
          ? 'T3 Code could not connect. Check its server, start a new sign-in and choose Read only.'
          : '',
  );
  const [theme, setTheme] = useState(() => localStorage.getItem('forge.theme') ?? 'light');
  const [mobileNav, setMobileNav] = useState(false);
  const [newWork, setNewWork] = useState(false);
  const [newAccount, setNewAccount] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ work: Work; events: WorkEvent[] } | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [launch, setLaunch] = useState<Work | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [edit, setEdit] = useState<Work | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState('');
  const activeMode = useRef(mode);
  activeMode.current = mode;
  useEffect(() => {
    if (returnedFromT3)
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, []);
  const load = useCallback(async () => {
    try {
      const data = await request<Snapshot>('/snapshot', mode);
      if (activeMode.current === mode) {
        setSnapshot(data);
        setNetworkError('');
      }
    } catch (error) {
      if (activeMode.current === mode) setNetworkError((error as Error).message);
    }
  }, [mode]);
  useEffect(() => {
    setSnapshot(null);
    setSelected(null);
    setApproval(null);
    setLaunch(null);
    setHandoff(false);
    setEdit(null);
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('forge.theme', theme);
  }, [theme]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  function switchMode(next: WorkspaceMode) {
    localStorage.setItem('forge.workspace', next);
    setSnapshot(null);
    setMode(next);
    setView('overview');
    setMobileNav(false);
  }
  function navigate(next: View) {
    setView(next);
    setMobileNav(false);
  }
  async function mutate<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
    if (!snapshot || snapshot.mode !== mode)
      throw new Error('Wait for this workspace to finish loading.');
    const result = await request<T>(path, mode, snapshot.csrf, method, body);
    await load();
    return result;
  }
  async function act(key: string, operation: () => Promise<unknown>, message?: string) {
    setBusy(key);
    try {
      await operation();
      if (message) setToast(message);
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  const pending = snapshot?.approvals.filter((a) => a.status === 'pending') ?? [];
  const selectedSummary = snapshot?.work.find((w) => w.id === selected);
  const latestEvent = snapshot?.events[0]?.id;
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let current = true;
    void request<{ work: Work; events: WorkEvent[] }>(`/work/${selected}`, mode)
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch((error) => {
        if (current) {
          setToast((error as Error).message);
          setSelected(null);
        }
      });
    return () => {
      current = false;
    };
  }, [selected, selectedSummary?.revision, latestEvent, mode]);
  const selectedWork = detail?.work.id === selected ? detail.work : null;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside
        className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}
        aria-label="Workspace navigation"
      >
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          forge<span className="wordmark-period">.</span>
        </a>
        <button
          className="workspace-picker"
          onClick={() => switchMode(mode === 'local' ? 'demo' : 'local')}
          title={
            mode === 'local'
              ? 'Explore the isolated demo workspace'
              : 'Return to your local workspace'
          }
        >
          <span className="workspace-monogram">{mode === 'local' ? 'P' : 'D'}</span>
          <span>
            <strong>{mode === 'local' ? 'Personal' : 'Demo workspace'}</strong>
            <small>{mode === 'local' ? 'On this machine' : 'Fictional examples'}</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`nav-item ${view === item.id ? 'selected' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <item.icon size={18} strokeWidth={1.6} />
              <span>{item.label}</span>
              {item.id === 'approvals' && pending.length > 0 && (
                <span className="nav-count">{pending.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="eyebrow">PERSISTENT AGENCY</span>
            <p>
              Your work survives
              <br />
              your tools.
            </p>
            <button className="text-button" onClick={() => setHelp(true)}>
              How Forge works <ArrowRight size={14} />
            </button>
          </div>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} strokeWidth={1.6} />
            <span>Getting started</span>
          </button>
          <div className="local-indicator">
            <span className="status-dot" />
            <span>Local workspace</span>
            <span className="mono">v{snapshot?.version ?? version}</span>
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)}>
              <Menu className="mobile-only" size={20} />
            </IconButton>
            <span>{mode === 'demo' ? 'Demo workspace' : 'Personal workspace'}</span>
            <ChevronRight size={14} />
            <strong>{nav.find((n) => n.id === view)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="search-trigger"
              aria-label="Search workspace"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
              <span>Find anything</span>
              <kbd>
                <Command size={10} /> K
              </kbd>
            </button>
            <IconButton
              label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
            <IconButton
              label={`Open approvals${pending.length ? `, ${pending.length} pending` : ''}`}
              onClick={() => navigate('approvals')}
            >
              <Bell size={18} />
              {pending.length > 0 && <span className="notification-dot" />}
            </IconButton>
          </div>
        </header>
        {mode === 'demo' && (
          <div className="demo-banner">
            <span>
              <BookOpen size={15} />
              Fictional work, accounts, and approvals. Machine telemetry is live.
            </span>
            <button onClick={() => switchMode('local')}>
              Return to my workspace <ArrowRight size={14} />
            </button>
          </div>
        )}
        {networkError && (
          <div className="error-banner" role="alert">
            <span>{networkError}</span>
            <button onClick={() => void load()}>
              Retry connection <RefreshCw size={14} />
            </button>
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {!snapshot ? (
            <div className="loading-workspace" role="status">
              <LoaderCircle className="spin" size={24} />
              <h1>Opening your workspace</h1>
              <p>Connecting to the local Forge service.</p>
              {networkError && (
                <button className="button secondary" onClick={() => void load()}>
                  Try again
                </button>
              )}
            </div>
          ) : (
            <>
              <PageHeading
                view={view}
                mode={mode}
                onNewWork={() => setNewWork(true)}
                onNewAccount={() => setNewAccount(true)}
                onRefresh={() =>
                  void act(
                    'refresh',
                    () => mutate('/connections/refresh', 'POST'),
                    'Installation inventory refreshed.',
                  )
                }
                busy={busy}
              />
              {view === 'overview' && (
                <Overview
                  data={snapshot}
                  onWork={setSelected}
                  onApproval={setApproval}
                  onNewWork={() => setNewWork(true)}
                  onAccounts={() => navigate('accounts')}
                  onResources={() => navigate('resources')}
                  onConnections={() => navigate('connections')}
                  onActivity={() => navigate('activity')}
                  onDemo={() => switchMode('demo')}
                  onQuiet={() =>
                    void act('quiet', () =>
                      mutate('/settings', 'PATCH', { quietMode: !snapshot.settings.quietMode }),
                    )
                  }
                  busy={busy}
                />
              )}
              {view === 'work' && (
                <WorkPage data={snapshot} onWork={setSelected} onNewWork={() => setNewWork(true)} />
              )}
              {view === 'activity' && <ActivityPage data={snapshot} mutate={mutate} />}
              {view === 'memory' && (
                <MemoryPage
                  data={snapshot}
                  mutate={mutate}
                  onActivity={() => navigate('activity')}
                />
              )}
              {view === 'approvals' && <ApprovalsPage data={snapshot} onApproval={setApproval} />}
              {view === 'accounts' && (
                <AccountsPage
                  data={snapshot}
                  onNew={() => setNewAccount(true)}
                  onProbe={(account) =>
                    void act(
                      account.id,
                      () => mutate(`/accounts/${account.id}/probe`, 'POST'),
                      'Native account check finished.',
                    )
                  }
                  busy={busy}
                />
              )}
              {view === 'resources' && (
                <ResourcesPage
                  machine={snapshot.machine}
                  workers={snapshot.nativeWorkers}
                  work={snapshot.work}
                  onWork={setSelected}
                  memoryPolicy={snapshot.settings.memoryPressurePolicy}
                  onMemoryPolicy={() =>
                    void act('headroom', () =>
                      mutate('/settings', 'PATCH', {
                        memoryPressurePolicy:
                          snapshot.settings.memoryPressurePolicy === 'observe'
                            ? 'protect'
                            : 'observe',
                      }),
                    )
                  }
                  quiet={snapshot.settings.quietMode}
                  onQuiet={() =>
                    void act('quiet', () =>
                      mutate('/settings', 'PATCH', { quietMode: !snapshot.settings.quietMode }),
                    )
                  }
                  busy={busy}
                />
              )}
              {view === 'connections' && (
                <ConnectionsPage
                  data={snapshot}
                  mutate={mutate}
                  onNewAccount={() => setNewAccount(true)}
                  onDownload={() =>
                    void act(
                      'blueprint',
                      () => download('/blueprint', 'forge-blueprint.json', mode),
                      'Sanitized setup exported. Private work and account details were excluded.',
                    )
                  }
                  busy={busy}
                  act={act}
                />
              )}
              <footer className="workspace-footer">
                <span>
                  <span className="status-dot" />
                  {snapshot.access?.kind === 'tailscale'
                    ? `Private access · ${snapshot.access.identity}`
                    : 'Saved locally. Your native tools stay in charge.'}
                </span>
                <button onClick={() => setHelp(true)}>
                  Early access <ArrowRight size={12} />
                </button>
              </footer>
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <IconButton label="Dismiss message" onClick={() => setToast('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {snapshot && (newWork || edit) && (
        <WorkForm
          accounts={snapshot.accounts}
          profiles={snapshot.profiles}
          defaultProfileId={snapshot.defaultProfileId}
          initial={edit}
          mode={mode}
          mutate={mutate}
          onClose={() => {
            setNewWork(false);
            setEdit(null);
          }}
          onCreated={(work) => {
            setNewWork(false);
            setEdit(null);
            setSelected(work.id);
            setToast(edit ? 'Work context updated.' : 'Work created. Your context is saved.');
          }}
        />
      )}
      {snapshot && newAccount && (
        <AccountForm
          mode={mode}
          mutate={mutate}
          onClose={() => setNewAccount(false)}
          onSaved={() => {
            setNewAccount(false);
            setToast('Account slot saved. Native sign-in stays with the harness.');
          }}
        />
      )}
      {snapshot && selectedWork && (
        <WorkDetail
          work={selectedWork}
          events={detail!.events}
          data={snapshot}
          mode={mode}
          mutate={mutate}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setEdit(selectedWork);
            setSelected(null);
          }}
          onLaunch={() => setLaunch(selectedWork)}
          onHandoff={() => setHandoff(true)}
          onApproval={setApproval}
          onExport={() =>
            void act(
              'export',
              () =>
                download(
                  `/work/${selectedWork.id}/export`,
                  `forge-work-${selectedWork.id}.json`,
                  mode,
                ),
              'User-authored work context exported.',
            )
          }
          onStop={() =>
            void act(
              'stop',
              () => mutate(`/work/${selectedWork.id}/interrupt`, 'POST'),
              'Managed connection stopped. Review native effects before continuing.',
            )
          }
          busy={busy}
        />
      )}
      {snapshot && selectedWork && handoff && (
        <HandoffDialog
          work={selectedWork}
          accounts={snapshot.accounts}
          mutate={mutate}
          onClose={() => setHandoff(false)}
          onMoved={() => {
            setHandoff(false);
            setToast('The same work is ready on its new native binding.');
          }}
        />
      )}
      {snapshot && approval && (
        <ApprovalDialog
          approval={snapshot.approvals.find((a) => a.id === approval.id) ?? approval}
          work={snapshot.work.find((w) => w.id === approval.workId)}
          mode={mode}
          mutate={mutate}
          onClose={() => setApproval(null)}
        />
      )}
      {snapshot && launch && (
        <LaunchDialog
          work={launch}
          account={snapshot.accounts.find((a) => a.id === launch.accountId)}
          memoryPressure={snapshot.machine.memoryPressure}
          memoryProtection={snapshot.settings.memoryPressurePolicy !== 'observe'}
          onResources={() => {
            setLaunch(null);
            setSelected(null);
            setView('resources');
          }}
          mutate={mutate}
          onClose={() => setLaunch(null)}
          onLaunched={() => {
            setLaunch(null);
            setToast('Native attempt requested. Follow its activity and decisions here.');
          }}
        />
      )}
      {searchOpen && (
        <SearchDialog
          work={snapshot?.work ?? []}
          onClose={() => setSearchOpen(false)}
          onView={(next) => {
            navigate(next);
            setSearchOpen(false);
          }}
          onWork={(workId) => {
            setSelected(workId);
            setSearchOpen(false);
          }}
        />
      )}
      {help && (
        <Dialog
          title="A place for work to continue"
          subtitle="WELCOME TO FORGE"
          onClose={() => setHelp(false)}
        >
          <div className="dialog-body help-copy">
            <p>
              Forge keeps a durable work record around your native tools. Start with a goal, connect
              a native account, then follow progress and supported permission requests here.
            </p>
            <div className="help-item">
              <UsersRound size={20} />
              <div>
                <h3>Bring your accounts</h3>
                <p>
                  Account slots reference native sign-in. Check a supported slot to see the
                  effective identity and any reported limits.
                </p>
              </div>
            </div>
            <div className="help-item">
              <Terminal size={20} />
              <div>
                <h3>Use the native harness</h3>
                <p>
                  This release manages Codex turns and routes supported command and file-change
                  approvals. Other harnesses can be tracked, with managed adapters still to come.
                </p>
              </div>
            </div>
            <div className="help-item">
              <FileText size={20} />
              <div>
                <h3>Keep your context</h3>
                <p>
                  Goals, notes, checkpoints, and account attribution are saved locally. Export
                  selected work context for a new continuation. Automatic cross-harness transfer is
                  still under validation.
                </p>
              </div>
            </div>
            <div className="notice">
              <ShieldCheck size={18} />
              <p>
                Phone approval delivery, automatic account fallback, and hard resource limits are
                planned capabilities. This first release is a local workspace with native controls.
              </p>
            </div>
            <button
              className="button primary"
              onClick={() => {
                setHelp(false);
                navigate('accounts');
              }}
            >
              Connect an account <ArrowRight size={16} />
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
