import { useState, type ReactNode } from 'react';
import { short } from '../api';

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Address({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="addr"
      title={value}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {label && <span className="addr-label">{label}</span>}
      <code>{short(value)}</code>
      <span className="addr-hint">{copied ? 'скопировано' : 'копировать'}</span>
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const text: Record<string, string> = {
    creating: 'создаётся',
    active: 'идёт игра',
    stopped: 'завершена',
    failed: 'ошибка',
  };
  return <span className={`badge badge-${status}`}>{text[status] ?? status}</span>;
}

export function Header({ right }: { right?: ReactNode }) {
  return (
    <header className="topbar">
      <a href="/" className="brand">
        <span className="brand-mark">К</span> Криптополия
      </a>
      <div className="topbar-right">{right}</div>
    </header>
  );
}
