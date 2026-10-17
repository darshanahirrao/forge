import { statusNames } from '../lib/format';
import { type ReactNode, useRef, useId, useEffect } from 'react';
import { X, Layers3, Terminal, Network, Command } from 'lucide-react';
import { type Harness } from '../../shared/types';

export function Status({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" aria-hidden="true" />
      {label ?? statusNames[value] ?? value}
    </span>
  );
}

export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  sheet = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    // React autofocus runs before the modal opens. Apply the chosen focus after showModal.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={sheet ? 'dialog sheet' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          const rect = ref.current!.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <header className="dialog-header">
        <div>
          {subtitle && <span className="eyebrow">{subtitle}</span>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <IconButton label="Close dialog" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}

export function Empty({
  icon = Layers3,
  title,
  children,
  action,
}: {
  icon?: typeof Layers3;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = icon;
  return (
    <div className="empty">
      <span className="empty-symbol">
        <Icon size={28} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function FormError({ error }: { error: string }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function HarnessMark({ harness }: { harness: Harness }) {
  return (
    <span className="harness-mark" aria-hidden="true">
      {harness === 'codex' ? (
        <Terminal size={16} />
      ) : harness === 'hermes' || harness === 'openclaw' ? (
        <Network size={16} />
      ) : (
        <Command size={16} />
      )}
    </span>
  );
}
